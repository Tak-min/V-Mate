# Cloudflare 全面移行 開発ログ — 2026-06-17

本番バックエンド(`backend/` FastAPI/Python)を **Cloudflare Workers + D1(TypeScript)** に全面移植した。
公開ホスティングを無料・DB永続で実現するのが目的。新規実装は `worker/`。

## なぜ Cloudflare(と、その代償)

ホスティング無料枠を実地調査(2026-06)した結論:

- **Render 除外**(ユーザー要件): 無料 Postgres が一定期間で失効 → DBが消える。
- **Fly.io / Koyeb**: 2026年に**無料コンピュート枠を廃止**。新規はCC必須・実質有料。
- **Google Cloud Run**: 無料枠は良好(既存Dockerfileがほぼそのまま動く)。技術的には最有力だった。
- **Cloudflare Workers 無料**: Python は Pyodide ベースで未成熟、かつ **CPU 10ms/req 制限**で
  psycopg/bcrypt/長時間サーバが動かない。→ **Python のままでは無料Cloudflareに乗らない。**

ユーザー判断で「Cloudflare に全面書き換え」を選択。よって **TypeScript で書き直し**、
DB は Cloudflare ネイティブの **D1(SQLite)** を採用(永続・無料・無期限・無操作でも消えない)。

## アーキテクチャ(全Cloudflare・単一オリジン)

```
Worker(aikata)
├─ run_worker_first: ["/api/*"]  → /api/* は Worker、それ以外は ASSETS(Viteビルド)
├─ ASSETS binding                → backend/static(既存ビルド成果物を再利用)
├─ D1 binding(DB)               → messages/facts/diary/kv/usage/users
└─ fetch                         → Groq(LLMストリーミング)/ ElevenLabs(任意)
```

フロントは**無改修**。相対パス `/api/*` + `credentials:'include'` のままで、単一オリジン配信のため
Cookie(匿名ID)も SSE もそのまま機能する。Python の各 .py をエンドポイント単位で忠実移植し、
SSE のワイヤ形式(`data: {json}\n\n`、type=emotion/token/done/error)とエラー本文 `{detail}` を一致させた。

## 落とし穴(Symptom → Cause → Fix)

### 1. bcrypt が使えない
- **Symptom**: bcrypt は意図的に ~100ms CPU を使う。
- **Cause**: Workers 無料枠は **CPU 10ms/req ハード制限**(`1102` で強制終了)。bcrypt は確実に超過。
- **Fix**: `src/auth.ts` で **WebCrypto PBKDF2-HMAC-SHA256**(ネイティブ実装)へ置換。反復回数
  `PBKDF2_ITERATIONS=50_000` は 10ms に収まる妥協値。強度を上げるなら Workers 有料(CPU上限30s)前提で増やす。
  保存形式 `pbkdf2$<iter>$<saltB64url>$<hashB64url>`。**既存 bcrypt ハッシュとは互換性なし**(本番は新規DBなので問題なし)。

### 2. CPU 10ms 制限と SSE/LLM は両立する
- **Cause**: 10ms は**CPU時間のみ**。`fetch` で LLM 応答を待つ間(I/O)や SSE のストリーミング時間は
  非カウント(HTTPストリーミング時間は無制限)。
- **結論**: チャット(LLMプロキシ)・D1クエリ(I/O)は問題なし。CPUを食うのは PBKDF2 と JSON 処理くらい。

### 3. FastAPI BackgroundTasks 相当 → `ctx.waitUntil`
- **Symptom**: 応答後に走る事実抽出・会話要約をどう実行するか。
- **Fix**: `execCtx.waitUntil(promise)` で応答後も Worker を生かして実行(`src/chat.ts`)。
  チャットは TransformStream を返しつつ、生成〜永続化〜バックグラウンド処理を 1 つの waitUntil promise 内で完結させる。

### 4. 時刻が UTC になり「今日」判定がずれる
- **Symptom**: Python は naive な現地時刻(JST想定)で「その日最初の会話」「日記の日付」「時間帯あいさつ」を判定。
  エッジは UTC。
- **Fix**: `src/util.ts` で **JST(UTC+9)固定**ヘルパ(`jstToday`/`jstIso`/`timeContext`)。
  D1 の `created_at` は既定の `CURRENT_TIMESTAMP`(UTC)を使わず、**Worker が JST ISO 文字列を明示挿入**。
  `messagesOn` は `substr(created_at,1,10)=?`(JST日付)で比較。

### 5. ルーティングと静的アセットの取り合い
- **Symptom**: `/api/*` が index.html にフォールバックすると JSON でなく HTML が返る。
- **Fix**: `wrangler.jsonc` の `assets.run_worker_first: ["/api/*"]` で /api は必ず Worker 先行。
  それ以外は `not_found_handling: "single-page-application"` で index.html へ。Worker 側でも
  `!pathname.startsWith("/api/")` なら `env.ASSETS.fetch(request)` に委譲(二重の安全網)。

### 6. Cookie の Secure 属性とローカル http
- **Symptom**: `Secure` 付き Cookie は http://localhost で保存されない場合があり、ローカルで匿名IDが維持できない。
- **Fix**: `url.protocol === "https:"` のときだけ `Secure` を付ける(本番は https なので付与、wrangler dev では外す)。

### 7. D1 の upsert / RETURNING
- bump_usage は `INSERT ... ON CONFLICT(scope,day) DO UPDATE SET count=count+1 RETURNING count` を `.first()` で取得。
- set_kv / add_diary は `ON CONFLICT(...) DO UPDATE SET col=excluded.col`。
- add_fact の重複無視は `ON CONFLICT DO NOTHING`(UNIQUE(user_id,content))。
- reassign は `db.batch([...])` で複数 UPDATE をまとめて実行。

## 検証済み(ローカル wrangler dev + ローカルD1)

- 匿名Cookie発行/維持、`/api/state`、プロフィール設定、履歴。
- signup→JWT→`auth/me`、login(正/誤=401)、入力検証(400)、無効トークン→匿名フォールバック。
- **匿名→アカウントのデータ引き継ぎ(reassign)**:匿名時の user_name がアカウントに反映されることを確認。
- SSE フレーミングとエラーイベント(ダミーLLMキーで graceful error を確認)。
- TTS 既定オフ=204、静的 index 配信=200、未知API=404。
- `tsc --noEmit` パス。CI に worker 型チェックジョブを追加。

## 未検証・follow-up

- **実LLMキーでの本物のストリーミング**(感情タグのバッファリング挙動)は未検証。ロジックは Python の忠実移植
  だが、Groq 実キーでの `npm run dev` を一度通すのが望ましい。
- **本番デプロイ自体は未実行**(`wrangler login` が対話のためユーザー操作が必要)。手順は `worker/DEPLOY.md`。
  デプロイ前に `wrangler.jsonc` の `REPLACE_WITH_D1_DATABASE_ID` を実IDに差し替えること。
- PBKDF2 反復回数が 10ms に収まるかは本番計測で最終確認(超過時は値を下げる)。
- `backend/`(Python)は残置(ローカル/研究用の参照実装)。本番は `worker/`。
