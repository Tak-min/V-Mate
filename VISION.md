# VISION — iOS オンデバイス音声認識の安定化

## Goal
iOS版 v-mate で音声認識がサーバ方式（ネットワーク経由）になってしまっている問題を改善し、
iPhone独自の SFSpeechRecognizer API を活用してオンデバイス音声認識を安定動作させる。

## Problem Statement
現在の iOS 実装（`SpeechRecognizer.swift`）は `useOnDeviceRecognition = true` をデフォルトにしているが、
オンデバイスモデル未ダウンロード等で初回失敗すると **永久にサーバー方式にフォールバック** してしまう。
一度フォールバックするとセッション中は二度とオンデバイスを試さないため、ユーザーは常にサーバー遅延を体験する。

## Definition of Done (検証可能な完了条件)

1. **オンデバイス認識の優先使用**: `SFSpeechRecognizer.supportsOnDeviceRecognition` が true の端末では、
   常にオンデバイス認識を最初に試みる
2. **フォールバック後の自動リトライ**: オンデバイス認識が失敗してサーバー方式にフォールバックしても、
   次のセッション（会話モードの再起動時）では再度オンデバイスを試行する
3. **モデル未ダウンロード時の適切なハンドリング**: オンデバイスモデルが利用できない場合、
   ユーザーに明確なフィードバックを提供し、サーバー方式への切り替えを通知する
4. **ビルド成功**: `xcodebuild` でエラーなし
5. **テスト既存テストパス**: `xcodebuild test` で既存テストが全てパス

## Constraints
- 既存の VAD アーキテクチャ（`AudioCapturePipeline` + `VoiceActivityDetector`）は変更しない
- 既存の `beginSession` / `endSession` / `resumeTurn` / `pauseTurn` API は維持
- エンジンの常時稼働（AEC収束維持）は変更しない

## Key Files
- `ios/VMate/Sources/Audio/SpeechRecognizer.swift` — メインの STT ロジック（AudioCapturePipeline L71-267 + SpeechRecognizer L276-470 を含む）
- `ios/VMate/Sources/Audio/VoiceActivityDetector.swift` — VAD 実装
- `ios/VMate/Sources/ViewModels/CompanionViewModel.swift` — UI/ビューモデル統合
- `ios/VMate/Tests/VoiceActivityDetectorTests.swift` — テスト

## Recon Findings (Phase 1)

### Root Cause: フォールバックが永続的
- `useOnDeviceRecognition` は `AudioCapturePipeline` のプロパティ（L86）。デフォルト `true`
- `handleRecognitionResult()` (L445-446) で初回失敗時に `pipeline?.useOnDeviceRecognition.value = false` に設定
- 以降 `beginCapture()` (L204) で `usedOnDevice = false` → サーバー認識に固定
- **`reset()` (L180-192) は `useOnDeviceRecognition` をリセットしない** → セッション終了→再開してもフォールバックが残る
- `beginSession()` (L340-393) で新しい pipeline を生成するが、新 pipeline の `useOnDeviceRecognition` は `true` で初期化される
- **ただし**: `endSession()` (L397-406) で `pipeline?.reset()` を呼ぶが、`reset()` は `useOnDeviceRecognition` をリセットしない

### 問題の正体
`endSession()` → `beginSession()` のサイクルで、旧 pipeline の `useOnDeviceRecognition = false` 状態が
新 pipeline に持ち越される可能性がある（pipeline の再利用タイミングによる）。
また、初回のオンデバイス失敗後、そのセッション中は二度とオンデバイスを試さない。

### 修正方針
1. `SpeechRecognizer.beginSession()` で新 pipeline 生成後に `useOnDeviceRecognition.value = true` を明示設定
2. `AudioCapturePipeline.reset()` で `useOnDeviceRecognition.value = true` をリセット
3. これにより、セッション開始ごとにオンデバイスを再試行する
