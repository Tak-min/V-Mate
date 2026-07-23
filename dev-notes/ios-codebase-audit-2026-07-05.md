# v-mate iOS コードベース監査と修正ログ — 2026-07-05

## 概要

`/Users/taku8/Desktop/v-mate/ios/` を対象に、リリース品質に向けたコードベースと UX の監査を行い、
発見した問題点をすべて修正した。

---

## 発見した問題と修正

### [BUG B1] ユーザー向け画面に開発者メッセージが露出

**Symptom:** AIが返答を生成できない(SSEストリームが途切れる)とき、以下の文字列がチャット画面に表示された。
```
接続が切れちゃったみたい…バックエンドは起動してる?
```

**Cause:** CompanionViewModel の SSE エラーハンドラ(CompanionViewModel.swift:148)と
APIClient の catch ブロック(APIClient.swift:183)に、開発中に書かれたデバッグ文字列がそのまま残っていた。

**Fix:** 両ファイルのエラーメッセージをユーザー向けに変更。
```
接続が切れちゃったみたい…少し待ってからもう一度試してみてね
```

---

### [BUG/UX B2] VRM WebView 読み込み中に画面が透明になる

**Symptom:** アプリ起動直後、`VRMAvatarView`(WKWebView) が 3D コンテンツを描画するまでの数秒間、
アバター領域が完全に透明になる。ユーザーには「壊れているのか?」と映る。

**Cause:** `WKWebView` の `isOpaque = false` + 透明背景設定のため、Three.js VRM ロードが完了するまで
WKWebView が透明のままになる。元の `avatar` computed property は VRM 失敗時のみ v1 フォールバックを表示し、
ロード中のプレースホルダーが存在しなかった。

**Fix:** `RootView.avatar` を ZStack 構造に変更。v1 `AvatarView` を VRM の後ろにレイヤーとして配置し、
VRM が描画されるまでのプレースホルダーとして機能させる。VRM ロード完了後は 3D コンテンツが手前に重なり
v1 は自動的に隠れる。

---

### [CODE C1–C3] `onChange(of:)` iOS 17 非推奨 API が 3 箇所

**Symptom:** Xcode が `onChange(of:perform:)` に対して deprecation 警告を出す。

**Cause:** iOS 17 で `onChange(of:)` のクロージャシグネチャが変更された。
旧形式(値のみ受け取る1引数クロージャ)が deprecated。

**Fix:** `PersonaColors.swift` に ViewModifier ベースの互換ラッパー `onChangeOf` を追加。
```swift
// ViewModifier を使う理由: @ViewBuilder 内の if #available で両バージョンを型安全に切り替えられる。
// 単純な func { if #available ... } は opaque type 推論が壊れるため ViewModifier 経由が確実。
```
修正箇所:
- `RootView.swift:61` — ステージ変化の観測
- `ConversationOverlay.swift:188` — 入力中状態の通知
- `ConversationOverlay.swift:550` — 新メッセージ到着時のスクロール

---

### [CODE C4] `DispatchQueue.main.asyncAfter` でステージアップアニメーションを制御

**Symptom:** ステージアップバナーの消去に GCD (Dispatch) を使用、Swift Concurrency と混在。

**Cause:** `RootView.swift:68` が `DispatchQueue.main.asyncAfter(deadline: .now() + STAGE_UP_DURATION)` を使用。

**Fix:** `Task { @MainActor in try? await Task.sleep(for: .seconds(STAGE_UP_DURATION)) }` に変更。
`Task.sleep(for:)` は Swift 5.7 / iOS 16 から利用可能なため deployment target (iOS 16) と一致する。

---

### [UX U1] ハプティクスフィードバックなし

**Symptom:** メッセージ送信とステージアップ(重要なマイルストーン)に触覚フィードバックがない。

**Fix:**
- メッセージ送信 (`ConversationOverlay.send()`): `UIImpactFeedbackGenerator(style: .light)`
- ステージアップ (`RootView.onChangeOf`): `UIImpactFeedbackGenerator(style: .medium)`

`UIImpactFeedbackGenerator` は SwiftUI iOS ファイルで `import UIKit` なしに使用可能
(iOS SDK が UIKit を SwiftUI ターゲットに暗黙提供するため)。

---

### [UX U2] 音声エラーバナーに閉じるボタンがない

**Symptom:** 音声エラーが表示されても、ユーザーはマイクを再タップするまでバナーを消せない。
特にエラーが無関係な原因(システムの一時的な問題等)の場合、邪魔になり続ける。

**Fix:** `RootView.header` のエラーバナーに `xmark.circle.fill` ボタンを追加。
タップで `viewModel.voiceError = nil` (withAnimation 付き)。
`voiceError` は `@Published var` (private(set) なし) なので View から直接 nil 代入可能。

---

### [UX U3] `ConversationOverlay.send()` の空送信ガード

**Symptom:** キーボードの Return キーで空テキストを送信しようとすると、
`viewModel.send()` が内部でガードするが、`draft = ""` が先に実行されていた。

**Fix:** `send()` に先行ガードを追加。
```swift
let text = draft.trimmingCharacters(in: .whitespaces)
guard !text.isEmpty, !viewModel.busy else { return }
```
viewModel 側のトリムと重複するが、draft を不必要にクリアしない点で正しい動作。

---

## 修正しなかった問題と理由

| 項目 | 理由 |
|------|------|
| `CompanionViewModel.swift:248` の `DispatchQueue.main.asyncAfter` | AVFoundation コールバック文脈で使用。Swift Actor 境界をまたぐため GCD の方が適切。変更すると AEC 収束タイミングが変わるリスクがある。 |
| `ConversationOverlay.swift:543` の `DispatchQueue.main.asyncAfter(0.15s)` | キーボード表示後のスクロール遅延。SwiftUI キーボード animation と同期するための意図的な遅延。 |
| `ChatMessage.id: UUID = UUID()` | JSON デコード時に ID が再生成されるため再表示時に SwiftUI が全メッセージを "新規" と見なす可能性あり。サーバー側で ID を発行する必要があり、本修正スコープ外。 |
| SPKI Certificate Pinning | `APIClient.swift` のコメントに記載通り、Cloudflare の証明書ローテーション問題があり設計が必要。別 dev-note で対処。 |

---

## 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `ios/VMate/Sources/Views/PersonaColors.swift` | `onChangeOf` ViewModifier 互換ラッパー追加 |
| `ios/VMate/Sources/ViewModels/CompanionViewModel.swift` | 開発者エラー文字列をユーザー向けに修正 |
| `ios/VMate/Sources/Networking/APIClient.swift` | 同上 |
| `ios/VMate/Sources/Views/RootView.swift` | onChangeOf・Task.sleep・ハプティクス・VRMプレースホルダー・エラー閉じるボタン |
| `ios/VMate/Sources/Views/ConversationOverlay.swift` | onChangeOf・send()ガード・ハプティクス |
