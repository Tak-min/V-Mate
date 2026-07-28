# フォトモードのiOSネイティブ共有ブリッジ実装 — 2026-07-28

## 背景・動機

`dev-notes/avatar_ux_reaction_phase1_2026-07-23.md` のPhase 1(タップ反応・ステージアップ演出・
お帰り演出・フォトモード)で、フォトモードはWeb限定と明記されていた:「iOSのツールバーはネイティブ
SwiftUIなので、App.tsxの📷ボタンはiOSに出ない…Swift→JS一方向ブリッジしか無い現状ではネイティブの
共有ボタンから呼び出す経路(WKScriptMessageHandler新設)は未実装・Phase 2以降」。

本セッションの依頼(「開発が途中で止まっている部分を特定して改善して」)を受けて調査した結果、
このギャップが最も具体的で境界の明確な「実装済みの一部だけ繋がっていない」箇所だったため着手した。
Web側(`capturePhoto()`・`entry.ts`の`window.vmate.capturePhoto()`forward-compat)は既に完成して
いたため、今回の変更はiOS側のみ。

## 実装した内容

1. **`frontend/src/ios-avatar/entry.ts`は無変更**(既存のforward-compatをそのまま利用)。
2. **`ios/VMate/Sources/Avatar/VRMAvatarView.swift`**:
   - `PhotoCapture.decodeDataURL(_:)` — `data:image/png;base64,...`をDataにデコードする純粋関数
     (単体テスト可能、`VMateTests/PhotoCaptureTests.swift`に3ケース)。
   - `Coordinator`に`onPhotoCaptured: (Data?) -> Void`クロージャと`handlePhotoCaptureRequest(_:)`
     を追加。撮影リクエスト(UUID)が前回観測値と変わった時だけ1回、`webView.evaluateJavaScript(...)`
     で`window.vmate.capturePhoto()`を呼ぶ。
3. **`ios/VMate/Sources/ViewModels/CompanionViewModel.swift`**:
   - `pendingPhotoCaptureID: UUID?`(トリガー)と`capturedPhotoData: Data?`(結果)を追加。
   - `requestPhotoCapture()`でトリガーに新UUIDを積むだけ。
4. **`ios/VMate/Sources/Views/RootView.swift`**:
   - `controlCluster`に📷ボタン(`HeaderControlButton`、既存の音声/日記/アカウントボタンと同じ形)を追加。
   - `capturedPhotoData`のnil⇔非nilを`.sheet`のisPresentedとして扱い、`PhotoShareSheet`
     (`UIActivityViewController`の薄いラッパー、`TransparentBackground`と同じ場所に配置)で
     ネイティブ共有シートを開く。

## アーキテクチャ上の決定

- **新しい双方向ブリッジ(WKScriptMessageHandler新設)は結局不要だった。** Phase 1のdev-noteは
  「Swift→JS一方向ブリッジしか無いので新設が要る」と書いていたが、実際には
  `WKWebView.evaluateJavaScript(_:completionHandler:)`はiOS 14+で**評価結果がPromiseなら
  自動的に解決を待ってから結果を渡す**(Apple公式挙動)。`capturePhoto()`は既に`Promise<string|null>`
  を返す設計だったため、既存の`evaluateJavaScript`呼び出しパターン(`setEmotion`/`setMouthLevel`と
  同じ形)をcompletionHandler付きで使うだけで完結した。新規の`WKScriptMessageHandler`や
  `avatar.html`/`entry.ts`側の変更は一切不要。
- **トリガーはUUID比較方式**: SwiftUIの`updateUIView`は関係ない状態変化でも頻繁に呼ばれるため、
  Bool一発トリガーだと多重発火や「リセットし忘れて次回発火しない」バグを起こしやすい。
  `pendingPhotoCaptureID`に毎回新しいUUIDを積み、Coordinator側で「前回処理したIDと違うか」だけを
  見る設計にした(トリガーの値そのものには意味がない)。
- **CompanionViewModelを唯一の状態源にする既存原則を踏襲**: Phase 1のdev-noteにある
  「単一責務の書き込み元」原則と同じ理由で、RootViewとVRMAvatarView.Coordinatorは両方とも
  `viewModel.capturedPhotoData`を介してのみやり取りする(直接のクロージャ持ち回しをせず)。

## 検証

- `VMateTests/PhotoCaptureTests.swift`: 3ケース(正常デコード・カンマ無し・不正base64)全てpass。
- `xcodebuild test`(iPhone 17 Pro シミュレータ): 全32件pass(既存29件+新規3件、regressionなし)。
- 実機(iPhone 15 Pro、ワイヤレスデバッグ)へのインストール・起動まで確認。**画面上でのシェアシート
  実地確認(実際にタップして共有シートが開くか)はこの環境では未実施**
  ([[sourcekit-diagnostics-not-authoritative]]と同様、この環境ではUI操作の目視確認ツールが
  無いため。次回セッションでユーザー本人が実機で📷ボタンをタップして確認すること)。

## 状態・フォローアップ

- **完了**: iOS側の実装・型チェック(実ビルド)・単体テスト・実機インストール/起動まで。
- **未実施**: 実機での📷ボタンタップ→共有シート表示の目視確認(ユーザー側で確認が必要)。
- **Photo Mode自体はこれでPhase 1の残課題を解消**。Phase 2(着せ替え・ギフト機能)は別途、
  新規アセットパイプライン+バックエンドデータモデルが要るため引き続き未着手。
