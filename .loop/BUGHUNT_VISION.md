# VISION — V-Mate「シロ」批判的バグハント・人間性向上ループ

> loop-engineerスキルのアンカーファイル。`.loop/VISION.md`(公開デプロイ化、DONE)とは別ゴール。

## Goal
実際にこのアプリを使うユーザー、または研究実験(身体様式比較)の参加者になりきって、
Web版(frontend+worker)とiOS版を**批判的懐疑的に**操作・読解し、不具合・不自然さ・
チューリングテスト的違和感を見つけて直す。1イテレーション=1観点の検証+最重要issue1件の修正。

## Definition of Done(停止条件)
以下のいずれかで停止:
- [ ] チェックリストの全観点を検証済みで、直近2イテレーション連続で新規issueが見つからない(収束)
- [ ] `max_iterations`(20)に到達
- [ ] 同一の検証失敗(verifyエラー)が3イテレーション連続で同じ → ガードレール停止し報告

## 観点チェックリスト(ユーザー/実験参加者視点)
- [ ] 初回起動の第一印象(挨拶、ロード時間、エラー画面の有無)
- [ ] チャット送受信の基本フロー(SSE/streaming、タイムアウト、二重送信、Enter/IME変換中Enter)
- [ ] 表情・視線・モーションの破綻(会話中固定、不自然な遷移、まばたき)
- [ ] 音声(TTS再生、リップシンク、無音時のフォールバック、再生途中の状態管理)
- [ ] 親密度・記憶・日記の一貫性(リロード後の継続性、別ブラウザ/別ユーザーでの分離)
- [ ] レート制限・エラーハンドリング(超過時のメッセージ、APIエラー時のUI崩れ)
- [ ] research条件分岐(text/stylized/realistic)の切替時の不具合・統制崩れ
- [ ] iOSネイティブアプリ:ネットワーキング層のエラー処理、Avatar表示、Audio再生
- [ ] アイドル時の自発的声かけ(頻度・タイミングの不自然さ、二重発火)
- [ ] レスポンシブ/モバイルWeb表示崩れ

## Constraints / guardrails
- 既存の未コミット変更(frontend/package.json, ios/project.yml, worker/src/{env,index}.ts, worker/wrangler.jsonc, .gitignore)はR2大型VRM配信のWIPで本ループと無関係。**触らない・混ぜてcommitしない**。
- 認証/DB/秘密情報に触る修正はsecurity-reviewer(opus)レビューを通す。
- 各修正は単体でアプリが動く状態を保つ。秘密情報はコミットしない。
- 修正ごとに dev-notes に記録(CLAUDE.md Development Documentation Mandate準拠)。
- commit後はpush + Cloudflareデプロイまで一括(確認待ちしない、既定フィードバック)。

## Recon findings(Phase 1で記入)
- 構成: backend/(FastAPI, ローカル開発用) / worker/(Cloudflare Worker, 本番API) / frontend/(Vite+React+three-vrm) / ios/(SwiftUI native)
- 本番は worker/ 経由(D1+R2+Workers Assets)。backend/ はローカル専用の可能性あり(要確認)。
- dev-notes/に過去の人間性向上修正多数(視線固定、感情慣性、日記自己継続、AI自発干渉抑制、VAD無限ループ修正等)

## Recon: frontend(chat/vrm/voice)の不具合候補(2026-06-22, code-explorer調査)
1. [CRITICAL] 二重送信: useCompanion.ts L161-237 `send()` — busy更新の遅延+abort未設定で多重HTTPリクエスト
2. [CRITICAL] リップシンクのズレ: speech.ts L90-103 `processQueue` — 発話切替時にmouthLevel参照が前文/次文で二重写し
3. [HIGH] アイドル声かけ二重発火: useCompanion.ts L87,L120-132 `resetIdleTimer`/`maybeResumeListening` — タイマcleanup漏れで2回発火
4. [HIGH] 視線固定残留: viewer.ts L225-230 `notice`, L365-422 `updateGaze` — attentionUntilが発話ごとに延長され会話終了後も睨み続ける
5. [HIGH] 表情とまばたきの非同期ズレ: viewer.ts L215-218 `relax`, L284-318 `updateBlink` — relax直後に目を瞑った状態で真顔に戻る
6. [HIGH] 聞き取り再開タイマー重複: useCompanion.ts L140-151,L271-314 — toggleVoiceMode時にclearTimeoutが効かずタイマ二重
7. [MEDIUM] SSE中断後にonDone未呼出: api.ts L85-87, useCompanion.ts L209-225 — abort時にaffinity/stageのfront/backずれ
8. [MEDIUM] IME変換中Enterの処理漏れ(該当ロジック未発見、要追加調査)
根本原因: chat送信→TTSキュー→VRM表情/視線の3フェーズがuseRef経由のclosureで結合され、状態粒度が不統一。

## Recon: worker(本番API)の不具合候補(2026-06-22, code-explorer調査)
- 確定: 本番はCloudflare Worker(worker/)。backend/(FastAPI)は参考実装で非本番。
- エンドポイント: auth/signup,login,profile,chat,nudge,diary/generate (POST) / auth/me,state,history,diary,tts,research/export (GET)
- レート制限: user 50/日, global 800/日, login 30/IP/日(index.ts:102-113)。認証: JWT HS256 30日TTL(auth.ts:89-96)
- [HIGH] index.ts:302 `generateDiary`の`complete()`呼び出しにcatchなし → LLM API失敗で500
- [MEDIUM] index.ts:313 `getTts`がsynthesize失敗をnullで黙殺、ユーザーに失敗通知なし
- [MEDIUM] index.ts:354-360 `readJson`がparse失敗時に空オブジェクトを返し検証をすり抜ける
- [LOW] index.ts:236-237 research/exportのトークンサイズ制限なし
- worker/にテスト(*.test.ts)が一切存在しない

## Recon: iOS(Networking/Audio/ViewModels/Avatar)の不具合候補(2026-06-22, code-explorer調査)
1. [HIGH] APIClient.swift:165-196 SSE受信中のパース失敗/切断がtry?で無音飲み込み→ユーザーは応答待ちで固まる
2. [HIGH] SpeechQueue.swift:63-65 `while isPlaying { sleep }`ポーリングがisPlaying=false不発時に永久デッドロック→キュー全体停止
3. [MEDIUM] CompanionViewModel.swift:61-62,76,120 placeholderIndexが非同期追加でズレ、誤位置への上書きの可能性
4. [MEDIUM] VRMAvatarView.swift:49,54 evaluateJavaScript()のエラー無視、感情更新がサイレントに破棄される場合あり
5. [MEDIUM] CompanionViewModel.swift:134-170 idleTimer/scheduleRelaxのMainActor外invalidate競合
6. [MEDIUM] APIClient.swift:30-40,159-163 429以外のステータスコード情報が失われ汎用エラーになる
7. [MEDIUM] APIClient.swift:18 timeoutIntervalForRequest=30秒がLLM生成/VRM読込に不十分な場合あり、resourceタイムアウト未設定
8. [LOW] RootView.swift:38-43 VRMフォールバック時の状態バインディングずれによる描画ちらつき

## Phase1 recon完了。優先度サマリ(全プラットフォーム横断)
最優先(CRITICAL, ユーザー体感に直結): frontend #1 二重送信 / frontend #2 リップシンクのズレ
次点(HIGH): worker generateDiary未catch / iOS SSEサイレント失敗 / iOS音声デッドロック / frontend 視線固定残留・声かけ二重発火・表情まばたき非同期

## TODO / progress(ループが更新)
- [x] Phase 1 recon完了
- [ ] Iteration 1: frontend 二重送信(useCompanion.ts)を修正
