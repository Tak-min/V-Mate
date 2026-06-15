# デプロイ手順 — シロ(Aikata)を無料で公開する

不特定多数が使える公開Webサービスとして、**原則 $0** で公開する手順。
構成: Render(無料Webサービス, Docker)+ Neon(無料Postgres)+ Groq(無料LLM)。

## 前提(アカウント作成が必要 — これだけは本人が行う)

| サービス | 用途 | 取得物 |
|----------|------|--------|
| [GitHub](https://github.com) | コード置き場 | リポジトリ |
| [Groq](https://console.groq.com) | LLM(無料) | `LLM_API_KEY`(gsk_…) |
| [Neon](https://neon.tech) | Postgres(無料・永続) | `DATABASE_URL` |
| [Render](https://render.com) | ホスティング(無料) | 公開URL |

> 音声(ElevenLabs)は無料枠が極小のため公開では既定オフ。使う場合のみ末尾参照。

## 手順

### 1. GitHub に push
```bash
cd ~/Desktop/aikata
git push -u origin feat/public-multiuser-deploy   # または main にマージして push
```

### 2. Neon で Postgres を作成
1. Neon でプロジェクト作成 → 接続文字列(`postgresql://...?sslmode=require`)をコピー。
2. これを後で Render の `DATABASE_URL` に設定する(コードが自動でテーブルを作成)。

### 3. Render でデプロイ(Blueprint)
1. Render → **New → Blueprint** → 本リポジトリを選択(`render.yaml` を自動検出)。
2. デプロイ時に、`sync:false` の環境変数を入力:
   - `LLM_API_KEY` = Groq のキー(gsk_…)
   - `DATABASE_URL` = Neon の接続URL
   - `JWT_SECRET` は自動生成される。
3. **Create** → Docker ビルド(フロント→バック)が走り、数分で公開URLが発行される。

### 4. 動作確認
- 公開URLを開く → シロが表示され、匿名でもすぐ話せる。
- 「ログイン / 登録」から登録 → 端末を越えて記憶が継続。匿名中の会話も引き継がれる。

## コスト/不正利用ガード(実装済み)

- LLM/音声のキーはすべて**サーバ保持**(クライアントに露出しない)。
- チャット: **1ユーザー 50回/日**、**全体 800回/日**(Groq無料1000/日を保護)。超過は丁寧に 429。
- ログイン試行: **IP 30回/日**(ブルートフォース抑止)。
- 公開 TTS は既定オフ(`ENABLE_TTS=false`)。

調整は Render の環境変数 `RATE_PER_USER_PER_DAY` / `RATE_GLOBAL_PER_DAY` で可能。

## 音声を有効にする場合(任意・無料枠注意)

Render の環境変数に追加:
```
ENABLE_TTS=true
ELEVENLABS_API_KEY=<ElevenLabsのキー>
```
ElevenLabs 無料枠は月あたりの文字数が小さいため、公開での常時ONは非推奨。

## ローカルで動かす(参考)
```bash
cd backend && cp .env.example .env   # LLM_API_KEY を記入、ENABLE_TTS=true 等
./..../start.sh                       # or: uvicorn app.main:app --port 8080
```
`DATABASE_URL` 未設定ならローカル SQLite(`backend/data/aikata.db`)で動く。
