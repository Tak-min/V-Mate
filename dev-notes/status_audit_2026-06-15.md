# Aikata(シロ)開発状況 監査ログ — 2026-06-15

> 目的: 「V-Mate を v-mate-reborn として作り直し、さらに改善したもの」がどこにあり、
> どこまで出来ているのかを実証ベースで確定させた記録。次のエージェントが冷えた状態から読んでも迷わないこと。

## 結論(1行)

**改善版 = この `~/Desktop/aikata`(3D AI コンパニオン「シロ」)。初期実装は完成・実働しており、未完成(途中)の機能は無い。**

## ディレクトリの系譜(混乱しやすいので明記)

| 場所 | 正体 | 状態 |
|------|------|------|
| `~/Desktop/_archive_companion_20260612/V-Mate` | 初代 V-Mate | アーカイブ済み |
| `~/Desktop/_archive_companion_20260612/v-mate-reborn` | Rust + React で作り直した版 | アーカイブ済み(2026-06-12 退避) |
| `~/Desktop/aikata` | **現行の改善版「シロ」**(FastAPI + three-vrm に作り直し) | **アクティブ・完成** |
| `~/Desktop/v-mate-reborn` | 中身 0 ファイルの空ディレクトリ(`data/audio` の空フォルダのみ) | **抜け殻。コードは無い** |
| `~/Desktop/ar-companion` | 肩乗りAI×DIYグラスの別企画(2026-06-13〜) | 別プロジェクト |

→ 「改善されたものを探す」ときに `~/Desktop/v-mate-reborn` を見ると空で混乱する。**実体は `aikata`**。

## 実証した完成度(2026-06-15 時点)

- フロント型チェック `npx tsc --noEmit` → **exit 0**(エラー無し)
- バックエンド `from app import main` → **import OK**、全12 API ルート登録済み
- `uvicorn` 起動 → `/api/state` 200・`/`(ビルド済みフロント配信)200
- 依存環境: Ollama 稼働(`qwen3:8b` 在り)、`.env` に `GEMINI_API_KEY` あり → provider=`gemini`
- ビルド成果物 `backend/static/` 生成済み、VRM(`shiro.vrm` 17MB)+ 待機モーション5種(.vrma)在り
- **実使用の痕跡あり**: `aikata.db` に messages 18 / facts 6 / diary 1 / kv 3、affinity=7(stage「はじめまして」)、user_name「たくみん」
- git: 1 コミット(`feat: Aikata — 3D AIコンパニオン「シロ」初期実装`)、working tree クリーン

## README が謳う「親近感6機能」の結線監査(全て end-to-end で実装確認)

1. **永続記憶** — `main._extract_facts`(6発言毎にバックグラウンド抽出)→ `memory.add_fact` → `persona.build_system_prompt` に注入 ✓
2. **親密度システム** — `persona.AFFINITY_STAGES`(5段階)→ `memory.add_affinity`(1発言+1、当日初回+5)→ 口調がプロンプトに反映 ✓
3. **シロの日記** — `/api/diary` `/api/diary/generate`(当日4発言以上で生成可)→ `DIARY_PROMPT` ✓
4. **自発的声かけ** — `/api/nudge`(greeting/idle)、フロントは起動時挨拶+放置120秒で idle nudge ✓
5. **感情表現** — 応答冒頭 `[happy]` 等のタグ → SSE で `emotion` 先出し → `viewer.setEmotion`(表情ブレンド+モーションcrossfade+まばたき+視線追従) ✓
6. **音声+リップシンク** — `/api/tts`(AivisSpeech プロキシ)→ 無ければ Web Speech API、`speech.ts` が実音量/擬似で口を駆動 ✓

## 技術メモ / ハマりどころ(次の人向け)

- **qwen3 の思考漏れ**: `think:false` だけでは `<think>...</think>` が本文に混ざる。対策が二重に入っている:
  (a) system プロンプト末尾に `/no_think` ソフトスイッチ(`llm._stream_ollama`、qwen3 のときだけ付与)、
  (b) ストリーム側 `llm.ThinkFilter` でタグ跨ぎ対応の除去。**4b は思考漏れがひどく非推奨、8b 運用が前提**。
- **感情タグのバッファリング**: `main.chat` は先頭の `[emotion]` が確定するまでトークンを溜め、確定後にまとめて流す(24文字超で諦めて neutral)。表情を本文より先に出すための意図的設計。
- **TTS フォールバック**: AivisSpeech(:10101)未起動なら `tts.synthesize` が None → 204 → フロントが speechSynthesis に自動切替。エンジン無しでも喋れる。
- **起動**: `./start.sh`(初回は venv 作成 + フロント build を自動実行)→ http://localhost:8080。開発時はフロント別起動 `cd frontend && npm run dev`(:5173、CORS 許可済み)。
- **リセット**: `backend/data/aikata.db` を消すだけで記憶・親密度・日記が初期化される。

## 残課題(完成済みなので「途中」ではない。任意の改善候補)

- ~~自動テスト 0 件~~ → 2026-06-15 に要約機能分のテスト基盤(pytest)を追加(下記)。他機能のテストは未。
- README 以外のドキュメントが無かった → 本ファイルで一部補完。
- 親密度は単調増加のみ(放置で下がる等の減衰は無い)。仕様判断が必要なので未着手。

---

# 追記 2026-06-15: 会話の要約圧縮(ローリング要約バッファ)を実装

## 背景 / なぜ必要だったか

`main.chat` は履歴を `recent_messages(24)` の固定窓でしか LLM に渡しておらず、会話が長期化すると
窓から溢れた古い文脈が完全に失われていた(事実は `facts` に残るが「話の流れ・未完の話題・関係性の変化」は消える)。
LangChain の ConversationSummaryBuffer に相当する**ローリング要約バッファ**で補った。

## 設計(採用した方式と理由)

- 直近 `HISTORY_WINDOW=24` 件は従来どおり**逐語**で LLM に渡す。
- 窓から溢れた古いメッセージは、`SUMMARY_CHUNK=16` 件たまるごとに**要約へ畳み込む**。
- 要約は `kv.conversation_summary` に保存し、`build_system_prompt` の「## これまでの会話の流れ(要約)」節へ注入。
- どこまで要約済みかは `kv.summary_through_id`(メッセージ id)で管理 → 二重要約を防ぎ、毎回先頭から要約し直さない。
- 要約は `facts` と役割分担: facts=確定事実(名前・好み)、summary=会話の流れ・感情・未完の話題。
- **LLM 呼び出しは閾値到達時のみ**。普段は軽量クエリ2発(through_id 取得 + 件数確認)で即 return。
- チャットの**バックグラウンドタスク**として実行(応答ストリームをブロックしない。`_extract_facts` と同じ流儀)。

## 触ったファイル

- `backend/app/memory.py`: `messages_to_summarize(after_id, keep_recent)` / `get_summary` / `get_summary_through_id` / `set_summary` を追加。
- `backend/app/persona.py`: `SUMMARY_PROMPT` 追加、`build_system_prompt(..., summary="")` に要約節を追加(空なら節ごと出さない)。
- `backend/app/main.py`: 定数 `HISTORY_WINDOW/SUMMARY_CHUNK/SUMMARY_MAX_CHARS`、`_summarize_old_history()`、chat で summary 注入 + background 登録。
- `backend/tests/`(新規)+ `pytest.ini` + `requirements-dev.txt`: pytest 基盤を新設。

## ハマりどころ / 注意

- **境界 SQL**: 要約対象 = `id > after_id AND id < (直近 keep_recent 件の最小 id)`。`<=` にすると窓の境界メッセージを二重に含む。総数 ≤ 窓のときはサブクエリ最小 id が全体最小になり対象 0 件(正しい)。
- **感情タグ混入**: qwen3 等が要約にも `[happy]` を付けることがあるため `_strip_emotion` を通してから保存。
- **LLM 失敗時**: `_summarize_old_history` は例外を握りつぶし `through_id` を**進めない** → 次回チャットで自動再試行。
- **しきい値の体感**: 既定だと 24+16=40 メッセージ目で初回要約。テストでは `main.HISTORY_WINDOW/SUMMARY_CHUNK` を monkeypatch で小さくして検証。

## 検証(2026-06-15)

- `pytest -q` → **11 passed**(境界4 / ストア往復 / プロンプト注入有無 / 閾値スキップ / 畳み込み / 旧要約統合 / LLM失敗据え置き)。
- 実 LLM(Ollama qwen3:8b)で隔離 DB に試験会話10件を投入し窓2/閾値4で強制畳み込み → 試験の不安・微分が苦手・バスケ引退試合・勝ちたい意気込み・シロの応援を保持した自然文要約を生成、`through_id` も正しく前進。本番 `aikata.db` は不変更。
- フロントは未変更(要約は不可視の文脈として効くだけ)。

---

# 追記 2026-06-16: 公開Webサービス化(Phase A〜F)+ Groq移行

LLM を Groq(OpenAI互換)へ移行し、不特定多数向け公開サービスとして実装。branch `feat/public-multiuser-deploy`。
Groqキーは別プロジェクト(~/youtube-ai-pipeline/docker/.env の GROQ_API_KEY_MOTIVATION)から流用。

## 構成判断(ユーザーのプロフィール反映: 無料・学生・自律)
- LLM=Groq(無料/高速/OpenAI互換), DB=Postgres(Neon無料)/SQLite両対応, ホスト=Render無料Docker, 認証=email+JWT, 公開TTS既定オフ。

## フェーズ
- A: memory を user_id スコープ化 + 匿名Cookie ID middleware + 旧DB→'local'移行
- B: SQLAlchemy Core 化(DATABASE_URL=Postgres / 既定SQLite)
- C: 認証(bcrypt直 + PyJWT)。匿名データを signup でアカウントへ昇格
- D: レート制限(user50/全体800/login30 per day)+ TTSゲート(ENABLE_TTS)+ CORS env
- E: フロント認証UI(api.ts集約 / AuthBar / localStorageトークン)
- F: Dockerfile(フロント→バック多段)+ render.yaml + DEPLOY.md

## ハマりどころ(Symptom → Cause → Fix)
- **passlib が bcrypt で例外** `module 'bcrypt' has no attribute '__about__'`: passlib1.7 が bcrypt>=4.1 と非互換 → **bcrypt を直接利用**(passlib撤去、72バイト切詰)。
- **JWT InsecureKeyLengthWarning**: HS256鍵が32バイト未満 → dev既定鍵を長く。本番は `JWT_SECRET` を必須(render.yaml は generateValue)。
- **旧DB移行で `no such column: user_id`**: init_db が新スキーマのindex(user_id)を旧テーブルに先に作ろうとした → **移行(rename)を create より先**に。SQLAlchemy版では sqlite かつ旧スキーマ時のみ raw sqlite3 で rename→create_all→copy。
- **テストで engine が古いDBを掴む**: SQLAlchemy engine をモジュールで保持 → `init_db()` で `_reset_engine()` して monkeypatch 後の DB_PATH を反映。
- **vite outDir=../backend/static**: Docker は frontend ステージで `/app/backend/static` に出力 → backend ステージへ COPY。dev は vite proxy で /api 同一オリジン(Cookie が効く)。
- **レート制限テストが実Groqを叩く**: 上限0にして最初の1回で429 → LLM未呼び出しで検証。

## 検証(2026-06-16)
- pytest 24 passed / tsc 0 / frontend build OK。
- 実Groq end-to-end(TestClient): 匿名state→signup→me→**実チャット応答(自然な日本語)**→別匿名は履歴0(分離)。
- Docker実ビルドは未ローカル実行(Render側に委譲)。

## 残(本人のアカウント操作のみ)
GitHub push → Neon作成(DATABASE_URL)→ Render Blueprint デプロイ。手順は `DEPLOY.md`。

---

# 追記 2026-06-15(その2): クラウド一本化 — ローカル実行を全廃

## 方針(ユーザー決定)

- **LLM**: Gemini(`generativelanguage.googleapis.com`)のみ。Ollama 等のローカルモデルは全廃。
- **TTS**: ElevenLabs(クラウド、MP3)。ローカルの AivisSpeech は全廃。
- **フォールバック**: ブラウザ読み上げ(Web Speech API)も**完全削除**(純クラウド)。クラウドTTS失敗時は無音(テキストのみ)。

## 触ったファイル / 変更点

- `backend/app/llm.py`: Ollama 経路・`ThinkFilter`・`/no_think`・`AIKATA_PROVIDER` 自動切替を削除。Gemini ストリーミングのみに。`GEMINI_API_KEY` 必須化(`_require_api_key` が未設定時に明確なエラー送出)。`provider()` は `gemini:<model>` を返す表示用に変更。
- `backend/app/tts.py`: AivisSpeech プロキシ → ElevenLabs(`POST /v1/text-to-speech/{voice_id}`、`xi-api-key`、`eleven_multilingual_v2`)。キー未設定・失敗時は `None`。
- `backend/app/main.py`: `/api/tts` の `media_type` を `audio/wav` → `audio/mpeg`(MP3)。チャットのエラーメッセージから Ollama 文言を削除。
- `frontend/src/features/voice/speech.ts`: `playFromBrowser` / `speechSynthesis` / 擬似リップシンク(`fakeTalking`)を削除。クラウドMP3を Web Audio で再生し**実音量**でリップシンクのみ。`stop()` は現在の `AudioBufferSourceNode` を停止する方式に。
- `backend/.env` / `.env.example`: `AIKATA_PROVIDER` / `OLLAMA_*` / `AIVIS_*` を削除、`ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL` を追加。
- `README.md`: LLM/TTS/設定表をクラウド構成に更新。

## ハマりどころ / 注意

- **Symptom**: `.env` の `GEMINI_API_KEY` がプレースホルダ(`your_gemini_api_key_here`)なのに Gemini が動く。
  **Cause**: `load_dotenv()` は既定で**既存のシェル環境変数を上書きしない**。実キーはシェル側(export)にあり、それが使われていた。
  **Fix/Workaround**: `.env` のプレースホルダは保持しつつ実害なし。新規環境では `GEMINI_API_KEY` をシェルか `.env` に入れる。`ELEVENLABS_API_KEY` も同様。
- **MP3 再生**: フロントは `decodeAudioData` で MP3 をそのままデコードできる(WAV から変更しても可)。`media_type` は `audio/mpeg` に合わせた。
- **自動再生制約**: 起動直後の挨拶音声はブラウザの autoplay 制約で、ユーザー操作前は鳴らないことがある(テキストは表示される)。仕様上の制約で、ローカル廃止に伴うものではない。
- **ElevenLabs プレースホルダキー**: 値が入っている(truthy)と実リクエストして 401 → `None`。キー未設定(空)なら即 `None`。どちらも無音で安全。

## 検証(2026-06-15)

- backend import OK / `provider()` = `gemini:gemini-2.5-flash`。
- コード上の `ollama|aivis|speechSynthesis|ThinkFilter|no_think` 参照は**ドキュメント説明文のみ**(実コードからは消滅)。
- `pytest -q` → **11 passed**(要約系テストは LLM をモックするため影響なし)。
- フロント `tsc --noEmit` → exit 0。
- 実 API: `llm.complete("…")` が Gemini で「こんにちは」を生成(クラウド実働)。`tts.synthesize`(キー無し)→ `None`(無音フォールバック)を確認。
