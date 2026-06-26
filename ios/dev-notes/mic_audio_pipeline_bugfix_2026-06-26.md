# マイク音声パイプライン バグ修正 — 2026-06-26

## 背景
実機(iPhone 15 Pro)への初デプロイ後、「マイクを使用して音声を取得することがうまくできていない」
という報告を受け、コードの批判的分析→バグ特定→修正ループを実施。

## 特定されたバグと修正

### Bug-1: render スレッドでの `Date()` (HIGH → 修正済み)

**症状:** オーディオグリッチ、プライオリティインバージョン。
**真因:** `AudioCapturePipeline.handleTap()` (audio render スレッド) から `Date()` を呼んでいた。
`Date()` は Objective-C の `NSDate` alloc を伴い、リアルタイムスレッドに禁忌。
**修正:** `Date().timeIntervalSince1970 * 1000` → `CACurrentMediaTime() * 1000`
**ファイル:** `SpeechRecognizer.swift`

---

### Bug-2: render スレッドでの重い ObjC alloc (HIGH → 修正済み)

**症状:** render スレッドでの `SFSpeechAudioBufferRecognitionRequest()` + `recognitionTask(with:)`
という重い ObjC 呼び出しが毎発話ターンごとに実行され、プライオリティインバージョン/グリッチの原因。
**真因:** 旧設計は「tapスレッドから同期的に beginCapture() を呼ぶことで race を防ぐ」としていたが、
render スレッドでの alloc という本質的なリスクがあった。
**修正:** Option B（非同期生成 + pendingキュー）を採用。
- `setupQueue.async(.userInitiated)` で重い生成を render 外に退避。
- 生成完了までのバッファは `pendingCapture` に貯め、`armedRequest` publish 後に一括 flush。
- `generation` トークンで「短発話で生成完了前に endCapture した場合」の競合を防ぐ。
- `onSpeechOnset()` は onset の瞬間に同期発火(バージインの応答性は不変)。
**ファイル:** `SpeechRecognizer.swift` (`AudioCapturePipeline` クラス全体を再設計)

---

### Bug-3: 旧ターンの task コールバック汚染 (MEDIUM → 修正済み)

**症状:** `endCapture()` で `task = nil` にしても非同期コールバックが届き続け、
新ターンの `finalText` に旧ターンの認識結果が書き込まれる可能性があった。
**真因:** `task?.cancel()` なしに `task = nil` していた。
**修正:** `endCapture()` に `task?.cancel()` を追加 → Bug-2修正で `liveTask.withLock` 方式に変更後も同様の方針を踏襲。
**ファイル:** `SpeechRecognizer.swift`

---

### Bug-4: `inputNode.outputFormat` を `prepare()` 前に取得 (MEDIUM → 修正済み)

**症状:** `.voiceChat` モード(16kHz)のフォーマットが正確に返らない場合があり、
tap が旧キャッシュ(44.1kHz等)のフォーマットで動くと `onsetFrames` の実時間が
VAD 設計前提(64ms/frame@16kHz)と合わなくなる。
**真因:** `beginSession()` で `audioEngine.prepare()` より前に `outputFormat(forBus:0)` を呼んでいた。
**修正:** `audioEngine.prepare()` → `outputFormat` 取得 → `installTap` → `audioEngine.start()` の順に変更。
**ファイル:** `SpeechRecognizer.swift`

---

### Bug-5: `.allowBluetoothHFP` が 8kHz 制限を引き起こす (LOW → 修正済み)

**症状:** HFP(Hands-Free Profile) Bluetooth デバイス接続時にサンプルレートが 8kHz に制限され
STT 精度が大幅低下する。
**真因:** `AudioSessionManager.configureForConversation()` で `.allowBluetoothHFP` を指定していた。
HFP は SCO プロファイルを使うため 8kHz 制限がある。
**修正:** `.allowBluetoothHFP` を削除し `.allowBluetoothA2DP` に変更。
AirPods 等 A2DP 対応デバイスには影響なし。
**ファイル:** `AudioSessionManager.swift`

---

## 検証

- xcodebuild build (simulator): 警告0・エラー0
- xcodebuild test (simulator): 17件全パス（Bug-1〜5修正後も変化なし）
- 実機確認: 次回起動時に音声会話の改善を実感できるはず

## 未着手(次回以降)

- `pendingCapture` の上限ガード: setupQueueの遅延が異常に長い場合（例:2秒以上）の
  graceful degradation（先頭破棄）。通常は数ms以内で解決するため現状は省略。
- AVAudioSession Interruption/RouteChange ハンドリング: 電話着信等でエンジンが止まった後の自動復帰。

## 申し送り

- `OSAllocatedUnfairLock` は iOS 16+ 専用。deployment target が変われば代替が必要。
- `setupQueue` は `.userInitiated` を維持する事。`.userInteractive` にすると audio render と
  CPU を奪い合う。
- VAD しきい値(minThreshold/noiseMargin 等)は実機ログなしで変更しないこと
  (dev-notes/handsfree_voice_conversation_2026-06-22.md 参照)。
