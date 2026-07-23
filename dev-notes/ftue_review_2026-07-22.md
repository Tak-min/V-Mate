# FTUE(初回起動体験)実レビュー + UI/UX改善 (2026-07-22)

> 前回の`ui_polish_ios_onboarding_overlay_2026-07-02.md`が残タスクとして挙げていた
> 「iOSシミュレータ目視確認が未実施」を今回実施し、見つかった問題を修正した。

## 背景

ユーザー依頼: 「実際にアプリを動かして確認し、それをもとにUI/UXを改善、初回オンボーディング
体験をデザインする」。実機(俺のGALAXY Pro Max / iPhone 15 Pro)はロック中かつこの環境には
実機のUI自動操作・スクリーンショット取得ツールが無く、実機での自動ウォークスルーは技術的に
不可能と判明したため、ユーザー承認を得てiPhone 17シミュレータでの全自動ウォークスルーを代替
手段として採用した。

## 手法: DEBUG限定の環境変数によるステップジャンプ

`tap`系のUI自動操作ツール(XcodeBuildMCPのUI automationワークフロー)もこの環境では有効化
されておらず、オンボーディングの各ステップへタップで進めなかった。そこで`OnboardingView.swift`
のinitに、DEBUG限定・環境変数駆動のステップジャンプを追加した:

```swift
#if DEBUG
if let forced = ProcessInfo.processInfo.environment["UITEST_ONBOARDING_STEP"].flatMap(Int.init) {
    _step = State(initialValue: forced)
} else {
    _step = State(initialValue: startAtAge ? 1 : 0)
}
#else
_step = State(initialValue: startAtAge ? 1 : 0)
#endif
```

`launch_app_sim({ env: { "UITEST_ONBOARDING_STEP": "2" } })`で任意ステップに直接ジャンプでき、
タップ操作なしにスクリーンショットで各画面を確認できる。Release ビルドには一切影響しない。
**このスキャフォールドは今後のFTUEレビューでも再利用できるよう、削除せず残した。**

## Gotcha

- **`build_run_sim`の`env`パラメータは反映されない**: `mcp__xcodebuild__build_run_sim({ env: {...} })`
  を呼んでもアプリ側で環境変数が見えなかった(常にデフォルト値で起動する)。`stop_app_sim` →
  `launch_app_sim({ env: {...} })` と明示的に分けて呼ぶ必要がある(`launch_app_sim`側は正しく
  `SIMCTL_CHILD_`prefix経由で反映される)。既存の`ui_polish_ios_onboarding_overlay_2026-07-02.md`
  にあるSourceKit偽陽性(`Cannot find type 'X' in scope`が実ビルド成功時にも大量に出る)も今回
  再確認した — 実ビルド(`xcodebuild`)の結果のみを信頼すること。
- **セッション内でxcodebuildMCPのsession defaultsが予告なくリセットされることがある**:
  `session_show_defaults`が全項目`null`を返す場面に遭遇。`stop_app_sim`等がdefaults不足で
  エラーになったら、まず`session_show_defaults`で状態を確認し、`session_set_defaults`で
  `projectPath`/`scheme`/`simulatorName`/`bundleId`を再設定する。
- **実機の視覚キャプチャ手段がこの環境に無い**: `xcrun devicectl device`にscreenshotサブコマンド
  無し、`idevicescreenshot`(libimobiledevice)も未インストール。実機へのビルド書き込み・起動自体は
  `.loop/DEVICEVERIFY_state.json`の前例通り可能(要ロック解除)だが、画面を視覚的に確認する手段は
  無い。次回同種のタスクをする場合、`brew install libimobiledevice`で`idevicescreenshot`を
  導入すれば静止画レベルでは実機確認ができる(タップ操作の自動化は別途WebDriverAgent等が必要、
  今回はコスト対効果が見合わないと判断し見送った)。

## 発見した問題と修正

### 1. 【当初「バグ」と誤認 → 実際はコントラスト問題】nameStepの「オーバーラップ」

**症状**: 名前入力ステップで、説明文の2行目とTextFieldが視覚的に重なって見えた。auto-focus
(`.onAppear { nameFieldFocused = true }`)を無効化しても再現したため、キーボード回避によるレイアウト
崩れという当初仮説(H1)は棄却。

**切り分け方法**: `Text`と`TextField`にそれぞれ`.background(Color.blue.opacity(0.3))` /
`.background(Color.green.opacity(0.3))`を一時的に付けて実際のフレーム境界を可視化した結果、
**フレームは一切重なっていなかった**。原因は`Color.warmBrown`(暗い茶色)の本文テキストが、
アプリ全体が`.preferredColorScheme(.dark)`前提でダークな`.ultraThinMaterial`カード上に
乗っていたため低コントラストで読みづらく、隣接するTextFieldの暗い縁と視覚的に「溶け合って」
重なって見える錯覚だった。

**教訓**: 「重なって見える」は必ずしも「フレームが重なっている」ことを意味しない。一時的な
識別用背景色をつけて実際の境界を可視化するのが、レイアウトデバッグとコントラストデバッグを
安価に切り分ける方法として有効。

**修正**: `OnboardingView.swift`内の本文テキスト・キャプション・HintRow等、`Color.warmBrown`を
使っていた箇所を`Color.white.opacity(...)`系に統一(warmBrownは明るいカード前提の色で、ダーク
基調の本体アプリと設計が食い違っていた)。HintRowの背景`Color.accentPink.opacity(0.08)`も
`Color.white.opacity(0.08)`に変更して視認性を上げた。

### 2. 背景UIの透け過ぎ

**症状**: オンボーディングのwelcome画面(step 0)で、背景の`Color.black.opacity(0.25)`が薄すぎて、
メイン画面のヘッダー(親密度バー「♡0」等)・会話サジェストチップ・テキスト入力欄がくっきり
見えてしまっていた。初回ユーザーがまだ何もしていない段階で、既に「実績が空」であることや
チャットUIの複雑さが見えてしまい、「はじめまして」の第一印象の純度を薄めていた。

**修正**:
- `RootView.swift`: `showOnboarding == true`の間、ヘッダーと`ConversationOverlay`を描画しない
  (`if !showOnboarding { ... }`でガード)。アバターと背景グラデーションはそのまま表示し、
  「シロの気配」は保ちつつクローム(UI部品)だけを隠す。
- `OnboardingView.swift`: 背景スクリムを`0.25` → `0.45`に強化。

## 対応しなかった項目(スコープ外・任意)

- **StoreView / AccountViewの見た目統一**: RevenueCat移行(前セッション)で機能的には完成・
  テスト済みだが、Sign in with Appleによる実認証が必要でシミュレータでは中身まで確認できない
  ため、今回は見送った。code-architectのブループリントでは「本体の世界観に寄せる」 P2改善案
  (背景色・CTA配色・導入コピー)が提案されている。RevenueCatロジックやApple 3.1.2開示は変更
  しないこと。
- **hintStepの名前echo**(`"\(name)、よろしくね！"`)は実装済みだが、シミュレータ上ではデバッグ
  ジャンプで名前入力をスキップしているため実際の表示は未確認(コードレビューでロジックは確認済み)。
- **fireGreeting完了直後の無音区間**: サーバー往復中にメイン画面が無言になる件は、クライアント側
  ではなく`requestNudge`のサーバー側/プロンプト側の改善余地として記録のみ(今回のスコープ外)。
- **saveNameとfireGreetingのrace**: `onComplete`内で`saveName()`(非同期)と`fireGreeting()`が
  並走しており、`saveName`が着地する前に挨拶が生成されると名前が反映されない可能性がある
  (code-architectのブループリントで指摘)。要検証・場合により worker 側の対応が必要。

## 検証結果

- `xcodebuild`(build_sim): エラー・warning無し
- `test_sim`: 既存24テスト全てgreen(回帰無し)
- クリーンインストール後のシミュレータ目視: step0(背景UI非表示・テキスト白色で可読)、
  step2(オーバーラップ解消)、step3(HintRow可読性向上)を確認済み

## 変更ファイル

- `ios/VMate/Sources/Views/OnboardingView.swift` — コントラスト修正、背景スクリム強化、
  DEBUG限定ステップジャンプ、hintStepの名前echo、stepDotsアクセシビリティ
- `ios/VMate/Sources/Views/RootView.swift` — オンボーディング中のヘッダー/ConversationOverlay非表示

## 未コミット

前セッションのRevenueCat移行分含め、全て未コミットのまま。ユーザーへコミット可否の確認が必要。

---

**文書作成:** 2026-07-22
**関連:** `ui_polish_ios_onboarding_overlay_2026-07-02.md`(前回のオンボーディング改修)、
`.loop/FTUE_VISION.md` / `.loop/FTUE_state.json`(今回のループアンカー)、
`.loop/DEVICEVERIFY_state.json`(実機書き込み前例)
