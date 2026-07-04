# Audio Pipeline 改善まとめ 2026-07-04

## 実施内容

このセッションで実施した音声パイプライン全体の改善。

---

## 1. VAD (VoiceActivityDetector) 大幅改善 [commit 91b094d]

### 問題
- スカラーループでの RMS 計算(レンダースレッドで動く)が CPU 非効率
- ノイズフロアがゼロに収束する静寂環境でしきい値も0になり誤検出
- 発話終了ハングオーバーが1.4s固定でレスポンスが遅かった
- `resumeListeningDelay` 1.2s が TTS 末尾の残響より過剰

### 修正内容
- `vDSP_rmsqv` (Accelerate) で SIMD 化 (`VoiceActivityDetector.rms(from:)`)
- `noiseFloorMinimum: 0.00015` でフロア下限クランプ
- `shortHangoverMs: 700 / shortHangoverRatio: 0.18`: ピークRMSの18%未満に落ちたら700msで早期確定
- `peakCaptureRms` で発話中のピーク追跡、`reset()`/終了時にクリア
- `resumeListeningDelay: 1.2 → 0.8`(total dead zone 1.6s→1.2s)
- テスト 24/24 全通過

### Gotcha
**症状:** `defaultConfigDetectsFarFieldSpeech` テストのタイミングがずれた  
**原因:** `nowMs - started < warmupMs` は strict less-than なので `nowMs=400` はウォームアップ終了直後。`nowMs=400` でフレーム1(silence)、`nowMs=464` でフレーム2(speechStarted)になる  
**対処:** テストを `nowMs=528` 期待から `nowMs=464` に修正

**症状:** `shortHangoverFiresWhenEnergyDropsSignificantly` が落ちた  
**原因:** `minThreshold: 0.001`, silence rms=0.002 → silence が threshold を超えていてハングオーバーが発火しない  
**対処:** `minThreshold: 0.005`, silence rms=0.0002 に変更

---

## 2. SpeechQueue.rmsLevel vDSP 化 [commit 0a1f106]

### 問題
- `rmsLevel(from:)` もスカラーループ → AVAudioEngine タップコールバック(レンダースレッド)で動く
- `VoiceActivityDetector.rms()` は既に vDSP 化済みだったが SpeechQueue は残っていた

### 修正内容
```swift
// 変更前
var sum: Float = 0
for i in 0..<count { sum += data[i] * data[i] }
let rms = sqrt(sum / Float(count))

// 変更後
var rms: Float = 0
vDSP_rmsqv(data, 1, &rms, vDSP_Length(buffer.frameLength))
```
- `import Accelerate` を追加
- `buffer.floatChannelData?.pointee` で `UnsafeMutablePointer<Float>` を直接渡す

---

## 3. 着信/Siri 割り込み・イヤホン挿抜ハンドラー [commit 0a1f106]

### 問題
- 着信中に voice mode がオンのままになる
- イヤホン挿抜で AVAudioEngine の設定が変わると **エンジンがサイレント停止**してマイクが死ぬ
- 両方のハンドラーが完全に欠如していた

### 実装
`CompanionViewModel.setupAudioNotifications()` で3つの通知を観測:

1. **`AVAudioSession.interruptionNotification`**  
   - `.began`: `stopListening()` + `voiceError` メッセージ。自動再開なし(通話後の状態不定を避けるため)  
   - `.ended`: 何もしない(ユーザー主導で再開)

2. **`AVAudioEngineConfigurationChange`**  
   - `stopListening()` → 300ms 待機 → `configureForConversation()` → `beginVoiceSession()`  
   - 300ms の理由: AVAudioEngine が新ルートに安定するまでの実験的な時間。短すぎると engine.start() が失敗する  
   - ガード: `voiceMode == .off` チェックで手動停止後の不意な再起動を防止

3. **`didEnterBackgroundNotification` + `willEnterForegroundNotification`** [commit 97b918b]  
   - background: `stopListening()` → `deactivate()` でセッション完全解放
   - foreground: `configureForPlaybackOnly()` で TTS だけ復活(マイクは未起動)

### Gotcha
**症状:** `willEnterForegroundNotification` コールバックで `variable 'self' was written to, but never read` 警告  
**原因:** `[weak self]` キャプチャを宣言したが中で `self` を使っていない  
**対処:** コールバック本体で `self` を使わない場合はキャプチャを外す(`{ _ in Task { @MainActor in ... } }`)

**症状:** SourceKit が `No such module 'UIKit'` を報告するが `xcodebuild` は SUCCEEDED  
**原因:** SourceKit のインデックスキャッシュが古い。実ビルドには影響なし  
**対処:** 無視してよい。クリーンビルド後に解消することが多い

---

## 4. バックグラウンド処理方針

`Info.plist` に `UIBackgroundModes: audio` を**追加しない**決定。理由:
- 音声コンパニオンアプリとして常時マイク保持は App Store レビューで要説明
- 会話はフォアグラウンド前提で設計されており不要
- `didEnterBackground` で確実に解放することで強制終了リスクを排除

---

## 現在の状態

| コンポーネント | 状態 |
|---|---|
| VAD | ✅ 完成 (24テスト通過) |
| SpeechQueue vDSP | ✅ 完成 |
| 割り込みハンドラー | ✅ 完成 |
| バックグラウンド解放 | ✅ 完成 |
| 実機デプロイ | ⏳ WiFi 同一ネットワーク必要 |

最後のコミット: `97b918b` (master, GitHub sync済み)
