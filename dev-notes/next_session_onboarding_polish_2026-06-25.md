# 次セッション向けハンドオフ — オンボーディング深掘り / dead CSS掃除 / iOS視覚確認 (2026-06-25)

> 2026-06-25 の loop-engineer「ALWAYSAVATAR」ループの**残タスク**を、別AIエージェントが
> コールドスタートで自律着手できる粒度で残す。**前提**: 中核(必ずシロ表示 / Web・iOS収束 /
> 研究撤去 / ロード失敗堅牢化)は IT1-3 で完了・全検証・デプロイ済み。本書はその「ポリッシュ残」。
> 直前の経緯: `dev-notes/web_avatar_always_show_2026-06-25.md`、`.loop/ALWAYSAVATAR_*`、メモリ [[aikata-companion]]。
>
> 重要な運用ルール(メモリ既出): 本番は `worker/`(TS)。`backend/`(Python)は参照実装で本番非反映。
> v-mate はコミット→push→Cloudflare デプロイまで毎ターン既定。realistic.vrm(51MB>25MB)はデプロイ除外
> (`frontend` の `build` が自動 `rm`)。**MCP `browser_take_screenshot` は本番WebGL連続描画下で5秒
> タイムアウト多発 → `gl.readPixels` でのピクセル検証が確実な代替**(IT1で実証)。

---

## タスクA: dead CSS 掃除(最小・低リスク・先にやると良い)

研究撤去(IT2)で参照元が消えた**完全に未使用の CSS**。TSX参照ゼロを grep で確認済み。
`frontend/src/styles/global.css` から以下を削除する:

- `.stage-text-only::after`(≈L98-)/ `.text-only-presence`(≈L104-)/ `.text-only-pulse`(≈L112-)
  — `text` 条件の身体非表示プレースホルダ用。今は常時アバター表示なので不要。
  併せて `@keyframes` でこれらだけが使う pulse 系アニメがあれば一緒に削除。
- `.research-survey` 一式(≈L1093-1193)+ レスポンシブの `@media` 内 `.research-survey`/
  `.research-survey-card`(≈L1288, L1293)— アンケートUIのスタイル。コンポーネントは削除済み。
- 検証: `npm --prefix frontend run build` 緑 + 画面回帰なし(`gl.readPixels` でアバター描画維持を確認)。
- 注意: 行番号は今後ずれるのでセレクタ名で検索して消すこと。`grep -nE "text-only|research-survey" global.css`。

---

## タスクB: Webオンボーディング深掘り(批判的分析→改善)※本命

ユーザー指示「初見ユーザーが迷わない導線に」。**まず下記の懐疑的分析を検証し、優先度を付けてから実装**。
関連ファイル: `frontend/src/App.tsx` / `components/StatusBar.tsx` / `components/ChatPanel.tsx` /
`components/AuthBar.tsx` / `features/chat/useCompanion.ts`(挨拶= `requestNudge('greeting')`)。

### 批判的分析(2026-06-25時点・要再検証)
1. **初見の「これは何/どうする」が無い**: 画面を開くといきなりシロ+チャット。アプリの目的
   (常駐AIコンパニオン/話しかけると返す/声でも話せる)を最初の1画面で伝える要素が無い。
   → 改善案: 初回のみの軽いウェルカム(シロの一言で自己紹介+「話しかけてみて」)。
   既存の挨拶 `requestNudge('greeting')` を初回オンボーディング文言に寄せるのが低コスト。
2. **音声会話(最大の差別化)が発見されにくい**: 🎤ボタンの意味/「ハンズフリーで話せる」ことが
   初見に伝わらない。→ 初回だけ 🎤 に軽いコーチマーク or ツールチップ。
3. **名前入力の位置づけ**: StatusBar の「呼んでほしい名前は? 教える」は良い導線だが、初見の
   優先度(まず会話 vs まず名前)を検討。会話を1往復してから名前を促す方が自然な可能性。
4. **ログイン/登録の動機が不明**: AuthBar の「ログイン/登録」を押す理由(端末を越えて記憶が続く)が
   その場で分からない。→ マイクロコピーで価値を一言(「ログインすると別の端末でも記憶が続くよ」)。
5. **空状態/初回の履歴**: 新規匿名ユーザーが過去会話の体裁を見て混乱しないか要確認
   (今回の本番スクショに出た会話は検証セッションの履歴の可能性。新規Cookieで `?` を付けず
   シークレットで開いて初回状態を `gl.readPixels`+DOM textで確認すること)。
6. **ロード体験**: 16.8MB の shiro.vrm 初回DLは回線次第で数秒。`loadProgress` のリングは出るが、
   遅回線での体感を確認(IT1でフォールバックUIは追加済み=失敗時は再読込ボタン)。
   さらに改善するなら「初回だけ軽量プレビュー→本体差し替え」等もあるが過剰の可能性。YAGNI考慮。

### 実装の進め方(推奨)
- 上記1〜5を**スクショ/DOMで現状確認→優先度付け**(批判的に、入れすぎない。KISS/YAGNI)。
- 「初回のみ表示」状態は `localStorage`(例 `aikata_onboarded`)で管理。サーバ不要・端末ローカルで十分。
- 文言はシロのペルソナ(やわらかい・一人称「わたし」寄り)に合わせる。`persona.ts` のトーン参照。
- 各変更後: `npm --prefix frontend run build` 緑 → デプロイ → 本番 `gl.readPixels`+DOM文言で確認。
- レビューゲート: `react-reviewer`/`typescript-reviewer` を回し CRITICAL/HIGH ゼロを確認(ループ既定)。

### 検証の型(IT1で確立)
```
本番 https://aikata.taku810616.workers.dev を Playwright で開く →
  browser_take_screenshot がタイムアウトするので gl.readPixels でアバター非ブランク確認 +
  document.body.innerText / DOM 走査でオンボーディング文言の有無を確認。
新規初回状態は ?condition= を付けず、Cookie をクリア(または新規コンテキスト)で開く。
```

---

## タスクC: iOS のオンボーディング収束 + 視覚確認

- 現状: IT3 で iOS の研究撤去・Web収束は完了、`xcodebuild`(iPhone 17 Pro sim)BUILD SUCCEEDED。
  アバターは元から常時表示。**ビルド緑までは確認済みだが、シミュレータ/実機での視覚確認は未実施**。
- 次セッションでやること:
  1. タスクBでWebに入れたオンボーディング要素のうち、iOSにも要るものを `ios/VMate/Sources/Views/`
     (`RootView.swift`/`ConversationOverlay.swift`/`AvatarView.swift`)に対応実装し、Web/iOSの体験を揃える。
  2. シミュレータ起動して視覚確認:
     `xcodebuild -project ios/VMate.xcodeproj -scheme VMate -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build`
     → `xcrun simctl boot` → install/launch → `xcrun simctl io <UDID> screenshot`。
     アバター(WKWebView越し shiro.vrm)が出ること、会話が流れることを確認。
- gotcha(メモリ既出): **SourceKit はiOSターゲットの型を誤検知(偽陽性「Cannot find type …」)。真判定は
  `xcodebuild` のみ**。新規 `.swift` ファイル追加時のみ project.pbxproj 手動編集 or xcodegen 再生成が必要
  (今回のIT3は既存ファイル編集のみ=不要だった)。

---

## やらないこと / 判断保留(スコープ管理)
- worker 側の研究エンドポイント(`/api/research/*`)と `research_events` テーブルは**現状温存**
  (製品からは一切呼ばれない死蔵=無害)。完全削除は D1 マイグレーション(`research_events` DROP)を伴い
  リスクがあるため、必要になったら別タスクで。chat の `condition` 既定 "stylized" も温存で問題なし。
- realistic.vrm 復活(R2配信)は別件(メモリ「落とし穴1」/2026-06-23のMODELSバインディング調査メモ参照)。

## 完了の定義(このハンドオフ分)
A: dead CSS削除でbuild緑+回帰なし。B: オンボーディング改善がスクショ/DOMで確認でき初見導線が成立。
C: iOSがWebと同等の導線+シミュレータ視覚確認。各々 build緑+reviewゲート+デプロイ(Web)/commit。
