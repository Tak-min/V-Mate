# UIデザイン監査+デザインシステム導入(2026-07-23〜24)

## 背景

依頼者から「現状のUIはありきたりでカスだ」との指摘を受け、シミュレータで実画面を見ながら
デザイン専門家視点での評価と改善を行った。tapツール(UI自動操作)が本環境では未設定のため、
env変数フックで画面遷移した点も含めて記録する。

## 調査手法: tapツールなしでのシミュレータ画面遷移

`mcp__xcodebuild__*` はデフォルトでは compile/build/launch/screenshot 系のみ有効で、
tap/swipe/type_textのようなUI自動操作ツールは(このマシンでは)未設定。オンボーディング以外の
画面(メイン画面・Account・Store・Diary)はタップ操作なしには到達できない。

**対応**: 既存の`OnboardingView.swift`に`#if DEBUG`+`ProcessInfo.processInfo.environment["UITEST_ONBOARDING_STEP"]`
という「タップなしで任意ステップへジャンプする」パターンが既にあったため、同じ手法を`RootView.swift`の
`.task`に一時的に追加(`UITEST_SKIP_ONBOARDING`/`UITEST_OPEN_ACCOUNT`/`UITEST_OPEN_STORE`/`UITEST_OPEN_DIARY`)。
スクリーンショット取得後は全て revert 済み(コミット履歴に残さない)。

**再利用可能な知見**: 今後も同種の「タップなしで特定画面を見たい」場面では、この使い捨てenv変数フック
パターンが有効。`launch_app_sim`の`env`パラメータで注入できる(`build_run_sim`にはenvパラメータがないため、
`build_run_sim`→`stop_app_sim`→`launch_app_sim(env:...)`の順で使う)。

## 発見した実バグ

`RootView.swift`のヘッダーで、`HStack(alignment:.top) { 身元VStack; Spacer; ボタン行.layoutPriority(1) }`
という構造により、**iPhone 17 Pro(最新の標準画面幅)ですら**身元テキスト(「シロ」「はじめまして ♡0」)が
1文字ずつ縦に折り返されて完全に潰れるバグがあった。原因コメントは「iPhone SE等の狭い画面でボタンが
潰れないよう優先度を上げる」だったが、全画面幅で過補正になっていた。
**Fix**: 身元列とボタン列を同じHStackで幅を奪い合わせず、別々の行(縦積み)に分離。
`identityColumn`/`controlCluster`として計算プロパティ化、`.layoutPriority(1)`は削除。

## 根本原因の診断(code-architectエージェント調査)

「オンボ/メイン画面=量産テンプレ的」「Account/Store/Diary=無装飾で未完成に見える」という
一見別々の問題は、実は**単一の原因(デザインシステムの不在)**の別症状だった
(`PersonaColors.swift`には色4つ+グラデ1つしかなく、型スケール・余白スケール・
コンポーネントが存在しなかった)。表舞台はグラデ/ガラス質感で穴を隠し、裏方は隠すことすら
していなかっただけ。→ 直すべきは個別画面ではなく「トークンを1本通して全画面に適用する」こと。

## 実装した内容

新規 `Views/Theme.swift`:
- タイポグラフィスケール(`.brandDisplay`/`.brandTitle`/`.brandHeading`/`.brandBody`/`.brandCaption`/`.brandLabel`、
  全て`design: .rounded`—キャラクターに声があるようにUIにも声を持たせる狙い)
- 余白/角丸トークン(`Space`/`Radius`)
- 裏方画面用のセマンティックカラー(`textPrimary`/`textSecondary`/`textTertiary`、
  `ShapeStyle where Self == Color`で`.foregroundStyle(.textSecondary)`のドット記法に対応)
- `BrandBackground`(温かいダークプラムの地。システム純黒の代替)
- `.glassCard()`(7箇所に重複していたフロストガラス面をDRY化する予定だったが、今回はAccount/Store/Diaryの
  新規部分にのみ適用。ConversationOverlay/OnboardingView側の重複コピペ解消は未着手 — 下記「残作業」参照)
- `BrandPrimaryButtonStyle`(ピンク→ラベンダー主ボタン)
- `BrandScreen`(裏方3画面共通のスカフォールド: NavigationStack+BrandBackground+閉じるボタン)

適用先: `AccountView.swift` / `DiaryView.swift` / `StoreView.swift`(ガワのみ刷新、
Sign in with Apple・削除・購入・復元・年齢ゲート等のロジックは全て無変更)。

`StoreView.swift`(課金/paywall画面)はhero+ベネフィットリスト+CTA構成に全面再構築。
**ベネフィットのコピー(`ProBenefit`配列)は雛形であり、実際のPro特典に依頼者確認の上で
差し替えが必要**(TODOコメントを付与済み)。

## ハマりどころ

### 1. 新規Swiftファイルを追加してもビルドに含まれない

**Symptom**: `Theme.swift`を新規作成した直後、`build_sim`で"cannot find 'Space' in scope"等、
Theme.swift内で定義したはずのシンボルが他ファイルから見つからないというビルドエラー。

**Cause**: このXcodeプロジェクト(`VMate.xcodeproj`)は**PBXFileSystemSynchronizedRootGroup
(Xcode 16の「フォルダに置くだけで自動的にターゲットに入る」機能)を使っていない**、旧来の
明示的ファイル参照方式(`PBXBuildFile`+`PBXFileReference`)。ファイルシステムに`.swift`を
置くだけではターゲットのSourcesビルドフェーズに入らない。

**Fix**: `project.pbxproj`を直接編集し、既存の`PersonaColors.swift`のエントリを参考に
4箇所(PBXBuildFileセクション、PBXFileReferenceセクション、Viewsグループの子リスト、
Sourcesビルドフェーズのファイルリスト)に手動で追記する必要がある。IDは24桁16進数文字列
(`python3 -c "import secrets; print(secrets.token_hex(12).upper())"`で生成可)。
次回も新規ファイル追加時はこの4箇所を忘れずに。

### 2. `.foregroundStyle(.textSecondary)`のようなドット記法が独自Colorトークンで解決されない

**Symptom**: `extension Color { static let textSecondary = ... }`と定義しても、
`.foregroundStyle(.textSecondary)`(先頭ドット記法)が"type 'ShapeStyle' has no member"で
コンパイルエラー。`Color.textSecondary`と明示すれば通る。

**Cause**: `foregroundStyle(_:)`の引数型は`some ShapeStyle`(存在型)。先頭ドット記法での
静的メンバ探索は、コンテキスト型(`ShapeStyle`)を直接拡張した静的メンバしか見つけない。
Appleの`.white`/`.red`等が動くのは`extension ShapeStyle where Self == Color { static var white: Color }`
という橋渡しがSwiftUI側で提供されているため。`Color`単体への`extension`だけでは不十分。

**Fix**: 自作トークンも同じパターンで`extension ShapeStyle where Self == Color { static var textSecondary: Color { .textSecondary } }`
を追加する必要がある(`Theme.swift`に実装済み)。

### 3. SourceKitの誤検知ノイズ(実ビルドとは無関係)

このセッション中、Edit直後に頻繁に「Cannot find 'X' in scope」「No such module 'RevenueCat'」
「'navigationBar' is unavailable in macOS」等のSourceKit診断が出たが、**実際の`xcodebuild build_sim`は
これらと無関係に成功したりエラーになったりする**(例: `navigationBar unavailable in macOS`は
SourceKitがなぜかmacOSターゲットとして解析している形跡で、実際のiOSシミュレータビルドとは無関係)。
SourceKit診断を鵜呑みにせず、必ず`mcp__xcodebuild__build_sim`の実結果で判断すること。

## 残作業(次セッションへの引き継ぎ)

優先順位付きで、Opus(code-architect)の設計ブループリントの一部が未着手:

1. **P2(未着手)**: `ConversationOverlay.swift`/`OnboardingView.swift`/`FirstMeetingStep.swift`の
   既存フロストガラス実装(`.ultraThinMaterial`ベタ書きが複数箇所)を`.glassCard()`へdedupe。
   見た目は変わらない内部リファクタなので優先度は低い。
2. **P4関連・要依頼者確認**: `StoreView.swift`の`ProBenefit`配列(ベネフィットコピー)は雛形。
   実際のシロProの特典内容を確認の上で差し替えが必要。
3. **P5(未着手・任意・最高ROIとcode-architectが指摘)**: 🐾/📓の絵文字やpaywallヒーローの
   `sparkles`アイコンを、シロの2Dマーク(肉球/チビ顔等)のPNGアセットに差し替える。
   「ありきたり」感の本丸はここ(配色/タイポは土台に過ぎない)という指摘あり。
   アセット制作方針(生成 or 依頼者側で用意)は未確定、要相談。
4. オンボーディングの年齢確認ステップ(`DatePicker(.wheel)`)のブランド化(`.accentColor(.accentPink)`程度の
   軽微な調整)、`AgeBlockedView.swift`の`warmBrown`(darkテーマに残ったlight-theme由来トークン)の置換は未着手。

## 検証状況

- `xcodebuild build_sim`で正常ビルド確認済み。
- シミュレータ実機(iPhone 17 Pro)で before/after のスクリーンショット取得・目視確認済み
  (ヘッダーバグ修正・Account/Store/Diaryの背景統一を確認)。
- 実機/TestFlightでの検証、および購入フロー(認証必須のためStoreViewのpaywall本体=
  hero/benefit/CTA部分)は今回未検証(サインイン状態のシミュレータテストが必要)。
