# 初見ユーザーのオンボーディング挨拶(親近感の入口構造)— 2026-06-25

> loop-engineer 自律ループ「NEARNESS(親近感を抱く構造)」の実装ログ。
> 起点指示: 「v-mate の残タスクを参照し、ユーザが親近感を抱く構造を自律的に改良する」。
> 一次ソース: `next_session_onboarding_polish_2026-06-25.md`(タスクA/B/C)+
> `humanness_realism_roadmap_2026-06-24.md`(Track D)。アンカー: `.loop/NEARNESS_VISION.md` / `.loop/NEARNESS_state.json`。
> 関連メモリ [[aikata-companion]] / [[feedback-vmate-push-deploy-every-turn]]。

## 結論(何をやったか)
1. **IT1(commit `e675642`)**: 研究撤去で死蔵していた CSS 153行を削除
   (`text-only*`/`@keyframes text-pulse`/`research-survey*`)。TSX参照ゼロを確認済み。
   CSS 20.26→17.79kB。build緑・回帰なし。
2. **IT2(commit `1693133`・本番デプロイ済 Version `228a8972`)**: 初見ユーザーへの
   オンボーディング挨拶。**最初の挨拶ナッジ自体を「①シロと自己紹介 ②気軽に話しかけてねと誘う
   ③マイクで声でも話せると案内」に寄せる**。重いチュートリアルモーダルは作らず、
   「常時シロ表示・ただ話せる」哲学を維持(handoff の低コスト案に忠実)。

### 変更ファイル
- `frontend/src/features/chat/onboarding.ts`(新規): 端末ローカル `localStorage.aikata_onboarded` で
  初見判定。private モード等の例外は安全側(初回演出スキップ)に倒す。
- `frontend/src/features/chat/api.ts`: `requestNudge(reason, { firstVisit })` に拡張、body に `first_visit`。
- `frontend/src/features/chat/useCompanion.ts`: 挨拶 useEffect で `isFirstVisit()` を渡し、`.finally` で
  `markOnboarded()`(成功/失敗どちらでも記録=LLM失敗時に毎回 intro を再試行し続けない)。
- `worker/src/persona.ts`: `nudgePrompt(context, { intro })` に intro バリアント追加(自己紹介+誘い+声案内)。
- `worker/src/index.ts` `postNudge`: 初見判定を **`firstVisit && !lastSeen` の二重ガード**で intro 分岐。

## 設計判断と根拠
- **なぜモーダルでなく挨拶寄せか**: 既存UXは「研究条件に関わらず常にシロを表示し、ただ話しかける」
  という没入優先設計(`App.tsx` コメント参照)。チュートリアルオーバーレイはこれと矛盾し、handoff も
  過剰オンボーディングを禁じていた。シロ自身が自己紹介する方が世界観と整合し低コスト。
- **なぜ二重ガード(`firstVisit && !lastSeen`)か**: 初見判定をクライアント単独(localStorage)に
  頼ると、localStorage だけ消した復帰ユーザーに「はじめまして」を誤爆する。サーバの活動履歴
  `last_seen` が無いことも AND 条件にし、両方が「初見」を示すときだけ intro 化(片方でも「既知」なら
  通常挨拶へフォールバックする安全側)。なりすまし耐性も得られる(client が `first_visit:true` を
  偽っても server に履歴があれば intro 化しない)。
- **既存の親近感装置は温存**: 音声オンボーディング(`VoiceControl` `vmate.voiceOnboardingSeen`)、
  復帰ウェルカム(`ChatPanel`「おかえり。N日ぶりだね」)、空状態の記憶提示(facts/日記/スターター)、
  相づちcue/瞬き同期/TTS先読み、親密度5段階 ―― これらは既に高度に作り込まれており重複実装しない、
  と recon で確認した上で「初見の自己紹介導線が無い」一点に絞った。

## 検証(本番で確認した実データ)
- **worker intro 分岐(API直叩き・決定的)**: `POST /api/nudge`
  - `{"reason":"greeting","first_visit":true}`(新規Cookie)→
    「こんばんは、こちらは**シロです**。…**気軽に話しかけてね**、**マイクのボタンを押せば声でも話できるよ**。」
    = 意図した3要素すべて出現。
  - `{"reason":"greeting","first_visit":false}`(別の新規Cookie)→
    「夕方になりましたね、今日はどんな1日を過ごしましたか。」= 自己紹介/声案内なしの通常挨拶。ガード正常。
- **frontend 配線(Playwright 実機)**: ロード後 `localStorage.aikata_onboarded === "1"`、
  `.loading`/`.load-error` ともに不在(VRM正常ロード=IT1 CSS削除の回帰なし)、console エラー0。
- **review ゲート**: typescript-reviewer = ブロッカー無し(MEDIUMのコメント精度指摘は反映済)。

## 落とし穴(Symptom → Cause → Fix)
- **Symptom**: 本番アバター検証で Playwright の `browser_take_screenshot` や、セッション中断後に
  `browser_wait_for` が "No open pages available" になる。
  **Cause**: 連続WebGL描画でスクショがタイムアウトしやすい / セッション中断でページが閉じる。
  **Fix**: アバター描画の回帰判定は**スクショや gl.readPixels に頼らず**、`.loading`/`.load-error`
  DOM の不在で「VRMが正常にロードし切ったか」を見るのが確実。**`gl.readPixels` は
  `preserveDrawingBuffer=false`(本番)では中心ピクセルが `[0,0,0,0]` を返し非ブランク判定に使えない**
  (debug ハーネスだけ true)。worker ロジックは**ブラウザを介さず curl API 直叩き**が最も決定的。
- **Symptom**: `requestNudge('idle')` でも `first_visit:false` が常時送られる。
  **Cause**: body に無条件で含めているため。**Fix/判断**: server は idle 分岐で `first_visit` を
  参照しないため無害。冗長性はコメントで明示(api.ts)。

## 状態・次セッションへの引き継ぎ(未着手=意図的に見送り)
- **Track D(会話の人間らしさ・worker persona 調整)**: 見送り。理由 = 既存ペルソナ
  (`worker/src/persona.ts` buildSystemPrompt: 感情タグ/1-3文/「ユーザー」呼び禁止/訂正禁止/
  過干渉対策の240sアイドル・180s挨拶ガード)は**意図的に細かく調整済み**で、方向性の明確な指示
  なしに prompt ルールを足すと、せっかくの均衡を回帰させるリスクが高い。やるなら「間/相づち/
  抑揚(Aivis SSML)」のうち1つに絞り、curl で before/after を比較しながら慎重に。
- **Track C(iOS 収束)**: 見送り。iOS のチャットUIはネイティブ Swift(`ios/`)で、Web の
  オンボーディング文言をそのまま流用できない(WKWebView 越しに使うのは VRM viewer のみ)。
  実装するなら Swift 側に初回挨拶の導線を作る必要があり、**検証にシミュレータ+ユーザー実機目視が必須**
  (handoff §8 既知制約)でヘッドレス完結しない。Web 側の intro は WKWebView の会話には反映されない点に注意。
- **任意の磨き込み**: LLM(`complete()`)失敗時に first-timer が無挨拶になるエッジに、静的な
  intro フォールバックを足す手はある(純粋に additive・回帰リスク無し)。費用対効果は小。
