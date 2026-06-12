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
| 音声+リップシンク | ChatVRM | AivisSpeech(あれば)/ブラウザTTS。音量解析で口が動く |

## 構成

```
backend/   FastAPI — チャット(SSE)・記憶・日記・親密度・TTSプロキシ
frontend/  Vite + React + three.js + @pixiv/three-vrm — VRM表示・UI
```

- **LLM**: Gemini(APIキーがあれば)/ Ollama qwen3:8b(ローカル、キー不要)
- **TTS**: AivisSpeech Engine(起動していれば)/ Web Speech API フォールバック
- **モデル**: `frontend/public/models/shiro.vrm` + VRoid 待機モーション5種(.vrma)

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
cp .env.example .env   # 必要ならAPIキーを記入(無くてもOllamaで動く)

# フロントエンド
cd ../frontend
npm install
npm run build          # backend/static に出力され、:8080 で配信される
```

## 設定 (backend/.env)

| 変数 | 説明 |
|------|------|
| `AIKATA_PROVIDER` | `auto`(既定)/ `ollama` / `gemini` |
| `GEMINI_API_KEY` | あれば Gemini を使用 |
| `OLLAMA_MODEL` | 既定 `qwen3:8b`(4bは思考漏れがあるため非推奨) |
| `AIVIS_SPEAKER` | AivisSpeech の話者ID |

## データ

会話・記憶・日記・親密度はすべて `backend/data/aikata.db`(SQLite)にローカル保存。
リセットしたいときはこのファイルを消すだけ。
