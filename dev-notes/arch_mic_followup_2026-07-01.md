# iOS マイク アーキテクチャ課題 — 次セッション対応メモ (2026-07-01)

このファイルは今セッションで修正できなかった構造的問題のリスト。
次のAIエージェントが「なぜ変更が必要か」をゼロから再調査しなくて済むよう記録する。

---

## 1. AEC が実質効いていない [HIGH]

### 症状
`.voiceChat` AVAudioSession を使っているのに TTS の音声がマイクに回り込む。
warmup/resume 遅延で症状を抑えているだけで根本解決できていない。

### 真因
TTS 再生は `SpeechQueue.swift` 内の `AVAudioPlayer(data:)` が担っている。
これは STT 用の `AVAudioEngine` とは**独立した経路**で再生される。

iOS の `.voiceChat` モード (Voice-Processing I/O = VPIO) のエコーキャンセラは、
「同じ VPIO 出力スコープにレンダーされた信号」を参照音として使う。
独立した `AVAudioPlayer` の出力は VPIO のエコー参照に供給されない可能性が高く、
現状では AEC がほとんど機能していないと考えられる。

### 必要な変更
TTS 再生を `AVAudioEngine` 内の `AVAudioPlayerNode` 経由に移行する。

```
現状:
  SpeechQueue → AVAudioPlayer (独立) → スピーカー
  AVAudioEngine (VPIO) → マイク tap → VAD → STT

目標:
  SpeechQueue → AVAudioPlayerNode → AVAudioEngine (VPIO) → スピーカー
                                                          → マイク tap → VAD → STT
  ↑ 同じエンジン経由なので VPIO が参照信号を取得できる
```

変更対象:
- `ios/VMate/Sources/Audio/SpeechQueue.swift` — `AVAudioPlayer` → `AVAudioPlayerNode`
- `ios/VMate/Sources/Audio/SpeechRecognizer.swift` — `AVAudioEngine` に playerNode をアタッチ
- `ios/VMate/Sources/ViewModels/CompanionViewModel.swift` — SpeechQueue/SpeechRecognizer の接続

検証方法: 変更後、TTS 再生中のマイク RMS を `micLog` で計測し、
AEC 有効時は大幅減衰(理想 -20dB 以上)していることを確認する。

---

## 2. レンダースレッドからの Speech API 呼び出し [HIGH]

### 症状
現状では目立ったドロップアウトはないが、リアルタイム安全性の保証がなく、
将来的にオーディオドロップアウトや優先度逆転を引き起こす可能性がある。

### 真因
`AudioCapturePipeline.handleTap()` はオーディオレンダースレッドから呼ばれる。
その中で以下の非 RT-safe な処理を直接実行している:

```swift
// handleTap() → render thread から呼ばれる
beginCapture()       // SFSpeechAudioBufferRecognitionRequest() + recognitionTask(with:)
cancelCapture()      // task?.cancel() — SFSpeechRecognitionTask のスレッド安全性未保証
finishCapture()      // request?.endAudio()
```

`SFSpeechRecognizer.recognitionTask(with:)` は XPC セッション起動を含む可能性があり、
リアルタイムスレッドでの呼び出しは Apple の推奨に反する。

### 必要な変更
`beginCapture`/`cancelCapture`/`finishCapture` の Speech API 操作を render スレッドから外す。

設計案:
1. render スレッドは「バッファを lock-free リングに積む」と「VAD 判定」だけを行う
2. Speech API 操作は dedicated serial DispatchQueue か MainActor で実行
3. バッファ落ちを防ぐため、「onset 検出 → Speech タスク起動」間の時間は
   世代カウンタ(世代ID)で担保し、古い世代のコールバックは破棄する

```swift
// 概念コード
// render thread:
case .speechStarted:
    currentGen += 1
    pendingBuffers.append(contentsOf: preRoll.drainAndClear())
    pendingBuffers.append(buffer)
    let gen = currentGen
    let drained = pendingBuffers
    pendingBuffers = []
    DispatchQueue.main.async {
        self.startRecognition(gen: gen, preBuffers: drained)
    }

// MainActor:
func startRecognition(gen: Int, preBuffers: [AVAudioPCMBuffer]) {
    guard gen == currentGen else { return }  // stale onset は無視
    let req = SFSpeechAudioBufferRecognitionRequest()
    ...
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
        self?.handleResult(gen: gen, result: result, error: error)
    }
    for buf in preBuffers { req.append(buf) }
}
```

変更対象: `ios/VMate/Sources/Audio/SpeechRecognizer.swift`(AudioCapturePipeline クラス全体)

---

## 3. `endSession()` と in-flight `handleTap()` のデータ競合 [HIGH]

### 症状
まれにクラッシュまたは認識の不整合が起きる可能性がある。
Swift 6 strict concurrency では本来警告対象。

### 真因
`SpeechRecognizer.endSession()` は MainActor から `pipeline?.reset()` を呼ぶが、
`removeTap(onBus:)` / `audioEngine.stop()` はタップの最後の呼び出しが完了するまで
ブロックしない(ドキュメントに明示がない)。

`reset()` が `request/task/vad/preRoll` を触る同タイミングで、
最後の `handleTap()` がレンダースレッドから同じ変数にアクセスする可能性がある。

### 必要な変更
`endSession()` を以下の順序に変更し、tap が確実に停止してから reset する:

```swift
func endSession() {
    running = false
    audioEngine.inputNode.removeTap(onBus: 0)
    audioEngine.stop()           // ← stop() は同期完了するはず
    pipeline?.reset()            // tap 停止後に呼ぶ
    pipeline = nil
    finalText = ""
}
```

または `AudioCapturePipeline` の変数を actor で保護する抜本対応。

変更対象: `ios/VMate/Sources/Audio/SpeechRecognizer.swift`

---

## 4. バージイン(割り込み)が到達不能なデッドコード [MEDIUM]

### 症状
ユーザーが AI の発話中に話し始めても、AI が止まらず会話を聴けない(割り込み不可)。

### 真因
`handleSpeechOnset()` のガードは `voiceMode == .thinking || .speaking` だが、
これらのモードでは `pauseTurn()`(= `disarm()`)が呼ばれており、
`handleTap()` が `gate.process == false` で早期 return するため VAD が動かない。
結果として `onSpeechOnset` コールバック自体が発火せず、`handleSpeechOnset()` に到達しない。

```swift
// CompanionViewModel.handleSpeechOnset() は実質デッドコード
private func handleSpeechOnset() {
    guard voiceMode == .thinking || voiceMode == .speaking else { return }
    // ↑ ここに来るためには speechStarted が発火している必要があるが、
    //   .thinking/.speaking 中は disarm されているので発火しない
```

### 必要な変更
バージインを実現するには:
1. `.thinking`/`.speaking` 中も VAD だけは動かす(enabled は true のまま)
2. ただし `beginCapture()` は起動しない(request/task は生成しない)
3. VAD が `speechStarted` を検出したら `handleSpeechOnset()` を発火し、
   TTS を止めて `resumeTurn()` を呼ぶ

これには `AudioCapturePipeline` に「VAD だけ動かす監視モード」を追加する必要がある。
現在の `enabled` フラグを `enum PipelineMode { case off, monitoring, capturing }` に拡張する案が有力。

変更対象:
- `ios/VMate/Sources/Audio/SpeechRecognizer.swift` (AudioCapturePipeline)
- `ios/VMate/Sources/ViewModels/CompanionViewModel.swift`

---

## 優先度まとめ

| 課題 | 深刻度 | 推奨実施タイミング |
|------|--------|-----------------|
| 1. AEC (AVAudioPlayerNode 移行) | HIGH | 次セッション最優先 |
| 2. RT安全性 (Speech API off render thread) | HIGH | AEC 移行と同時 |
| 3. endSession データ競合 | HIGH | 比較的小さい変更、早めに対応 |
| 4. バージイン機能の復活 | MEDIUM | UX 改善フェーズ |

---

## 関連コミット / ファイル

- `69a8626` — cancelCapture/finishCapture 分割 (Phase 1)
- `ea72ac6` — onDeviceEverSucceeded + isSpeaking ループ修正 (Phase 2)
- `dev-notes/mic_stale_task_and_self_echo_2026-07-01.md` — Phase 1/2 の真因記録
- `ios/VMate/Sources/Audio/SpeechQueue.swift` — TTS 再生の実装(AEC 修正の変更対象)
- `ios/VMate/Sources/Audio/SpeechRecognizer.swift` — AudioCapturePipeline(RT安全性/データ競合の変更対象)
