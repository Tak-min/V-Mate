# VISION — 継続利用UX(エンゲージメント/リテンション)自律改善ループ

> loop-engineerアンカー。第2ラウンド(2026-06-23)。前段=`.loop/UIUX_VISION.md`
> (3Dアバターのアイドルモーション/瞬き/呼吸+UI温かみマイクロインタラクション、完了済み)。
> 本ラウンドはユーザー要望「自律的に改善点を検出し、UI/UX特にUXを改善して、
> ユーザが継続的に話したいと思えるコンパニオンに昇華させてほしい」に対応する。

## モード・停止条件
- ヘッドレス。`loop-engine.sh`で最大反復数(本ラウンドはタスク数8件のため**15**に設定)
  or 3反復連続無進捗で自動停止。
- Definition of Done: 下記バックログ8件のうち**フロントエンドのみのタスク(1,2,3,6,7,8)を
  全て完了**し、バックエンド変更を伴うタスク(4,5)は実装できた分だけ完了とする
  (worker側のtsc/型チェックも緑であることが前提)。8件全完了が理想だが、フロントのみで
  6件完了かつビルド緑でもDoDは満たされたとみなしてよい(エンゲージメント効果の主要部分は
  フロントのみタスクで実現できるため)。

## 前回の反省(重要 — 今回のverifyスクリプトに反映済み)
前回ループは`uiux_verify.sh`の出力に`vite build`の実行時間("built in 1.23s"等)が含まれ、
反復ごとに微妙に変わるため、claude -pがセッション利用上限でno-opになった後も
verify出力のハッシュが毎回変わってしまい、loop-engine.shのno-progress検知
(同一ハッシュ3回連続)が機能せず20反復を消化して停止した。
**今回の`ux_verify.sh`は時間/サイズ等の非決定的な行を出力から除外し、
「ビルド成否」「backlog残数」のみを安定出力する**ことで、claude -pが本当に
no-opになった場合は3反復で正しく停止するようにする。

## バックログ(planner/opusブループリント, 2026-06-23確定、影響度順)

対象ファイル(主): `frontend/src/components/{ChatPanel,StatusBar,VoiceControl}.tsx`,
`frontend/src/features/chat/{useCompanion.ts,api.ts,types.ts}`,
`frontend/src/styles/global.css`, `worker/src/{chat.ts,index.ts,persona.ts,db.ts}`。

1. **[純フロント]動的な会話の呼びかけ** — `ChatPanel.tsx`の静的`STARTER_PROMPTS`を、
   時間帯・`state.stage`・新規/再訪に応じた`buildStarters(state, now)`関数に置き換える。
   `state: CompanionState | null`をPropsに追加。既存`chat-suggestion-chip`markup/CSSは流用。
2. **[純フロント・バグ修正]親密度バーの進捗を正しくする+次段階プレビュー** —
   `StatusBar.tsx`の`progress = affinity / next_stage_at`は絶対しきい値に対する比率になっており、
   段階内の進捗として誤っている(例: affinity30/next_stage_at50で60%表示だが実際は
   20→50の段の33%地点)。`worker/src/persona.ts`の`AFFINITY_STAGES`しきい値[0,20,50,100,200]を
   ミラーした`STAGE_FLOORS`定数を`StatusBar.tsx`に追加し、現在の段内での進捗に直す。
   「あと20で『友達』」のような次段階ラベルも追加。
3. **[純フロント、タスク2に依存]段階アップの小さな祝福** — `state.stage`が変化した瞬間
   (`useRef`で前回値と比較)だけ、`.affinity-fill`に一度きりのシマー/拍動+
   控えめな一言テキストを出す。初回マウントや同段階内の数値変化では発火しないこと。
   `prefers-reduced-motion`ブロックを尊重。
4. **[要バックエンド・読み取りのみ]「覚えている」ことをチャット欄に見せる** —
   既存`listFacts()`(`worker/src/db.ts`)を使い、`statePayload()`(`worker/src/chat.ts`)に
   `recent_facts?: string[]`を追加(新規スキーマ/エンドポイント不要)。
   `CompanionState`型に追加し、`ChatPanel.tsx`の空状態に1〜2件のさりげない
   「覚えていること」チップを表示。フィールド未存在時も壊れないこと(後方互換)。
5. **[要バックエンド・読み取りのみ]再訪時の「おかえり」コンテキスト** —
   `worker/src/index.ts`の`postNudge`は既に`daysSince(lastSeen)`相当を計算しLLMプロンプトに
   渡しているが、クライアントには返していない。グリーティング応答のJSONに
   `days_away: number | null`を追加し、`useCompanion.ts`のグリーティング処理で受け取り、
   `days_away >= 2`の時だけ控えめな「おかえり」表示をする(プッシュ通知的な圧をかけない)。
6. **[純フロント、依存なし]音声モードの初回オンボーディング** — `VoiceControl.tsx`の
   `voice-hud`に、初回起動時のみ(`localStorage`フラグ)説明文
   (「話し終えたら少し待つと、シロが応えるよ。『とめて話す』で割り込めるよ」)を出す。
   2回目以降は出さない。
7. **[純フロント、依存なし]会話継続のフォローアップ提案** — ログが空でない・busy/voiceでない時、
   直前のassistant発話の`emotion`等から1〜2件のフォローアップチップを出し、
   「次に何を言うか」の無言の壁を減らす。タスク1(冷たい空状態)とは別物。
8. **[純フロント、依存なし]空状態での日記コールバック** — 既存`fetchDiary()`で
   最新の日記エントリを取得し、チャット空状態に「昨日の日記にこう書いたよ…」的な
   再訪フックを表示(タップで日記を開く/starterを送る)。プレーンテキストのみ表示
   (LLM/ユーザー由来文字列はdangerouslySetInnerHTML禁止)。

### 依存関係
- タスク2→3の順(3は2のSTAGE_FLOORS/STAGE_NAMESを再利用)。
- タスク1,6,7,8は独立。タスク4,5はそれぞれ独立(バックエンド変更は最小・読み取り専用)。
- タスク2は既存ロジックのバグ修正のため、実装後に`react-reviewer`または
  `typescript-reviewer`(sonnet)レビューを必須とする。タスク4,5もバックエンドAPI変更を
  伴うため同様にレビュー必須。

## 制約
- フロントのみのタスクを優先(リスクが低く検証しやすい)。新規DB table/endpoint禁止。
  push通知禁止。実機/マイクテスト不要(ビジュアル推論+ビルド緑で十分)。
- 既存の3Dアバターモーション作業(`.loop/UIUX_VISION.md`)を再度触らない(スコープ外)。
- LLM/ユーザー由来の文字列(日記本文・facts)は必ずプレーンテキストとして表示し、
  `dangerouslySetInnerHTML`を使わない。
- バックエンド変更は既存store method(`listFacts`/`daysSince`等)の読み取りのみで、
  新規マイグレーション・新規エンドポイントは作らない。フィールドは必ずoptionalにして
  既存クライアントとの後方互換を保つ。

## Definition of Done チェックリスト
- [ ] タスク1,2,3,6,7,8(純フロント6件)が完了し、`cd frontend && npx tsc --noEmit -p . && npx vite build`が緑。
- [ ] タスク2のバグ修正と、タスク4/5のバックエンド変更はreviewer(sonnet)でCRITICAL/HIGH無し。
- [ ] タスク4,5は実装できた範囲で良い(バックエンド変更のため難易度が高ければスキップ可、
      ただしスキップ理由を`.loop/UX_state.json`に明記すること)。
- [ ] 反復ごとに`.loop/UX_state.json`を更新し、checkpointコミット。
- [ ] 15反復 or 3反復連続無進捗で停止し、結果を`.loop/ux/report.md`にまとめる。

## 進捗ログ
- [x] Phase 0: アンカーファイル作成(本ファイル)
- [x] Phase 1: recon (planner/opusブループリント受領)
- [ ] Phase 2: ヘッドレスループ実行
- [x] タスク1完了: `ChatPanel.tsx`の`STARTER_PROMPTS`を`buildStarters(state, now)`に置き換え。時間帯(朝/日中/夕方/夜)とstage(はじめまして=新規 / それ以降=既知)で呼びかけ文を切り替え。`App.tsx`から`state`をPropsで渡すよう変更。build green。
- [x] タスク2完了: `StatusBar.tsx`の親密度バー進捗バグを修正。`worker/src/persona.ts`の`AFFINITY_STAGES`をミラーした`STAGE_FLOORS`/`STAGE_NAMES`を追加し、絶対比率(affinity/next_stage_at)ではなく現在ステージ内での進捗に直した。「あと20で『友達』」的な次段階ラベルも追加。react-reviewer(sonnet)でCRITICAL/HIGH無しを確認。build green。
- [x] タスク3完了: `state.stage`の変化を`useRef`で検知し、初回マウント時は発火しないようにした上で、段階アップ時のみ2.4秒間`.affinity-fill`にbox-shadowパルスアニメーション(`.affinity-fill-stage-up`)+「『{stage}』になったよ」の一言テキストを表示。`prefers-reduced-motion`ブロックに追加済み。build green。
- [x] タスク6完了: `VoiceControl.tsx`の`voice-hud`に、初回起動時のみ`localStorage`フラグ(`vmate.voiceOnboardingSeen`)を見て説明文(「話し終えたら少し待つと、シロが応えるよ。『とめて話す』で割り込めるよ」)を表示。2回目以降は出さない。`global.css`に`.voice-onboarding`スタイル追加。build green。
- [x] タスク4完了: `worker/src/chat.ts`の`StatePayload`にoptionalな`recent_facts?: string[]`を追加し、既存`listFacts()`を読み取るだけで実装(新規DB/エンドポイント無し、空時はundefinedで省略され後方互換)。`CompanionState`型にミラーし、`ChatPanel.tsx`の空状態に「覚えていること」chip(plain textのみ、dangerouslySetInnerHTML不使用)を最大2件表示。typescript-reviewer(sonnet)でCRITICAL/HIGH無しを確認。build green。
- [x] タスク5完了: `worker/src/index.ts`の`postNudge`が既に計算していた`daysSince(lastSeen)`を`days_away: number | null`としてJSON応答に追加(新規DB/エンドポイント無し、既存クライアントは未知フィールドを無視するため後方互換)。`api.ts`/`useCompanion.ts`/`App.tsx`経由で`ChatPanel.tsx`に渡し、`days_away>=2`の時だけplain textの「おかえり」表示(dangerouslySetInnerHTML不使用)。typescript-reviewer(sonnet)でCRITICAL/HIGH無しを確認(MEDIUM指摘のstale banner問題は対応済み)。build green。
- [x] タスク7完了: `ChatPanel.tsx`に`FOLLOW_UP_PROMPTS`(Emotion別の相槌+深掘り質問)と`buildFollowUps(messages)`を追加。直前のassistant発話のemotionに応じてフォローアップチップを表示し、ログが空でない・busy/voiceモード中でない時のみ表示(`voiceMode`をApp.tsx経由でChatPanelに新規propとして渡すよう変更)。タスク1の空状態starterとは別物。`global.css`に`.chat-follow-ups`(既存chipスタイル流用)を追加。純フロントタスクのためreviewer省略。build green。
- [x] タスク8完了: `ChatPanel.tsx`マウント時に既存`fetchDiary()`を呼び最新の日記エントリを取得し、チャットログが空の時だけ「{日付}の日記にこう書いたよ」+本文プレビュー(36文字、プレーンテキストのみ、`dangerouslySetInnerHTML`不使用)を`.chat-diary-callback`ボタンとして表示。タップで`App.tsx`から渡した`onOpenDiary`(`setDiaryOpen(true)`)経由で日記ドロワーを開く。`global.css`に`.chat-diary-callback`系スタイルを追加。純フロントタスクのためreviewer省略。`bash .loop/ux_verify.sh`でbacklog remaining 0を確認、純フロント6件+バックエンド2件の全8タスク完了、DoD達成。
