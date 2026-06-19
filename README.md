# Aikata(アイカタ)— 3D AI コンパニオン「シロ」

パソコンの中に住む相棒「シロ」と話すローカルファーストな 3D AI コンパニオン。
ChatVRM・Replika・推し恋系アプリの調査をもとに、「親近感」を生む要素を統合した設計。

![stack](https://img.shields.io/badge/three--vrm-3.5-blue) ![stack](https://img.shields.io/badge/FastAPI-Python-green)

## 親近感を生む6つの仕組み

| 仕組み | 由来 | 実装 |
|--------|------|------|
| 永続記憶 | Replika | 会話からユーザーの事実を自動抽出し、以後の会話に反映(SQLite) |
| 親密度システム | 推し恋/Luvlinx | 会話で親密度が上昇。5段階で口調・距離感が変化(敬語→タメ口→相棒) |
| シロの日記 | Replika Diary | その日の会話を振り返ってシロが日記を書く |
| 自発的な声かけ | Replika | 起動時の挨拶+放置2分で時間帯・記憶を踏まえた一言 |
| 感情表現 | ChatVRM | `[happy]`等のタグ→VRM表情+モーション切替+まばたき+視線追従 |
| 音声+リップシンク | ChatVRM | Aivis Cloud API(クラウド)で合成。音量解析で口が動く |

## 研究モード: 身体様式の3条件比較

V-Mate は、論文用の実験プラットフォームとして **同一バックエンドで身体提示だけを変える** 構成を持つ。

| 条件 | URL例 | 操作するもの | 固定するもの |
|------|------|--------------|--------------|
| `text` | `/?condition=text` | 3D身体を非表示 | LLM、プロンプト、記憶、親密度、音声、チャットUI |
| `stylized` | `/?condition=stylized` | 二次元・可愛いVRM `shiro.vrm` | 同上 |
| `realistic` | `/?condition=realistic` | 写実寄りVRM `realistic.vrm` | 同上 |

URLで条件を指定しない場合、サーバが訪問者ごとに `text / stylized / realistic` を安定割付する。実験ログは `research_events` に保存される。

記録される主なデータ:

- `session_start`: 条件、割付方法、画面サイズ
- `chat_sent`: ユーザー発話の文字数、疑問数、自己開示っぽい語の有無
- `assistant_done`: AI応答の文字数、感情タグ
- `survey_response`: 社会的存在感、信頼、自己開示しやすさ、継続利用意図、使いやすさ、不気味さの1〜7評価

実験で主張するための重要な統制は、**条件によって LLM・記憶・親密度・音声を変えないこと**。`text` 条件でも音声は同じままにして、身体提示の有無/様式だけを比較する。

## 構成

```
backend/   FastAPI — チャット(SSE)・記憶・日記・親密度・TTSプロキシ
frontend/  Vite + React + three.js + @pixiv/three-vrm — VRM表示・UI
```

- **LLM**: OpenAI互換API(既定 Groq・無料/高速)。`LLM_BASE_URL` 差し替えで Cerebras/OpenRouter へ移行可。返答はストリーミングで逐次表示
- **TTS**: Aivis Cloud API(クラウド・APIキー必須)。文ごとに合成し逐次再生。キー未設定時は無音(テキストのみ)
- **モデル**: `frontend/public/models/shiro.vrm` + VRoid 待機モーション5種(.vrma)

> ローカルAI(Ollama)・ローカルTTSエンジン・ブラウザ読み上げは廃止し、すべてクラウドAPIに統一済み
> (音声合成は ElevenLabs から Aivis Cloud API へ移行済み、2026-06-19)。

## 起動

```bash
./start.sh
# → http://localhost:8080
```

開発時はフロントを別途 `cd frontend && npm run dev`(http://localhost:5173)。

### 初回セットアップ

```bash
# バックエンド
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env   # LLM_API_KEY と AIVIS_API_KEY を記入(クラウド必須)

# フロントエンド
cd ../frontend
npm install
npm run build          # backend/static に出力され、:8080 で配信される
```

## 設定 (backend/.env)

| 変数 | 説明 |
|------|------|
| `LLM_API_KEY` | **必須**。LLM の APIキー(既定 Groq。`GROQ_API_KEY` でも可) |
| `LLM_BASE_URL` | 既定 `https://api.groq.com/openai/v1`。OpenAI互換なら何でも可 |
| `LLM_MODEL` | 既定 `llama-3.3-70b-versatile`(日本語重視は `qwen/qwen3-32b` 等) |
| `AIVIS_API_KEY` | **必須**(音声を使う場合)。未設定なら無音。取得: https://hub.aivis-project.com/cloud-api/api-keys |
| `AIVIS_MODEL_UUID` | 声の指定。既定モデルUUID(`a59cb814-...`) |
| `AIVIS_SPEAKER_UUID` / `AIVIS_STYLE_NAME` | モデルに複数話者/スタイルがある場合の指定(任意) |
| `RESEARCH_ALLOW_CONDITION_OVERRIDE` | `?condition=` による条件指定を許可 |
| `RESEARCH_EXPORT_TOKEN` | `/api/research/export` を使う場合の秘密トークン |

## データ

会話・記憶・日記・親密度はすべて `backend/data/aikata.db`(SQLite)にローカル保存。
リセットしたいときはこのファイルを消すだけ。
