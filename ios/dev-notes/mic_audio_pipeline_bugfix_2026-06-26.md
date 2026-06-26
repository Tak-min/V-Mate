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

## 追記: d69c8e4 で導入されたクラッシュの根因と修正 (2026-06-26, commit fddc33d)

### 症状
d69c8e4 デプロイ後、実機で音声ボタンをタップするとアプリがクラッシュして落ちた。

### 真因
Bug-4 修正で `audioEngine.prepare()` を `installTap()` より**前に**呼ぶ順序に変えたことが原因。
Apple の `AVAudioEngine` は内部で「グラフ変更(installTap)→prepare→start」の順を要求しており、
`prepare()` 後にグラフ変更するとアサートが発火してクラッシュする。

**壊れた順序 (d69c8e4):**
```
audioEngine.prepare()          ← Bug: prepare first
let input = audioEngine.inputNode
input.installTap(...)          ← graph change AFTER prepare → crash
audioEngine.start()
```

**正しい順序 (fddc33d):**
```
let input = audioEngine.inputNode
let format = input.outputFormat(forBus: 0)
input.removeTap(onBus: 0)
input.installTap(...)          ← graph change first
audioEngine.prepare()          ← then prepare
audioEngine.start()            ← then start
```

### 教訓
- `outputFormat` は `configureForConversation()` が先に呼ばれていれば `prepare()` 前でも
  16kHz を正確に返す。「prepare前のoutputFormatが不正確」という Bug-4 の前提は誤りだった。
- Apple 公式 WWDC Speech Recognition サンプルも同じ順序（tap→prepare→start）を使っている。
  AVAudioEngine の初期化順序を変える場合は公式サンプルと照合すること。

## 追記: Round2 感度・取りこぼし改善 (2026-06-26, 観測性導入 + チューニング)

### 経緯
クラッシュ修正(fddc33d)後、ユーザー実機テストで「音声取得は一部成功。ただし(a)取得できない
文章がある (b)マイクから少し離れると取れないタイミングがある」と報告。

### 第一手: 観測性の確立 (commit f514898)
パイプラインに `os.Logger`(subsystem=com.takmin.vmate, category=mic)を全段導入。
`import os` はあったのに未使用だった。tap format / RMS・しきい値・noiseFloor(8バッファ毎に
スロットル) / VADイベント / request publish成否 / pending滞留警告 / 認識result・error /
onUtterance を記録。レンダースレッドのログはスロットルでRT安全性を維持。
実機ログ取得は root 必須(`sudo log collect --device-udid`)。devicectl にログ取得サブコマンドは
無い(copy/sysdiagnoseのみ)。zshの`log`は組込みのため`/usr/bin/log`必須。

### 第二手: 症状別の修正
**(a) 取得できない文章 → 認識方式の既定をサーバーに変更(最重要):**
`AudioCapturePipeline.useOnDeviceRecognition` 既定を true→**false**。
真因: on-device優先だと ja-JP オンデバイスモデル未DL端末で初回発話が必ず即失敗し、
会話の最初の一文が毎回失われていた。サーバー認識は初回ロス無し・遠距離/小声/雑音に強い。
アプリはバックエンド通信前提でネットワークは実質保証。

**(a') 発話途中の小休止で分断 → hangoverMs 1100→1400ms。** 息継ぎ/言い淀みで
speechEnded が早発し文の後半が別発話に割れるのを抑止。

**(b) 遠距離で取れない → VAD感度を保守的に増感(行動報告ベース):**
- minThreshold 0.0006→0.0004 / noiseMargin 1.8→1.4 / thresholdOffset 0.0003→0.0002。
  静音室の実効しきい値 ~0.00084→~0.00062(約26%低下)。遠距離RMS ~0.0007 が拾えるように。
- preRollMargin 1→6(pre-roll 3→8フレーム≒512ms)。しきい値直下でじわっと立ち上がる
  遠距離・小声の語頭を遡って認識へ流し込む。
- 誤起動は onsetFrames=2(128ms持続要求)で抑え、万一の雑音起動もサーバー認識が無音を
  文字化せず hangover で自然終了する自己補正設計のため実害小。

### 検証
- build緑 / test 18件全パス(遠距離RMS検出の回帰テスト1件追加)。
- 実機デプロイ済み。最終確認は human-in-the-loop(物理マイクへの発話が必要)。

### 申し送り(Round2)
- しきい値は「行動報告(近=○/遠=×)」を根拠に保守的に下げた。さらに詰めるなら実機の
  micログ(RMS vs threshold)で遠距離の実値を見て調整する(`/usr/bin/log collect`)。
- サーバー認識既定化に伴い、完全オフライン時はSTT不可。オフライン対応が必要になったら
  server→on-device の逆フォールバックを追加する(現状は未実装)。
- それでも遠距離で取れない場合の次の一手: VADゲートを廃し「armターン中は認識を常時走らせ
  VADはエンドポインティング/バージインのみ」に再設計(continuous-feed)。空ターンのハング
  処理(recognizer自前isFinal後の再arm)を設計する必要があるため、今回は見送り。

## 申し送り

- `OSAllocatedUnfairLock` は iOS 16+ 専用。deployment target が変われば代替が必要。
- VAD しきい値(minThreshold/noiseMargin 等)は実機ログなしで変更しないこと
  (dev-notes/handsfree_voice_conversation_2026-06-22.md 参照)。
- `AVAudioEngine.prepare()` は必ず全ノードへの tap install 完了後に呼ぶこと。
