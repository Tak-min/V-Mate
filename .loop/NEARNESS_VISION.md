# VISION — シロを「親近感を抱ける」コンパニオンにする(NEARNESS ループ)

> loop-engineer 自律ループ。起点: ユーザー指示「v-mate の残タスクを参照し、ユーザが**親近感**を
> 抱く構造を自律的に改良する」。一次ソース: `dev-notes/next_session_onboarding_polish_2026-06-25.md`
> (タスクA/B/C)+ `dev-notes/humanness_realism_roadmap_2026-06-24.md`(Track D 会話の人間らしさ)。
> メモリ [[aikata-companion]] / [[feedback-vmate-push-deploy-every-turn]] / [[feedback-autonomous-work-includes-commit]]。

## 運用前提(メモリ既出・厳守)
- **本番 = `worker/`(TS)**。`backend/`(Python)は参照実装で本番非反映(会話人間らしさは worker 側に入れる)。
- アバター/UI ソース = `frontend/`(Vite/React/TS)。iOS は WKWebView 越しに同 viewer を再利用。
- v-mate は **shippable な変更単位ごとに commit→push→Cloudflare(worker)deploy** が既定。
- realistic.vrm(51MB>25MB)は build が自動 `rm`。harness バンドルも build で除去。
- **検証**: 本番 WebGL 連続描画下で `browser_take_screenshot` は5秒タイムアウト多発 →
  `gl.readPixels`(アバター非ブランク)+ `document.body.innerText`/DOM 走査(文言確認)が確実。
  新規初回状態は `?condition=` を付けず Cookie クリア/新規コンテキストで開く。

## ゴール(Definition of Done — 検証可能)
「初見ユーザーが迷わず、シロを身近な存在として関係を築き始められる」構造を作る。

- [ ] **A. dead CSS掃除**: `text-only*` / `research-survey*` の未使用CSSを削除。build緑+回帰なし(gl.readPixels)。
- [ ] **B. 初回オンボーディング(本命)**: 初見の「これは何/どうする」が最初の1画面で伝わる。
      - 初回のみのウェルカム(シロのやわらかい口調・一人称「わたし」で自己紹介+「話しかけてみて」)。
      - 音声会話(最大の差別化)の発見性向上(コーチマーク/ツールチップ)。
      - ログイン/登録の価値が一言で伝わるマイクロコピー(端末を越えて記憶が続く)。
      - 「初回のみ表示」は `localStorage`(例 `aikata_onboarded`)でローカル管理。サーバ不要。
- [ ] **D. 会話の親近感(human-ness)**: worker 側で親近感を高める会話整形を最低1つ追加し検証可能にする
      (例: 名前を覚えて自然に呼ぶ / 相づち・間 / 復帰時の文脈言及)。SSE/ログで確認。
- [ ] **C. iOS 収束**: B でWebに入れた導線のうち iOS に要る分を反映、`xcodebuild` 緑(可能なら sim screenshot)。
- 全体: frontend build 緑 + `react-reviewer`/`typescript-reviewer`(worker変更時)CRITICAL/HIGH ゼロ +
  本番デプロイ後 gl.readPixels/DOM で確認。

## スコープ管理(KISS / YAGNI — 入れすぎない)
- 既存資産を尊重: 既に `VoiceControl` に音声オンボーディング(`vmate.voiceOnboardingSeen`)、
  `ChatPanel` に復帰ウェルカム(「おかえり。N日ぶりだね」)が存在。**重複実装しない**。recon で現状確定後に差分のみ。
- やらない: research エンドポイント完全削除(D1マイグレ伴う)/ realistic.vrm 復活 / Blender .vrm 編集。
- 過剰オンボーディング禁止。初見の認知負荷を上げない最小の導線に留める。

## ビルド順(各イテレーション=最小の検証可能ステップ)
1. IT1 — A: dead CSS 掃除(低リスクのウォームアップ)。build緑+gl.readPixels 回帰なし。
2. IT2 — B: 初回ウェルカム(アプリ目的の自己紹介)。localStorage管理。build緑→reviewゲート→deploy→DOM確認。
3. IT3 — B: 音声発見性 + ログイン価値 + 名前導線のマイクロコピー精緻化(現状の差分のみ)。
4. IT4 — D: worker 側で会話の親近感整形を1つ実装。SSE/ログ検証。
5. IT5 — C: iOS 収束 + `xcodebuild` 緑(可能なら sim screenshot)。
- 各 IT 後に `git commit` チェックポイント。shippable 単位で push+deploy。

## ガードレール
- 最大イテレーション 20(現実的には ~5-7)。同一エラー/同一検証シグナル 3 連続で停止し `.loop/NEARNESS_report.md` に報告。
- 認証/秘密情報は触らない(本タスクは UI/会話導線のみ)。秘密はコミットしない。
- review ゲートは作者と別エージェント(react-reviewer/typescript-reviewer)。CRITICAL/HIGH はブロッキング=次イテレーションの入力。
- 進捗が出ない/スコープ過大なら縮小 or build-resolver を1回試してから停止報告。

## 現状(recon 確定 2026-06-25)
- baseline frontend build: ✅ 緑。branch=master。
- **既存の親近感装置(温存・重複禁止)**:
  - 音声オンボーディング: `VoiceControl.tsx:19-48`(`vmate.voiceOnboardingSeen`、初回mic押下時のみヒント)。
  - 復帰ウェルカム: `ChatPanel.tsx:107-109`「おかえり。N日ぶりだね」(worker `postNudge` の days_away 由来)。
  - 空状態=記憶提示: `ChatPanel.tsx:111-147`(facts チップ/前回日記コールバック/時間帯・親密度別スターター)。
  - 相づちcue: `useCompanion.ts:29-57 waitingCueFor`。文末瞬き同期: `useCompanion.ts:201-203`→`viewer.blinkSoon()`。
  - TTS先読み: `speech.ts SpeechQueue`(無音ギャップ排除)。
  - 親密度5段階: `worker/persona.ts:6-38`、加点 `worker/chat.ts:103-112`、UI `StatusBar.tsx`、表情 `viewer.setAffinity`。
  - 名前: StatusBar小フォーム `StatusBar.tsx:89-103`→`/api/profile`→worker KV+fact二重保存。会話反映は persona `namePart`。
  - ペルソナ: `worker/persona.ts:60-94 buildSystemPrompt`(感情タグ必須/1-3文/「ユーザー」呼び禁止/訂正禁止)。
- **真のギャップ(本ループの対象)**:
  1. 初見の自己紹介・「どうする」導線が皆無(`App.tsx` に初回判定なし)。挨拶ナッジが唯一の初回接点。
  2. 名前導線が視覚的に地味。3. dead CSS(`text-only*`/`research-survey*`)。
  4. worker 側に文末の「間/呼吸」整形なし(`chat.ts` は文長制限とタグ処理のみ)。

## 設計判断(親近感の構造をどう作るか)
- **重いチュートリアルモーダルは作らない**(没入破壊・「常時シロ表示でただ話せる」哲学と矛盾・handoffの過剰禁止)。
- 代わりに **初回の挨拶ナッジ自体を「自己紹介+話しかけての誘い+声でも話せる示唆」に寄せる**
  (handoff 推奨の低コスト案)。frontend で初回判定(`aikata_onboarded`)→ `/api/nudge` に `first_visit` を渡し、
  worker `postNudge`+`persona.nudgePrompt` に初回バリアントを足す。これが「親近感の入口構造」の中核。
- 加えて空状態に**控えめで dismissible な初回ヒント**(声で話せる/名前を教えてね)を最小限添える。
