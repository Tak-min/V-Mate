# 3Dアバター UX改善 Phase 1(タップ反応・ステージアップ演出・お帰り演出・フォトモード) — 2026-07-23

## 背景・動機

競合調査(Character.AI AvatarFX、Replika、Talkie、Nomi.ai、Live2Dデスクトップ系companion、
アイドルガチャ系)の結果、V-Mateの3Dアバター層(`frontend/src/features/vrm/viewer.ts`)に
共通して欠けていたのは「① モデル自体へのタップ反応」「② 親密度の節目が身体で表現されない
(StatusBarのテキストトーストのみ)」の2点。着せ替え/ギフト(Phase 2、未着手)は新規アセット
パイプライン+バックエンドのデータモデルが要るため今回は対象外。

ダークパターン(さよなら時の罪悪感訴求・不安煽り等、CDT 37種タキソノミー/CHI 2026研究で
問題視されている手法)は明示的に避ける方針。今回追加した再訪演出(`welcomeBack`)は既存の
`daysAway` 対応挨拶を拡張しただけで、温かみのみ・罪悪感/緊急性なし。

## 実装した4項目

1. **タップ反応**(`poke(region)`) — モデルをタップ/クリックすると、頭部/胴体の当たり判定
   (`setupHitProxies`、`humanoid.getRawBoneNode()` に追従する透明球)に応じたプリセットを
   短く演出する。新規 `.vrma` アセットは使わず、既存の表情ブレンド+カメラ微移動+バウンス/
   前傾の加算パルスのみで構成(`reactions.ts` の `ReactionPreset`)。
2. **ステージアップ演出**(`celebrateStageUp()`) — 親密度がステージ境界を超えた瞬間、
   モデル自体が反応する。検出は `useCompanion.ts` に一本化(`StatusBar.tsx` は独自の
   `previousStageRef` を廃止し `isStageUp` propを受け取るだけになった)。
3. **お帰り演出**(`welcomeBack(daysAway)`) — 既存の `daysAway` 対応挨拶より先に、身体で
   「待ってたよ」を表現する。不在日数で強度をスケール(`scalePreset`)。
4. **フォトモード**(`capturePhoto()`) — `preserveDrawingBuffer` は本番では `false` のまま
   (常時描画60fpsのコスト回避)。`renderLoop` が `render()` した直後、同一同期区間内で
   `canvas.drawImage` することで安全にキャプチャする。

## アーキテクチャ上の決定

- 新設 `frontend/src/features/vrm/reactions.ts`: プリセット表 + 純粋関数
  (`chooseReaction`/`reactionEnvelope`/`scalePreset`)を分離。`reactions.test.ts` で
  11ケースのユニットテストがある(vitestを新規導入、`frontend/vitest.config.ts`、
  `npm test` で実行)。**frontendに自動テストが1件も無かったのでこれが最初のテストスイート。**
- `CompanionViewer` 内の「単一責務の書き込み元」原則(`updateExpressions`=表情、
  `updateRelationship`=カメラ、`updatePresence`=姿勢)は維持。反応は `reactionEnv`
  (0..1の強度)を各メソッドが読んで**加算**するだけで、`currentWeights` 等の本来の状態には
  書き込まない → 反応が終われば `reactionEnv→0` で自動的に元に戻る。
- iOS(`ios/VMate/Sources/Avatar/VRMAvatarView.swift` 経由のWKWebView)は Web と同じ
  `CompanionViewer` を使うため、タップ反応はSwift側の変更なしで動作する
  (`pointerdown` はWKWebViewが素通しする実DOMイベント)。ただし長押しコールアウト/
  選択/ダブルタップズームを防ぐため `touch-action:none` 等のCSSを
  `frontend/src/styles/global.css` の `.vrm-canvas` と `frontend/public/ios-avatar/avatar.html`
  の両方に追加。

## 検証方法とハマりどころ

- **Gotcha: Chrome自動操作タブでは `requestAnimationFrame` が丸ごと止まる。**
  Symptom → `poke()` 実行後に `viewer.reactionEnv` を待ってもずっと `0` のまま(実際の
  レンダリングは初回のみ行われ、その後アニメーションが一切進まないように見える)。
  Cause → MCP(claude-in-chrome)が操作するタブは `document.visibilityState==='hidden'`
  になっており(OSフォーカスが無い/実画面に表示されていない)、Chromeがバックグラウンド
  タブの `requestAnimationFrame` を完全に止める仕様のため。`viewer.ts` の全アニメーション
  (瞬き・視線・呼吸も含め既存分すべて)がrAF駆動なので、この制約は今回の変更固有ではなく
  環境側の制約。
  Fix/Workaround → 実際のUI操作で見た目を確認する代わりに、`window.__viewer`
  (`frontend/src/harness/spring-debug.ts` が公開)経由で `updateReaction()` 等の内部メソッドを
  手動で叩き、`elapsed` を手動で進めながら `reactionEnv`/表情ウェイト/カメラ位置/
  `capturePhoto()` の返り値を数値で突き合わせて検証した(全て設計通りの値と一致)。
  今後この環境でアニメーション系の変更を目視確認したい場合は、同じ手動フレーム駆動の
  アプローチを使うか、実ブラウザ(自動操作でない通常のタブ)で確認すること。
- harnessバンドル(`public/harness/spring-debug.bundle.js`)はgitignore対象。iOSアバター
  バンドル(`public/ios-avatar/avatar.bundle.js`)は**git管理下**なので、`entry.ts` を
  変更したら `npm run build:ios-avatar` の再実行を忘れないこと(今回は実施済み・コミット待ち)。

## 状態・フォローアップ

- **完了**: 4項目すべて実装・型チェック(`tsc -b`)green・ユニットテストgreen・
  ハーネス上で数値検証済み。**未実施**: 実ブラウザでの目視確認(上記gotchaにより
  この環境では未達)、iOSシミュレータ/実機での実地確認。
- **未コミット**: この変更はコミットしていない(ユーザーから明示の指示があるまでcommitしない
  方針を維持)。
- **`viewer.ts` が800行ガイドラインを超過**(変更前891行 → 現在1068行)。今回のプリセット
  表/純粋関数は `reactions.ts` に分離済みだが、レンダーループに密結合した状態(反応の
  トリガー・当たり判定・キャプチャ)は性質上クラス内に留めた(単一責務の書き込み元原則を
  崩さないため)。`CompanionViewer` 全体をより小さい協調クラスに割る大掛かりなリファクタは
  今回のスコープ外・別途設計が必要。
- **フォトモードはWeb限定**: iOSのツールバーはネイティブSwiftUIなので、`App.tsx` の📷ボタンは
  iOSに出ない。`ios-avatar/entry.ts` に `capturePhoto()` forward-compat(dataURL変換)は
  追加済みだが、Swift→JS一方向ブリッジしか無い現状ではネイティブの共有ボタンから呼び出す
  経路(`WKScriptMessageHandler` 新設)は未実装・Phase 2以降。
- **Phase 2(未着手)**: 着せ替え(アクセサリ1〜2種から)・ギフト機能。今回作った
  `ReactionRegion`/`REACTION_PRESETS` は string-keyed なので、ギフト受け取りリアクションや
  衣装ホットスポットのタップ判定はプリセット/リージョンを1つ追加するだけで乗せられる設計。
