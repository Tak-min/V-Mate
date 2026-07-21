# デプロイ手順 — シロ(Aikata)を Cloudflare に無料で公開する

不特定多数が使える公開Webサービスとして、**原則 $0・全Cloudflare** で公開する手順。

構成: **Cloudflare Workers**(API + 静的フロント同居・単一オリジン)+ **D1**(SQLite・無料・**永続**)+ **Groq**(無料LLM)。
Render を使わないため「DBが一定期間で消える」問題は発生しない。D1 無料枠は 5GB・無期限。

```
ブラウザ ──▶ Cloudflare Worker(aikata)
              ├─ /api/*           → Worker(FastAPI 相当の TypeScript 実装)
              ├─ それ以外          → ASSETS(Vite ビルド済みフロント)
              ├─ D1(SQLite)       → 会話/記憶/日記/アカウント/レート制限
              └─ fetch ──▶ Groq(LLM ストリーミング)/ Aivis Cloud API(任意TTS)
```

## 前提(本人が用意するもの)

| サービス | 用途 | 取得物 |
|----------|------|--------|
| [Cloudflare](https://dash.cloudflare.com/sign-up) | ホスティング(無料) | アカウント。**クレジットカード不要** |
| [Groq](https://console.groq.com) | LLM(無料) | `LLM_API_KEY`(gsk_…) |

> 音声(Aivis Cloud API)はクレジット消費があるため公開では既定オフ。使う場合のみ末尾参照。

## 手順

すべて `worker/` ディレクトリで実行する。

### 0. 依存をインストール

```bash
cd ~/Desktop/v-mate/worker
npm install
npx wrangler login        # ブラウザが開く。Cloudflare にログイン
```

> `wrangler login` は対話ログインなので、Claude 経由ではなく**自分のターミナルで**実行する
> (このセッションなら入力欄に `! npx wrangler login` と打てばこの場で実行できる)。

### 1. D1 データベースを作成

```bash
npx wrangler d1 create aikata
```

出力された `database_id`(UUID)を **`wrangler.jsonc` の `REPLACE_WITH_D1_DATABASE_ID` に貼り付ける**。

### 2. スキーマを適用(本番 D1)

```bash
npm run db:init:remote      # = wrangler d1 execute aikata --remote --file=./schema.sql
npm run db:migrate-v3:remote # 年齢ゲート/通報テーブル。既存DBにも必ず適用
```

`schema_v3.sql` 未適用のまま新しいフロントを公開すると、年齢状態 API が 500 になり、
必須オンボーディングから先へ進めない。**Worker のデプロイより先に**上記2コマンドを完了する。

### 3. 秘密(シークレット)を登録

```bash
npx wrangler secret put LLM_API_KEY     # Groq のキー(gsk_…)を貼る
npx wrangler secret put JWT_SECRET      # 任意の長いランダム文字列(端末を越えたログイン維持に必要)
# 例: openssl rand -hex 32 で生成した値を貼る
```

`JWT_SECRET` を設定しないと再デプロイ/再起動でログイントークンが失効する(必ず設定する)。

### 4. デプロイ

```bash
npm run deploy        # フロントを build → backend/static に出力 → wrangler deploy
```

数十秒で `https://aikata.<あなたのサブドメイン>.workers.dev` が発行される。
開くとシロが表示され、匿名でもすぐ話せる。「ログイン / 登録」で端末を越えて記憶が継続する。

### 5. 設定の調整(任意)

`wrangler.jsonc` の `vars` で変更し、再 `npm run deploy`:

- `LLM_MODEL` — 既定 `llama-3.3-70b-versatile`。日本語重視なら Groq の Qwen 系等へ。
- `RATE_PER_USER_PER_DAY`(既定50)/ `RATE_GLOBAL_PER_DAY`(既定800)— Groq 無料 1000/日を保護。

## ローカルで動かす(参考)

```bash
cd ~/Desktop/v-mate/worker
printf 'JWT_SECRET=local-secret\nLLM_API_KEY=gsk_あなたのキー\n' > .dev.vars
npm run db:init:local          # ローカル D1 にスキーマ適用
npm run db:migrate-v3:local   # 年齢ゲート/通報テーブル
npm run dev                    # http://localhost:8787
```

`.dev.vars` は gitignore 済み(秘密をコミットしない)。

## コスト/不正利用ガード(実装済み)

- LLM/音声のキーはすべて**サーバ(Worker)保持**。クライアントに露出しない。
- チャット: **1ユーザー 50回/日**、**全体 800回/日**。超過は丁寧に 429。
- ログイン試行: **IP 30回/日**(ブルートフォース抑止)。
- 公開 TTS は既定オフ(`ENABLE_TTS=false`)。
- パスワードは PBKDF2-HMAC-SHA256(WebCrypto)でハッシュ化して D1 に保存。

## 音声を有効にする場合(任意・無料枠注意)

```bash
npx wrangler secret put AIVIS_API_KEY
# wrangler.jsonc の vars に "ENABLE_TTS": "true" を設定して再デプロイ
```

キー取得: https://hub.aivis-project.com/cloud-api/api-keys 。クレジット消費があるため、
公開での常時ONは利用量を見ながら判断すること。

## 無料枠の注意点(2026-06 時点)

- **Workers 無料枠は 1リクエストあたり CPU 10ms 制限**(I/O 待ち=LLM応答は非カウント、SSE のストリーミング
  時間そのものは無制限)。このため `signup`/`login` の PBKDF2 反復回数は `src/auth.ts` の
  `PBKDF2_ITERATIONS`(既定 50,000)で 10ms に収まる範囲に抑えている。`1102`(CPU超過)エラーが
  ログイン時に出る場合はこの値を下げるか、Workers 有料($5/月・CPU上限30s)に上げてから増やす。
- D1 無料枠: 5GB ストレージ・読取/書込とも個人利用には十分。無期限・無操作でも消えない。
