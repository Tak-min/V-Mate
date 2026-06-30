# iOS マイクバグ修正 — 2026-07-01

## 修正した問題
1. オンデバイスSTTが常にサーバーにフォールバックする
2. シロのキャラクターボイスをユーザー発話として誤認識する

---

## Bug 1: 常にサーバーSTTにフォールバック

### 真因
`AudioCapturePipeline.endCapture()` が `task = nil` していたが `task?.cancel()` を呼んでいなかった。

参照を手放しただけでは `SFSpeechRecognitionTask` は生き続け、コールバックが届き続ける。

タイムライン:
```
Turn N:  beginCapture() → onDevice=true で recognitionTask 起動
Turn N+1: resumeTurn() → receivedAnyResult = false にリセット
         → pipeline.arm() → pendingArm = true
         handleTap: gate.doReset = true → endCapture() (task=nil, cancel なし)
                                         ↑ タスクは生きてる
Turn N のタスク: エラーコールバック発火
  usedOnDevice = true (キャプチャ時の値)
  receivedAnyResult = false (resumeTurn() でリセット済み)
  → useOnDeviceRecognition.value = false  ← 誤設定!
Turn N+1: beginCapture() → usedOnDevice = false → サーバー認識
以後ずっとサーバー...
```

### 修正
`endCapture()` を2つに分割:
- `cancelCapture()` — arm() クリーンアップ時。`task?.cancel()` してからnil
- `finishCapture()` — 発話自然終了時。`endAudio()` して最終コールバックを待つ

```swift
// cancelCapture: 新ターン開始時、前ターンのタスクを明示キャンセル
private func cancelCapture() {
    task?.cancel()   // ← これが欠けていた
    task = nil
    request = nil
}

// finishCapture: 発話終了、isFinalコールバックを待つ
private func finishCapture() {
    request?.endAudio()
    request = nil
    task = nil  // キャンセルしない = コールバックは届く
}
```

handleTap() の gate.doReset パスで `cancelCapture()` を呼ぶ。

### 注意点
この問題は6/23の `04c4082` コミット (always-on engine 導入) 以降に顕在化した。
それ以前は `stop()` が `task?.cancel()` を呼んでいたが、
always-on 設計では stop は会話終了時のみ呼ばれ、ターン間のキャンセルが抜け落ちた。

---

## Bug 2: シロのキャラクターボイスを誤認識

### 真因
TTS再生終了 → マイク再開 の保護時間が短すぎた。

- `resumeListeningDelay = 0.45s`
- VAD `warmupMs = 100ms`
- 合計 ~0.55s の保護窓

AEC (.voiceChat) はエコーを除去するが室内残響は除去できない。特に:
- TTS音声が終わった直後、室内残響がマイクに回り込む
- 0.45s では残響が収まりきらない

### 修正
```swift
// CompanionViewModel.swift
resumeListeningDelay = 0.45 → 1.2   // 残響の物理減衰を十分待つ

// VoiceActivityDetector.swift
warmupMs = 100 → 400  // 残響成分をノイズフロアとして学習する時間
```

合計保護窓: ~1.6s

### トレードオフ
- ユーザー応答後の聴き始めが1.6s 遅くなる
- 対話の即応性よりも誤認識ゼロを優先

---

## コミット
`69a8626` — fix(ios/mic): cancel stale STT task on turn start + extend self-echo protection

## 残作業 (Phase 2: OSS由来の新機能)
- D: type:thinking SSE
- G: <think> ブロックフィルタ
- M: TTS前タグフィルタ
- N: 文分割器改善
- B: Lorebook
- A: RAG / D1 FTS
