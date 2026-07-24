# オンボーディング「キャラクター登場演出」+ 常時プレースホルダー撤去 — 2026-07-24

## 背景

ユーザー指摘の2点:
1. アプリ初回起動時、welcome/年齢確認の段階で既にキャラクター(3D VRM、及びその2Dプレースホルダー)が
   画面裏にうっすら見えてしまっていた。あるべき体験は「年齢確認 → タップ待ち画面(キャラクター非表示)
   → タップでSE+アニメーションと共に登場 → はじめまして+名前を聞く」という演出付きの初対面。
2. `RootView.avatar` の`else`分岐で、VRM WebViewの読み込み中は常に2D `AvatarView`(丸顔プレースホルダー)
   を背後に重ねて表示していた。これが1の「読み込めていない時に何か表示されてしまう」問題の実体。

設計は `code-architect` (Opus) に委譲して詳細ブループリントを取得し、それに沿って実装した。

## 設計判断のポイント

- **`vrmFailed`の完全失敗フォールバック(2D AvatarView)は残す**。これは通信断・パースエラー等の
  正当なエラー救済経路であり、reveal演出とは無関係。削除対象は「読み込み中に常に表示される
  プレースホルダー」のみ。
- **reveal(タップ)画面はフルブリード・ウィザードカードなし**。「暗幕が晴れてキャラクターが現れる」
  演出にはカードUIより黒背景+タップ待ちの方が合う。
- **reveal完了タイミングはSwift側の`didFinish navigation`のみで判定**。avatar.html(Cloudflare Worker
  配信、Web版と共有)側にJSブリッジ(WKScriptMessageHandler)を追加する案もあったが、そちらは影響範囲が
  Web版にも及ぶため見送り。`didFinish`は3Dモデルの描画完了を厳密には保証しないが、reveal画面での
  プロンプト表示時間(先読みの猶予)で実質的に吸収される。
- **SEは`AudioServicesPlaySystemSound(1519)`(システムサウンド)+ ハプティクスで代替**。
  プロジェクトに音声アセット(.caf/.wav/.mp3)が一切存在しないため、ゼロアセット・ゼロビルド変更の
  v1として採用。専用音源を追加する場合は `VMate/Resources/` を新設し `project.yml` の
  `targets.VMate.sources` に追記 → **`xcodegen generate`必須**(既知の落とし穴、
  `xcodegen_new_file_gotcha_2026-07-20.md`参照)。

## 実装(ファイル別)

1. **`CompanionViewModel.swift`**: `isReadyToReveal` / `isCharacterRevealed` / `isAvatarLoaded` の
   3つの`@Published`フラグを追加。オンボーディング側(タップ操作)からRootView側(アバター実体)へ
   状態を橋渡しする役割。
2. **`VRMAvatarView.swift`**: `onLoadFinished: (() -> Void)?` を追加し、`WKNavigationDelegate`に
   `didFinish navigation`ハンドラを新設。これまで`didFail`系のみで「成功」シグナルが皆無だった。
3. **`RootView.swift`**:
   - `avatarMounted` / `characterVisible` の2つの算出プロパティでゲーティング
     (`!showOnboarding || viewModel.isReadyToReveal` 等)。完了済みユーザーは即座に両方true。
   - `avatar`から常時表示の2D `AvatarView`プレースホルダーを削除。マウント前は`Color.clear`。
   - `VRMAvatarView`に`.opacity`+`.scaleEffect`+`.animation`でフェードイン登場演出(0.6s ease-out)。
   - `onboardingInitialStep`: 強制終了→再起動時、`ageBand`がサーバに永続化済みなら
     reveal画面(step2)から再開する(年齢確認をやり直させない)。
4. **`OnboardingView.swift`**:
   - ステップ再採番: 0=welcome, 1=年齢確認, **2=reveal(新規)**, 3=name, 4=hint。
   - `revealStep`: 暗幕+「シロに会いにいく / 画面をタップしてね」。`avatarReady`が来るまでは
     `ProgressView`、来たら`hand.tap.fill`アイコン。読み込みが3秒経っても終わらない場合は
     `revealTapFallbackElapsed`でタップを強制的に有効化(ハングでユーザーを詰まらせない)。
   - `performReveal()`: SE+ハプティクス→`onRevealCharacter()`→0.6秒後に`advance()`。

## ハマりどころ / 気づき

1. **SourceKitの誤検知が編集直後に大量発生**(`Cannot find 'UIViewRepresentable' in scope`
   `Type 'Color' has no member 'accentPink'`等、実際には存在する型・メンバー)。編集の度に
   インデックスが一時的に破綻する既知の挙動(`sourcekit-diagnostics-not-authoritative.md`参照)。
   実際の正しさは`xcodebuild`の結果でのみ判断すること。今回も最終的に**BUILD SUCCEEDED**で
   全て虚報と確認済み。

2. **stepの間に新規ステップを挿し込むと、既存の「もどる」ボタンが「消費済み」の状態へ
   戻ってしまう罠**。`nameStep`(元step2→新step3)の`backButton()`は汎用の`retreat()`
   (`step -= 1`)を呼ぶため、新設した`revealStep`(step2)へ戻る。しかし`revealStep`の
   `isRevealing`は一度trueになったら(通常のフロー内では)戻らない設計だったため、戻った瞬間に
   暗幕が晴れきった空白画面になり得た。
   **修正**: `revealStep`の`.onAppear`で`isRevealing`/`revealTapFallbackElapsed`を
   毎回リセットする(＝この画面は再訪のたびに「フレッシュなタップ待ち」に戻る)。RootView側の
   `viewModel.isCharacterRevealed`は意図的にリセットしない(一度登場したキャラクターを
   再び隠す理由がないため)。**教訓**: ウィザード的な線形フローに新ステップを挿入する際は、
   既存の「もどる」導線が新ステップへ戻った場合に何が起きるかを必ず確認すること
   (view自体が`if step == N`で都度再構築される設計なら、`.onAppear`でのリセットが有効な対策になる)。

## 状態

- [x] 4ファイルの実装完了(CompanionViewModel/VRMAvatarView/RootView/OnboardingView)
- [x] シミュレータビルド成功(iPhone 17, iOS 26.5) — コンパイル正しさの確認のみ
- [x] 実機(俺のGALAXY Pro Max, ワイヤレス)へインストール・起動成功
- [ ] **実機での目視確認は未実施**(タップ操作を伴うオンボーディングフローのため、
      エージェント側では自動検証していない。ユーザー本人による実機確認が必要)
- [ ] SEを専用音源にする場合のアセット追加(v1はシステムサウンドのプレースホルダー)

## 関連

- `ios/dev-notes/xcodegen_new_file_gotcha_2026-07-20.md` — 新規ファイル追加時のxcodegen再生成
- `ios/dev-notes/wireless_debug_real_device_2026-06-19.md` — ワイヤレス実機デバッグ手順
- `~/.claude/projects/-Users-taku8/memory/sourcekit-diagnostics-not-authoritative.md`
