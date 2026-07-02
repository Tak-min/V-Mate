# 先代プロジェクト コードベース分析
date: 2026-06-30  
scope: V-Mate (original) / v-mate-reborn → 現 v-mate への転用候補

---

## 分析対象

| # | プロジェクト | リポジトリ | ローカルパス |
|---|------------|-----------|------------|
| 1 | **V-Mate (original)** | github.com/Tak-min/V-Mate | `~/Desktop/_archive_companion_20260612/V-Mate` |
| 2 | **v-mate-reborn** | github.com/Tak-min/v-mate-reborn | `~/Desktop/_archive_companion_20260612/v-mate-reborn` |
| 3 | **v-mate (現行)** | — | `~/Desktop/v-mate` |

---

## 1. V-Mate (original) — システム構成

```
[Flask + SocketIO (Python)] ←→ [Vanilla JS (three.js, CSS3DRenderer, VRM)]
        |
        ├── Gemini (LLM, primary + fallback モデル)
        ├── ElevenLabs TTS (asyncio.Queue + Semaphore)
        ├── AssemblyAI STT (upload→poll, 3s interval)
        ├── Google OAuth + JWT (access/refresh)
        └── SQLite (conversations, user_info, characters)
```

### 主要クラス (app.py, 1665行)

**MemoryManager**
- テーブル: `conversations(session_id, role, content, emotion, timestamp)` + `user_info`
- `get_conversation_history(session_id, limit=20)` — DESC取得→reverse で時系列に戻す
- スコープ: per-session (user_id + character_id の複合ではなく session_id 単体)

**TextSplitter** ← **転用候補 ①**
```python
# 第一段階: 文末句読点で分割
SENTENCE_ENDINGS = ['。', '！', '？', '.', '!', '?']
# 第二段階: 息継ぎポイントで再分割 (chunk_size=50超の場合)
BREATH_POINTS = ['、', ',', '…']
# split_for_streaming(text) → List[str]
```
二段階分割の考え方は v-mate-reborn Rust 実装と同一。現 v-mate は一段階のみ。

**ElevenLabsQueue** ← **転用候補 ③ (参考)**
- `asyncio.Queue + asyncio.Semaphore(3)` でサーバ側並行制御
- SocketIO `message_chunk` イベントでクライアントへチャンク送信
- 現 v-mate はクライアント側 SpeechQueue + prefetch で同等を実現済み

**AIConversationManager**
- Gemini 一次/フォールバックモデルの自動切り替え
- `generate_response_streaming()` → `stream_gemini_response()` → per-chunk TTS

**AuthManager / OAuthManager**
- JWT access token (short TTL) + refresh token (long TTL)
- Google OAuth: `/api/auth/google` → `/api/auth/google/callback`
- ⚠️ アクセストークンを Authorization ヘッダーで扱う → 現 v-mate は httpOnly Cookie で改善済み

**Character CRUD** ← **転用候補 ④ (設計パターン)**
- `GET/POST /api/characters`、`GET/PUT/DELETE /api/characters/<id>`
- ownership チェック: `character.owner_id == current_user.id`

### フロントエンド (app.js, 3877行)

**Three.js 構成**
- `WebGLRenderer` + `CSS3DRenderer` の二重レイヤー ← **転用候補 ⑤**
- `createGlassPanel()`, `createMessageInputPanel()`, `createARSpeechBubble()` で
  チャットパネルを Three.js の3D空間に配置する (2D DOM オーバーレイではなく)

**VRM アニメーション** ← **転用候補 ⑥**
- VRMA クリップ: `liked.vrma`, `waiting.vrma`, `idle2.vrma`, `idle3.vrma`, `idle4.vrma`
- `loadGLTFAnimation()` → VRMAnimationLoaderPlugin
- `playAppearingAnimation()` → `playWaitingAnimation()` → `scheduleNextIdleAnimation()`
- idle プール: ランダム選択 + 直前と同じものを回避 + `crossFadeTo()` でなめらか遷移

**Blink**
- `initBlinkTimer()` + `scheduleNextBlink()` — 2〜6秒間隔

**Lip sync**
- AudioContext + AnalyserNode — 現 v-mate SpeechQueue の `mouthLevel()` と同一アプローチ

**背景**
- SphereGeometry (半球 180°, BackSide material) でイマーシブ背景
- 現 v-mate に同様の実装がなければ転用価値あり

**リアルタイムオーディオキュー**
- `receivedChunks` Map + `audioChunkQueue` + `audioPlaybackIndex` で順序保証
- 現 v-mate の SpeechQueue.prefetch が同等以上の役割を担う

---

## 2. v-mate-reborn — システム構成

```
[Rust Axum + Tokio + SQLx (Backend)] ←→ [React + RTF + @pixiv/three-vrm (Frontend)]
        |
        ├── Gemini (SSE streaming)
        ├── ElevenLabs TTS (eleven_turbo_v2_5, latency=3)
        ├── AssemblyAI STT (polling)
        ├── JWT access+refresh (WS認証: ?token= クエリパラム)
        ├── Google OAuth
        └── PostgreSQL (SQLx マイグレーション)
```

### PostgreSQL スキーマ (migrations/0001_init.sql)

```sql
users(id UUID PK, email, password_hash, display_name, created_at, last_login_at)
oauth_accounts(user_id FK, provider, provider_id)
refresh_tokens(user_id FK, token_hash, expires_at, revoked_at)
user_settings(user_id PK FK, background, volume, voice_speed)
characters(id UUID, owner_id FK nullable, slug, name, color, model_file, voice_id)
conversations(id UUID, user_id FK, character_id FK, role CHECK(user|assistant), content, emotion)
INDEX: idx_conversations_user_character ON (user_id, character_id, created_at)
```

**グローバルキャラクター設計** ← **転用候補 ④**
- `owner_id IS NULL` = システム提供キャラ (シロ等)
- `owner_id = user_id` = ユーザー作成キャラ
- LIST: `WHERE owner_id IS NULL OR owner_id = $1` で両方を返す
- UPDATE/DELETE: ownership チェックで守る

### 主要モジュール

**emotion.rs** ← **転用候補 ②**
```rust
// キーワード投票 → max_by_key で最多得票感情を選ぶ
const HAPPY: &[&str] = &["嬉しい", "楽しい", "ありがとう", ...];
const SAD: &[&str] = &["悲しい", "つらい", "寂しい", ...];
// analyze(text) → Emotion::Happy | Sad | Surprised | Angry | Neutral
// ゼロ得票はすべて Neutral にフォールバック
```

**text_splitter.rs** ← **転用候補 ①**
```rust
const SENTENCE_ENDINGS: &[char] = &['。', '！', '？', '\n'];
const BREATH_POINTS: &[char] = &['、', ','];
const MAX_CHUNK_CHARS: usize = 60;
// split(text) → Vec<String>
// 二段階: 文末句読点で分割 → 60文字超の文は読点でさらに分割
```

**ws/protocol.rs** ← **転用候補 ③ (型安全パターン)**
```rust
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Transcript { text: String },
    MessageChunk { chunk_index: u32, text: String, emotion: &'static str, audio_data: Option<String> },
    StreamingComplete,
    Error { message: String },
}
```

**ws/handler.rs** — WS チャットパイプライン
```
fetch_character → save_user_msg → history(20) → format_history
→ build_prompt → stream_response → text_splitter::split
→ per-chunk: emotion::analyze + synthesize_safe → send MessageChunk
→ save_assistant_msg → send StreamingComplete
```

**ai.rs** — Gemini SSE streaming
- `generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`
- Primary モデル失敗時に fallback モデルへ自動切り替え
- `sse_text_stream()`: バイトバッファ → `data: ` prefix 除去 → JSON → candidates[0].content.parts[0].text

**memory.rs** — PostgreSQL 会話履歴
- `save(user_id, character_id, role, content, emotion)` — per-user AND per-character スコープ
- `history(user_id, character_id, limit=20)` — DESC LIMIT → reverse
- `format_history()` → 平文 "ユーザー: ..." / "あなた: ..." トランスクリプト

**services/tts.rs** — ElevenLabs TTS
- モデル: `eleven_turbo_v2_5`, `optimize_streaming_latency=3`
- MP3 を `audio_dir/{uuid}.mp3` に保存 → `/audio/{uuid}.mp3` URL を返す
- voice_settings: stability=0.5, similarity_boost=0.75
- `synthesize_safe()`: TTS 失敗は非致死 → テキストは届く、audio=None

---

## 3. 現 v-mate — 現行スタック確認

| 層 | 実装 |
|----|------|
| CDN/API GW | Cloudflare Workers (TypeScript) |
| バックエンド | FastAPI (Python) |
| LLM | Groq (llama-3.3-70b), OpenAI互換エンドポイント差し替え可 |
| TTS | Aivis Cloud API (`/api/tts`, MP3 返却) |
| STT | WebSpeechAPI + デバイス内 Whisper (whisper-engine.ts) |
| DB | SQLite (ローカル) / PostgreSQL (Neon等) — DATABASE_URL で切替 |
| 認証 | httpOnly Cookie JWT (最も安全) |
| フロント | React + three.js + @pixiv/three-vrm |
| VRM アニメ | viewer.ts (確認済み) |
| テキスト分割 | SentenceSplitter (speech.ts) — 正規表現1段階 |
| 音声キュー | SpeechQueue + prefetch (speech.ts) |
| リアルタイム | SSE (StreamingChat) |
| 感情 | SSE `type:emotion` イベント → バックエンド main.py が付与 |

---

## 4. 三世代比較表

| 機能 | V-Mate (original) | v-mate-reborn | 現 v-mate |
|------|-------------------|--------------|----------|
| バックエンド | Flask + SocketIO | Rust Axum WS | FastAPI SSE |
| LLM | Gemini | Gemini | Groq (切替可) |
| TTS | ElevenLabs (サーバ側キュー) | ElevenLabs (synthesize_safe) | Aivis Cloud |
| STT | AssemblyAI (polling) | AssemblyAI | WebSpeech + Whisper |
| 認証 | JWT (Authorization header) | JWT (WS ?token=) | httpOnly Cookie JWT ✅ |
| DB | SQLite | PostgreSQL | SQLite/PostgreSQL |
| 会話スコープ | session_id | user_id + character_id | user_id のみ |
| テキスト分割 | 二段階 (50文字) | 二段階 (60文字) | 一段階 ← **改善余地** |
| 感情解析 | キーワード辞書 | キーワード投票 max_by_key | LLM依存 ← **改善余地** |
| キャラ設計 | owner_id CRUD | owner_id NULL=global | 単一キャラ |
| 3D UI | CSS3DRenderer (3D空間) | 通常 DOM | 通常 DOM |
| アイドルアニメ | プール+ランダムcrossfade | — | viewer.ts 要確認 |
| 会話要約 | MemoryManager (SQLite) | — | memory.py (実装済み) |
| TTS prefetch | なし (サーバ側キュー) | なし | SpeechQueue.processQueue() ✅ |

---

## 5. 転用候補 — 優先順位付き

### ★★★ HIGH (今すぐ転用すべき)

#### 転用候補 ① — TextSplitter 二段階化 (読点での二次分割)

**問題:** 現 `SentenceSplitter.feed()` (`speech.ts:154-178`) は
`/[^。!?！？\n]*[。!?！？\n]/g` の正規表現1段階のみ。
読点 `、,` での二次分割がないため、60文字超の長い文がそのまま1チャンクとして
Aivis TTS に渡される。TTS のレイテンシが増え、文間の無音ギャップが目立つ。

**先代の解法 (V-Mate: chunk_size=50 / v-mate-reborn: MAX_CHUNK_CHARS=60):**
文末句読点で分割後、60文字を超える文はさらに読点で分割する。

**移植先:** `frontend/src/features/voice/speech.ts` の `SentenceSplitter.feed()`

**TypeScript 実装イメージ:**
```typescript
const SENTENCE_RE = /[^。!?！？\n]*[。!?！？\n]/g;
const BREATH_RE = /[^、,]+[、,]?/g;
const MAX_CHUNK_CHARS = 60;

feed(chunk: string): string[] {
  this.buffer += chunk;
  const sentences: string[] = [];
  const re = new RegExp(SENTENCE_RE.source, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(this.buffer)) !== null) {
    const s = match[0].trim();
    if (!s || !/\p{L}|\p{N}/u.test(s)) { lastIndex = re.lastIndex; continue; }
    if (s.length > MAX_CHUNK_CHARS) {
      // 二段階: 読点で再分割
      for (const sub of s.match(BREATH_RE) ?? [s]) {
        const t = sub.trim();
        if (t) sentences.push(t);
      }
    } else {
      sentences.push(s);
    }
    lastIndex = re.lastIndex;
  }
  this.buffer = this.buffer.slice(lastIndex);
  return sentences;
}
```

**コスト:** 低 — 変更ファイル1つ、テスト追加のみ  
**期待効果:** TTS チャンクが最大60文字以下に収まり、prefetch の有効性が上がり無音ギャップが減る

---

#### 転用候補 ② — 感情キーワード投票 (max_by_key) を Python 感情解析に追加

**問題:** 現在の感情検出は LLM の出力に完全依存 (SSE の `type:emotion` イベント)。
LLM が感情を出力しない・誤出力する場合のフォールバックがない。

**先代の解法 (v-mate-reborn emotion.rs):**
キーワードリストで各感情の出現数を集計し、最多得票の感情を選ぶ。
ゼロ得票は Neutral。LLM 結果の検証・補完として使える。

**移植先:** `backend/app/main.py` または新規 `backend/app/emotion.py`

**Python 実装イメージ:**
```python
HAPPY_WORDS = ["嬉しい", "楽しい", "ありがとう", "嬉しかった", "好き", "最高"]
SAD_WORDS = ["悲しい", "つらい", "寂しい", "泣きたい", "悲しかった"]
SURPRISED_WORDS = ["びっくり", "驚いた", "えっ", "まじで", "うそ"]
ANGRY_WORDS = ["むかつく", "腹立つ", "怒", "嫌い", "最悪"]

def analyze_emotion(text: str) -> str:
    counts = {
        "happy": sum(1 for w in HAPPY_WORDS if w in text),
        "sad": sum(1 for w in SAD_WORDS if w in text),
        "surprised": sum(1 for w in SURPRISED_WORDS if w in text),
        "angry": sum(1 for w in ANGRY_WORDS if w in text),
    }
    best = max(counts, key=counts.get)
    return best if counts[best] > 0 else "neutral"
```

**コスト:** 低 — 新規ファイル1つ + main.py への呼び出し追加  
**活用場面:** LLM が感情を返さない (タイムアウト・フォールバック時) のデフォルト感情として

---

### ★★ MEDIUM (次フェーズで転用)

#### 転用候補 ③ — TypeScript 型安全 SSE プロトコル (Discriminated Union)

**現状:** `api.ts:89-103` の SSE パース部分は `data` が実質 `any` で switch している:
```typescript
switch (data.type) {   // data の型が保証されない
  case 'emotion': events.onEmotion(data.emotion as Emotion);  // as でキャスト
  case 'token':   events.onToken(data.text as string);
  ...
}
```

**先代の解法 (v-mate-reborn protocol.rs):** `serde(tag = "type")` の型安全 enum

**移植先:** `frontend/src/features/chat/api.ts` + `types.ts`

**TypeScript 実装:**
```typescript
// types.ts に追加
type SSEEmotionEvent = { type: 'emotion'; emotion: Emotion };
type SSETokenEvent  = { type: 'token';   text: string };
type SSEDoneEvent   = { type: 'done' } & CompanionState;
type SSEErrorEvent  = { type: 'error';   message: string };
export type ChatSSEEvent = SSEEmotionEvent | SSETokenEvent | SSEDoneEvent | SSEErrorEvent;
```

**コスト:** 低 — 型定義のみ、ランタイム変更なし  
**効果:** switch の各ケースで型が narrowing されるため、不正アクセスをコンパイル時検出できる

---

#### 転用候補 ④ — グローバル/ユーザーキャラクター設計パターン

**現状:** v-mate はシロ1キャラのみ (`modelUrl: '/models/shiro.vrm'` ハードコード)

**先代の解法 (v-mate-reborn characters テーブル):**
- `owner_id IS NULL` → システム提供 (シロ等、全ユーザー共有)
- `owner_id = user_id` → ユーザー作成カスタムキャラ

**転用先:** 多キャラクター対応時の DB スキーマ設計 (`memory.py` への `characters` テーブル追加)

**コスト:** 中 — スキーマ追加 + フロントエンドのキャラ選択 UI が必要  
**タイミング:** キャラクター選択機能を実装するフェーズで参考にする

---

### ★ LOW (表現向上・余裕があれば)

#### 転用候補 ⑤ — CSS3DRenderer による 3D UI パネル

**現状:** v-mate のチャットパネルは 2D DOM を canvas に重ねるアプローチ

**先代の解法 (V-Mate original):**
- Three.js `CSS3DRenderer` を `WebGLRenderer` と並列で動かす
- `createGlassPanel()`, `createMessageInputPanel()`, `createARSpeechBubble()` で
  チャット UI を3D空間に配置 → VRM キャラと同じ空間に共存する没入感

**転用先:** `frontend/src/features/vrm/viewer.ts` に CSS3DRenderer レイヤー追加

**コスト:** 高 — CSS3DRenderer の座標管理、タッチ/マウス入力の透過処理が複雑  
**タイミング:** UI の没入感・AR感を強化したい段階で検討

---

#### 転用候補 ⑥ — アイドルアニメーションプール (ランダム非リピート + crossfade)

**先代の解法 (V-Mate original):**
- idle アニメのプール: `[liked.vrma, waiting.vrma, idle2.vrma, idle3.vrma, idle4.vrma]`
- ランダム選択 + 直前と同じものを回避
- `crossFadeTo()` で現アニメから滑らかに遷移

**確認事項:** 現 v-mate の `viewer.ts` の idle animation 実装を確認し、
同様のプール/ランダム/crossfade が未実装なら追加価値あり。

**コスト:** 低〜中 — VRMA ファイルが揃っていれば `viewer.ts` の変更のみ

---

## 6. 転用不要 (現実装の方が優れている)

| 機能 | 先代 | 現 v-mate | 判定 |
|------|------|-----------|------|
| TTS 音声キュー | ElevenLabsQueue (サーバ側 asyncio.Queue) | SpeechQueue.processQueue() + prefetch (クライアント) | **現行優位** — サーバ往復を減らした上でギャップも防ぐ |
| JWT 認証 | Authorization ヘッダー / WS query param | httpOnly Cookie | **現行優位** — XSS でのトークン窃取不可能 |
| STT | AssemblyAI (ポーリング, 高レイテンシ) | WebSpeech + Whisper (オンデバイス) | **現行優位** — レイテンシ・コスト・プライバシー全て改善 |
| LLM フォールバック | Gemini primary/fallback ペア | LLM_BASE_URL 差し替えで任意エンドポイント | **現行優位** — ベンダーロックイン回避 |
| 会話要約 | MemoryManager (session スコープ) | memory.py (summary + through_id + facts) | **現行優位** — facts 抽出・日記生成まで統合済み |

---

## 7. 実装推奨順序

```
Phase 1 (今すぐ):
  ① SentenceSplitter 二段階化 (speech.ts) — コスト最小、TTS 品質直結

Phase 2 (今週):
  ② emotion.py キーワード投票追加 — LLM フォールバック耐性向上
  ③ ChatSSEEvent discriminated union 型定義 (api.ts) — 型安全化、ランタイムゼロコスト

Phase 3 (次フェーズ):
  ④ characters テーブル + グローバル/ユーザーキャラ設計 — 多キャラクター対応時
  ⑥ アイドルアニメプール確認/強化 — VRM 表現向上

Phase 4 (将来):
  ⑤ CSS3DRenderer 3D UIパネル — 没入感強化、実装コスト高
```

---

## 8. 参照コード場所

| 参照対象 | ファイルパス |
|---------|------------|
| TextSplitter 二段階 (Python) | `V-Mate/src/app.py:TextSplitter.split_for_streaming()` |
| TextSplitter 二段階 (Rust) | `v-mate-reborn/backend/src/core/text_splitter.rs` |
| 感情キーワード投票 (Rust) | `v-mate-reborn/backend/src/core/emotion.rs` |
| WS tagged union プロトコル | `v-mate-reborn/backend/src/ws/protocol.rs` |
| グローバルキャラ DB 設計 | `v-mate-reborn/backend/migrations/0001_init.sql` |
| CSS3DRenderer 3D UIパネル | `V-Mate/frontend/js/app.js:createGlassPanel()` |
| アイドルアニメプール | `V-Mate/frontend/js/app.js:scheduleNextIdleAnimation()` |
| ElevenLabsQueue (サーバ側) | `V-Mate/src/app.py:ElevenLabsQueue._process_queue()` |
| 現 SentenceSplitter (改善対象) | `v-mate/frontend/src/features/voice/speech.ts:154-178` |
| 現 SpeechQueue prefetch | `v-mate/frontend/src/features/voice/speech.ts:96-116` |
| 現 SSE パース (型強化対象) | `v-mate/frontend/src/features/chat/api.ts:86-104` |

---

---

# 外部 OSS プロジェクト コードベース分析
date-added: 2026-06-30  
scope: z-waif / kimjammer-Neuro / moeru-ai-airi → 現 v-mate への転用候補

## 分析対象 (外部 OSS)

| # | プロジェクト | Stars | 言語 | ローカルパス (scratchpad) |
|---|------------|-------|------|--------------------------|
| 1 | **z-waif** (SugarcaneDefender/z-waif) | 〜3k | Python 97.6% | `/private/tmp/.../oss-analysis/z-waif/` |
| 2 | **kimjammer/Neuro** | — | Python | `/private/tmp/.../oss-analysis/neuro/` |
| 3 | **moeru-ai/airi** | 41.3k | TypeScript/Vue | `/private/tmp/.../oss-analysis/airi/` |

情報源: `/Users/taku8/Documents/takuminのvault/01_学習・研究/技術調査/V-Mate研究/AIコンパニオンプロジェクト_包括的調査_2026-06.md`

---

## 現 v-mate 記憶システム — 現状確認 (2026-06-30)

`worker/src/chat.ts` と `worker/src/persona.ts` を精読した結果:

| 機能 | 実装状態 | ファイル:行 |
|------|---------|------------|
| 会話履歴窓 | 直近 24 件を逐語で LLM に渡す (`HISTORY_WINDOW=24`) | `chat.ts:29` |
| 事実抽出 | 6 ユーザー発言ごとに `extractFacts()` でユーザー本人の事実を抽出 | `chat.ts:27,171-188` |
| ローリング要約 | 窓から溢れた16件ごとに `summarizeOldHistory()` → `conversation_summary` KV | `chat.ts:34,191-212` |
| システムプロンプト | `buildSystemPrompt()`: affinity stage + facts + summary + timeContext を注入 | `persona.ts:40-103` |
| RAG | **なし** — 過去全履歴からの意味検索機能がない | — |
| Lorebook | **なし** — キーワードトリガーによるコンテキスト注入がない | — |
| AI状態通知 | SSE に `type:emotion` / `type:token` / `type:done` はあるが `type:thinking` なし | `chat.ts:99-155` |
| 記憶の構造化 | facts は自由文のみ (Q&A形式ではない) | `db.ts:136-151` |

---

## z-waif — システム構成

```
[LocalLLM (Ollama/LM Studio)] ←→ [Python CLI + Tkinter GUI]
        |
        ├── BASED RAG (TF-IDF over all historical chat logs)
        ├── Rolling Summaries (LiveSummaryLog.json)
        ├── Lorebook (Configurables/Lorebook.json)
        ├── Character Card (Configurables/CharacterCard.yaml)
        └── VTube Studio (VRM アバター)
```

### z-waif 転用候補

#### 転用候補 A: BASED RAG (過去全履歴からのTF-IDF検索)

- **該当ファイル**: `z-waif/utils/based_rag.py` (全体, 約120行)
- **何をしているか**:
  1. 起動時に `setup_based_rag()` で全 JSON チャットログをパース → 単語頻度 DB 構築
  2. 発言ごとに `run_based_rag(current_message, her_previous)` を呼び出し
  3. 現在の発言の「レアワード top6」と過去ログの「レアワード top6」の重複数をスコアリング
  4. 最高スコアの過去発言を中心に前後3メッセージウィンドウを取り出してプロンプトに注入
  5. `history_demarc=20` により直近20件は検索対象から除外(重複防止)
  6. Lorebook キーワードのレアワードスコアをブースト (ロアとRAGの統合)
- **v-mateへの転用方法**:
  - **移植先**: `worker/src/chat.ts` の `handleChat()` 関数内、`buildSystemPrompt()` 呼び出し前
  - D1 SQLite の `messages` テーブルに対して Cloudflare D1 FTS (Full-Text Search) を使うか、
    `SELECT content FROM messages WHERE user_id = ? AND role IN ('user','assistant')`
    で全件取得し、TypeScript で TF-IDF スコアリングを実装
  - 抽出した3メッセージウィンドウは `system prompt` の末尾 or `history` 配列の先頭に追加
  - 具体的な D1 実装: `db.ts` に `searchSimilarMessages(userId, query)` メソッドを追加
- **実装コスト**: 中 (D1 FTSのセットアップ or TypeScript TF-IDF実装 + chat.ts への統合)
- **優先度**: 高 — ユーザーが何週間も前に言及した話題を「覚えている」体験が生まれる

```typescript
// db.ts に追加するイメージ
async searchSimilarMessages(userId: string, query: string, excludeRecent = 20): Promise<MessageRow[]> {
  // D1 FTS5: messages_fts テーブルを作成しておく
  const { results } = await this.db
    .prepare("SELECT m.id, m.role, m.content FROM messages m " +
             "JOIN messages_fts f ON m.id = f.rowid " +
             "WHERE m.user_id = ?1 AND f.content MATCH ?2 " +
             "AND m.id < (SELECT MIN(id) FROM (SELECT id FROM messages WHERE user_id = ?1 ORDER BY id DESC LIMIT ?3)) " +
             "ORDER BY rank LIMIT 3")
    .bind(userId, query, excludeRecent)
    .all<MessageRow>();
  return results;
}
```

---

#### 転用候補 B: Lorebook (キーワードトリガー lore 注入)

- **該当ファイル**: `z-waif/utils/lorebook.py` (全体, 約60行) + `z-waif/Configurables/Lorebook.json`
- **何をしているか**:
  1. `Lorebook.json` = `[[keyword, description, cooldown], ...]` の配列
  2. `lorebook_gather(messages, sent_message)` が直近メッセージを走査し、キーワードを単語境界でマッチ
  3. マッチしたエントリを `"Here is some lore about ...\n\n[keyword, description]"` に整形
  4. cooldown=7 により同一キーワードを連続注入しない
  5. プロンプトの会話履歴の -8 番目の位置に挿入 (`encode_new_api.py`)
- **v-mateへの転用方法**:
  - **移植先**: `db.ts` に `lorebook` テーブル追加 + `worker/src/persona.ts` の `buildSystemPrompt()` 内で注入
  - D1スキーマ: `CREATE TABLE lorebook (id INTEGER PK, user_id TEXT, keyword TEXT, description TEXT, cooldown INTEGER DEFAULT 7)`
  - `persona.ts` の `buildSystemPrompt()` に新パラメータ `lorebook: string` を追加し、
    facts セクションの直後に `## Lore\n${lorebook}` として注入
  - キーワードマッチは chat.ts のストリーミング前に `gatherLorebook(uid, message, recent)` を呼ぶ
  - 初期値: シロの設定 (趣味、口癖、背景) を seed データとして投入

```typescript
// db.ts に追加するイメージ
async gatherLorebook(userId: string, message: string, recentMessages: MessageRow[]): Promise<string> {
  const { results } = await this.db
    .prepare("SELECT keyword, description FROM lorebook WHERE user_id = ? OR user_id = 'global'")
    .bind(userId).all<{keyword: string; description: string}>();
  const allText = recentMessages.map(m => m.content).join(' ') + ' ' + message;
  const matched = results.filter(e => {
    const re = new RegExp(`\\b${e.keyword}\\b`, 'i');
    return re.test(allText);
  });
  if (matched.length === 0) return '';
  return 'Lore:\n' + matched.map(e => `${e.keyword}: ${e.description}`).join('\n');
}
```

- **実装コスト**: 低〜中 (DB マイグレーション + persona.ts の軽微な変更)
- **優先度**: 高 — ユーザーが前回会話で話した特定の固有名詞(ゲームタイトル、友人名等)をシロが文脈として持てる

---

#### 転用候補 C: Rolling Summaries の注入位置改善

- **該当ファイル**: `z-waif/API/api_controller.py:encode_new_api()` (L約150付近)
- **何をしているか**:
  - 要約を会話履歴の `-2` 番目(末尾から2番目)に `[System S]` タグ付きで挿入する
  - `System Prompt + RAG + Lorebook + 会話履歴[:-2] + [SummaryTag] + 会話履歴[-2:]`
- **v-mateの現状**:
  - `buildSystemPrompt()` がシステムプロンプトの冒頭に `## これまでの会話の流れ` として注入
  - LLMがシステムプロンプトの後半部分を「忘れる」ことがあり、要約がコンテキスト末尾近くにある方が効果的
- **v-mateへの転用方法**:
  - `worker/src/chat.ts:89-90` の `history` 組み立て部分で、`summary` を末尾-2位置に
    `{role: "system", content: "[Summary] " + summary}` として差し込む
  - 実装難度が低く、プロンプト末尾に近い位置に要約を置くことで記憶精度向上が期待できる
- **実装コスト**: 低 (chat.ts 数行の変更)
- **優先度**: 中

---

## kimjammer/Neuro — システム構成

```
[OpenAI / Claude LLM] ←→ [Python + Socket.io]
        |
        ├── Signals (observable state, queue.SimpleQueue)
        ├── Module + Injection priority system
        ├── ChromaDB (PersistentClient, Q&A reflection memory)
        ├── Twitch chat integration
        └── VTube Studio / OBS
```

### Neuro 転用候補

#### 転用候補 D: `type:thinking` SSE イベント (Signals パターンの部分採用)

- **該当ファイル**: `neuro/signals.py` (全体, 約60行)
- **何をしているか**:
  - `Signals` クラスがAIの状態(`AI_thinking`, `AI_speaking`, `human_speaking`等)を
    `@property` setter で auto-publish する observable 状態管理
  - setter 呼び出し → `sio_queue.put((event_name, value))` → Socket.io でクライアントへ
- **v-mateへの転用方法**:
  - Socket.io は不要。SSE の `type:thinking` イベントを LLM 呼び出し直前に送信するだけで効果あり
  - **移植先**: `worker/src/chat.ts:98` の `streamChat()` 呼び出し直前に以下を追加:
    ```typescript
    await write({ type: "thinking" });
    ```
  - iOS クライアント側でこのイベントを受け取り、「シロが考えています...」アニメや
    アイコンを表示する
  - 追加コスト: `chat.ts` 1行 + iOS 側のイベントハンドリング追加
- **実装コスト**: 低 (chat.ts 1行 + iOS 側数行)
- **優先度**: 高 — LLM レスポンス待機中のUX改善に直結

---

#### 転用候補 E: Q&A形式リフレクションメモリ (ChromaDB アプローチの SQLite 版)

- **該当ファイル**: `neuro/modules/memory.py` (全体, 約80行)
- **何をしているか**:
  1. 20メッセージごとに LLM に `MEMORY_PROMPT` を送り、会話からQ&Aペアを生成させる
  2. フォーマット: `Q: ...{qa}A: ...{qa}Q: ...` の `{qa}` 区切り
  3. 各Q&Aペアを ChromaDB に upsert (embedding で意味検索)
  4. 会話時、直近会話を query にして ChromaDB から関連記憶を取り出してプロンプト注入
- **v-mateへの転用方法**:
  - **ステップ1**: `factExtractionPrompt()` を改変し、Q&A形式で出力させる
    ```typescript
    // persona.ts の factExtractionPrompt() を修正
    export function factExtractionPrompt(conversation: string): string {
      return `以下の会話からユーザーに関する情報をQ&A形式で抽出せよ。
    形式: Q: [質問] A: [答え]
    最大5ペア。事実がなければ「なし」のみ出力。
    会話:\n${conversation}`;
    }
    ```
  - **ステップ2**: `db.ts` の `addFact()` を Q&A形式で保存するように変更し、
    `facts` テーブルに `question TEXT` カラムを追加
  - **ステップ3**: Cloudflare Vectorize (ベクトルDB) を `wrangler.toml` に追加し、
    Q&Aペアのembeddingを保存。`searchSimilarFacts(userId, message)` でRAG検索
  - ※ Vectorize は有料。最小コストバージョン: facts テーブルを FTS で全件検索
- **実装コスト**: 中〜高 (Vectorize 追加の場合: 高 / FTS版: 中)
- **優先度**: 中 — facts の精度向上。現状でも facts は機能しているため緊急ではない

---

#### 転用候補 F: Module/Injection 優先度システム (システムプロンプト モジュール化)

- **該当ファイル**: `neuro/modules/module.py` + `neuro/modules/injection.py` + `neuro/prompter.py`
- **何をしているか**:
  - 各機能モジュール (`Memory`, `Twitch`, `Time`等) がそれぞれ `Injection(text, priority)` を返す
  - `Prompter` が全モジュールの injection を priority 昇順でソートし、最終プロンプトを組み立て
  - priority 慣例: System Prompt=10, History=50, Twitch=100
- **v-mateへの転用方法**:
  - **現在**: `persona.ts:buildSystemPrompt()` が一枚岩のシステムプロンプト文字列を返す
  - **将来的リファクタリング案**: `buildSystemPrompt()` を `InjectionModule[]` を返す形に変更し、
    RAG / Lorebook / facts / summary 各モジュールが独立した priority 付き injection を返す
  - `chat.ts` で injection を priority 昇順で結合して最終システムプロンプトを構築
  - `buildSystemPrompt()` の現在の呼び出し箇所: `chat.ts:82`
- **実装コスト**: 高 (全面的なリファクタリング)
- **優先度**: 低 — 現状の一枚岩でも機能する。RAG/Lorebook を追加した後に整理フェーズで検討

---

## 比較表 — 現 v-mate vs 外部 OSS

| 機能 | z-waif | Neuro | v-mate (現状) | 転用優先度 |
|------|--------|-------|--------------|-----------|
| Rolling Summaries | ✅ (LiveSummaryLog.json) | ❌ | ✅ (summarizeOldHistory) | — 実装済み |
| RAG (全履歴検索) | ✅ BASED RAG (TF-IDF) | ❌ | **❌ なし** | **高** |
| Lorebook | ✅ (JSON keyword→description) | ❌ | **❌ なし** | **高** |
| 要約の注入位置 | 会話履歴 -2 位置 | — | system prompt 冒頭 | 中 |
| AI 状態通知 | ❌ | ✅ (Signals) | SSE thinking なし | **高** |
| 記憶の Q&A 化 | ❌ | ✅ (ChromaDB) | facts のみ(自由文) | 中 |
| キャラ設定 | CharacterCard.yaml | ❌ | buildSystemPrompt() | — |
| プロンプト組み立て | 位置指定注入 | priority module | 一枚岩 | 低(将来) |

---

## 外部 OSS 転用 — 実装推奨順序

```
Phase A (今すぐ・低コスト):
  D: type:thinking SSE イベント
     → chat.ts:98 に await write({ type: "thinking" }); の1行追加
     → iOS 側: このイベントを受け取りシロの「考え中」アニメ/表示を追加

Phase B (今週・中コスト):
  B: Lorebook テーブル + persona.ts への注入
     → db.ts に lorebook テーブル作成 (migration)
     → chat.ts で gatherLorebook() を呼んで persona.ts に渡す
     → buildSystemPrompt() に lorebook 引数追加
  C: Rolling Summary の注入位置改善 (system prompt → history[-2])
     → chat.ts:89-90 の history 組み立て部分に summary 行を差し込む

Phase C (次フェーズ・高コスト):
  A: BASED RAG / D1 FTS
     → wrangler.toml で D1 FTS5 設定
     → db.ts に searchSimilarMessages() 追加
     → chat.ts で RAG 結果をシステムプロンプトに注入
  E: Q&A リフレクションメモリ (Vectorize or FTS版)
     → factExtractionPrompt() の出力形式変更
     → Vectorize bindingまたはFTS化

Phase D (将来):
  F: Module/Injection システム (プロンプトのモジュール化リファクタリング)
```

---

## 実装時の注意点 (Gotchas)

- **D1 FTS5**: Cloudflare D1 は SQLite の FTS5 を**サポートしている**が、`CREATE VIRTUAL TABLE` が
  通常の `wrangler d1 execute` で動作するか確認が必要。schema.sql に追加してテスト実行すること。
- **Lorebook のキーワードマッチ**: z-waif は Python regex `\b` を使うが日本語は単語境界がない。
  TypeScript では `new RegExp(keyword, 'i')` の部分一致にするか、形態素解析なしで単純 includes() を使う。
- **type:thinking イベント**: iOS クライアント側が SSE `type` を `emotion|token|done|error` 以外も
  ハンドリングできるか確認。未知の type はスキップするだけなので安全に追加可能。
- **Lorebook の cooldown**: z-waif はターン数でクールダウン管理。v-mate では KV テーブルに
  `lorebook_last_used_{keyword}` を追加するか、cooldown を省略して単純注入から始める。

---

## moeru-ai/airi — システム構成

```
[Multi-LLM (30+ providers)] ←→ [Vue 3 + TypeScript monorepo (pnpm)]
        |
        ├── packages/core-agent/      LLM runtime, DuckDB WASM memory, agents
        ├── packages/stage-ui-three/  three.js + @pixiv/three-vrm VRM制御
        ├── apps/server/              WebSocket TTS proxy
        └── Signal-based reactivity   モジュール間状態共有
```

Stars: 41.3k。TypeScript、Vue 3、VRM + Live2D 対応、DuckDB WASM インブラウザ DB、30+ LLM プロバイダー。

### AIRI 転用候補

#### 転用候補 G: Streaming TTS reasoning-block filter ★★★ HIGH

- **該当ファイル**: `packages/core-agent/src/runtime/response-categoriser.ts`
- **関数**: `createStreamingCategorizer(providerId, onSegment)` / `isSpeechAt(pos)` / `filterToSpeech(text, pos)` / `categorizeResponse(response)`
- **何をしているか**:
  - LLM ストリーミング中に `<think>/<reasoning>/<thought>` ブロックをリアルタイムフィルタリング
  - 出力を `{speech, reasoning, segments, raw}` に分類し、TTS には `speech` のみ渡す
- **v-mateへの転用方法**:
  - **移植先**: `worker/src/chat.ts:99-155` のストリームループ内
  - 現在の `EMOTION_TAG_RE` 除去 + `sanitizeFourthWall` に加え、`<think>...</think>` を除去するフィルターを追加
  - Groq + DeepSeek / Qwen モデルは `<think>` ブロックを出力することがある。現状 v-mate はそのまま TTS に渡してしまう
  - 実装: 正規表現 `/^<think>[\s\S]*?<\/think>/` をバッファ処理に追加 (streaming 対応が必要)
  - ※ `unified` / `rehype-parse` パッケージは Cloudflare Workers 非対応の場合あり。正規表現での実装を推奨
- **実装コスト**: 低 (chat.ts のバッファ処理に数行追加)
- **優先度**: 高 — 推論モデル系LLMを使う際に必須

```typescript
// chat.ts のバッファ処理に追加するフィルター
function filterThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
// ※ streaming 中は <think> が途中で切れる場合があるため、
// buffer 全体に対して開始タグが見つかったら closing tag まで保留する処理が必要
```

---

#### 転用候補 H: ML-based Lip Sync (wLipSync) ★★ MEDIUM

- **該当ファイル**: `packages/stage-ui-three/src/composables/vrm/lip-sync.ts`
- **関数**: `useVRMLipSync(audioNode)` + winner+runner-up blending + exponential smoothing
- **何をしているか**:
  - `@tachibana-ak/wlipsync` WebAssembly lib で音素推定 (機械学習ベース)
  - 上位2音素のみを blend (AEIOU)
  - `rate = 1 - Math.exp(-(to > from ? ATTACK=50 : RELEASE=30) * delta)` でなめらか補間
  - CAP=0.7 で口が開きすぎないよう制限
- **v-mateへの転用方法**:
  - **移植先**: `frontend/src/features/vrm/viewer.ts` の振幅ベースリップシンク処理と置き換え
  - 現在 v-mate は `AudioContext + AnalyserNode` の音量振幅でリップシンク → 音素が反映されない
  - `npm install @tachibana-ak/wlipsync` でパッケージ追加
  - 音素推定により母音に対応した口の形(AA/IH/OU等)が VRM モーフとしてセットされる
- **実装コスト**: 中 (パッケージ追加 + viewer.ts の lipSync 関数置き換え)
- **優先度**: 中 — 視覚的なリアリティ向上に効果あり

---

#### 転用候補 I: Lerp Expression Blending with Auto-Reset ★★ MEDIUM

- **該当ファイル**: `packages/stage-ui-three/src/composables/vrm/expression.ts`
- **関数**: `emotionStates` Map + `easeInOutCubic()` lerp + `setEmotionWithResetAfter(name, ms)`
- **何をしているか**:
  - 感情ステートを即時スイッチではなく lerp (線形補間) でなめらかに遷移させる
  - `setEmotionWithResetAfter(name, ms)` で一定時間後に neutral へ自動リセット
  - `emotionStates` 例: `happy → [{name:'happy', value:0.7}, {name:'aa', value:0.2}]`
  - `easeInOutCubic()` で視覚的に自然な遷移速度を実現
- **v-mateへの転用方法**:
  - **移植先**: `frontend/src/features/vrm/viewer.ts:setEmotion()` の実装変更
  - 現在の即時 VRM expression 切り替えを lerp 遷移に変更
  - `easeInOutCubic()` は pure JS 実装なので three.js / @pixiv/three-vrm と組み合わせ可能
  - `requestAnimationFrame` ループの中で `currentValue += (target - currentValue) * rate` を毎フレーム実行
- **実装コスト**: 低〜中 (viewer.ts の expression 部分を拡張)
- **優先度**: 中 — 感情遷移の不自然な瞬間切り替えが解消される

---

#### 転用候補 J: VRM Animation Root Position Anchor Fix ★★ MEDIUM

- **該当ファイル**: `packages/stage-ui-three/src/composables/vrm/animation.ts`
- **関数**: `reAnchorRootPositionTrack(clip, vrm)` — .vrma の hip ドリフト修正
- **何をしているか**:
  - VRMA アニメーション読み込み時に、ルートボーンの位置トラックをアンカーに固定し直す
  - アニメーション中にキャラクターが画面外にドリフトするバグを防ぐ
- **v-mateへの転用方法**:
  - **移植先**: `frontend/src/features/vrm/viewer.ts` の VRMA 読み込み処理
  - VRMAアニメーション再生時にキャラが動いてしまう場合はこの関数を適用
- **実装コスト**: 低 (1関数追加 + 呼び出し追加)
- **優先度**: 中 (VRMAアニメーション実装時に確認)

---

#### 転用候補 K: Eye Tracking Mode Abstraction ★ LOW/MEDIUM

- **該当ファイル**: `packages/stage-ui-three/src/composables/eye-tracking.ts`
- **関数**: `useVRMEyeFocusFor({cameraPosition, context, screenBoundingBox, source, trackingMode})` → `computed<Vector3>`
- **trackingMode**: `'cursor' | 'camera' | 'none'`
- **v-mateへの転用方法**:
  - **移植先**: `frontend/src/features/vrm/viewer.ts` の gaze 処理
  - 現在の視線追従実装を cursor / camera / none の3モード対応に拡張する設計の参考
- **実装コスト**: 中
- **優先度**: 低〜中 (iOS では cursor が使えないため camera モードが必要)

---

#### 転用候補 L: Structured Message Compaction ★★ MEDIUM

- **該当ファイル**: `packages/core-agent/src/messages/compaction.ts`
- **関数**: `compactConversationEntries(entries, recentTurnLimit, summarizeCompactedHistory?)`
- **何をしているか**:
  - 会話エントリを「直近 N ターン + 古い部分の要約」に圧縮する
  - オプションで LLM を使った要約も実行可能
- **v-mateへの転用方法**:
  - **移植先**: `worker/src/chat.ts:summarizeOldHistory()` (L191-211) + `worker/src/db.ts:getSummary()/setSummary()`
  - 現行 `summarizeOldHistory()` と思想が同じ。AIRI の実装からターン境界の扱い方を参考にできる
  - 現行の `SUMMARY_CHUNK=16` / `HISTORY_WINDOW=24` チューニングの参考に
- **実装コスト**: 低 (概念的改善・パラメータ調整)
- **優先度**: 低 (現行実装で概ね機能している)

---

## 全転用候補 — 統合優先度マトリクス

| # | 候補 | ソース | v-mate 移植先 | コスト | 優先度 |
|---|------|--------|-------------|--------|--------|
| D | type:thinking SSE イベント | neuro/signals.py | chat.ts:98 に1行追加 | **低** | **高** |
| G | Thinking-block filter | airi response-categoriser.ts | chat.ts:99-155 バッファ | **低** | **高** |
| B | Lorebook テーブル + 注入 | z-waif/lorebook.py | db.ts + persona.ts | 低〜中 | **高** |
| A | BASED RAG / D1 FTS | z-waif/based_rag.py | db.ts + chat.ts | 中 | **高** |
| C | Summary 注入位置改善 | z-waif api_controller.py | chat.ts:89-90 | **低** | 中 |
| H | ML Lip Sync (wLipSync) | airi lip-sync.ts | viewer.ts | 中 | 中 |
| I | Lerp emotion blending | airi expression.ts | viewer.ts setEmotion() | 低〜中 | 中 |
| J | VRMA anchor fix | airi animation.ts | viewer.ts VRMAローダー | **低** | 中 |
| E | Q&A reflection memory | neuro/memory.py | persona.ts + db.ts | 中〜高 | 中 |
| K | Eye tracking modes | airi eye-tracking.ts | viewer.ts gaze | 中 | 低〜中 |
| F | Module/Injection system | neuro/prompter.py | persona.ts リファクタ | 高 | 低 |
| L | Message compaction | airi compaction.ts | chat.ts summary改善 | 低 | 低 |

---

## 実装時の注意点 追記 (AIRI)

- **wLipSync + Cloudflare Workers**: `@tachibana-ak/wlipsync` は WASM バイナリを含む。
  Cloudflare Workers ではなく **フロントエンド側 (React/Vite)** で動かす想定が正しい。
  viewer.ts で AudioContext と組み合わせる形で動作する。
- **`<think>` ブロックフィルタ**: streaming 中に `<think>` が複数チャンクに分割される。
  buffer に `<think>` が存在するが `</think>` がまだない状態を検出し、
  その間は SSE に流さないバッファ保留ロジックが必要。
  `buffer.includes('<think>') && !buffer.includes('</think>')` でチェック。
- **Lerp blending の フレーム依存**: `requestAnimationFrame` のタイミングが iOS WebView 内では
  バッテリー節約のため 30fps に制限される場合がある。`delta` を正しく計測して rate を補正すること。

---

## Open-LLM-VTuber — システム構成

```
[FastAPI + WebSocket] ←→ [Python backend (async)]
        |
        ├── SentenceDivider (pysbd + langdetect)
        ├── TTSTaskManager (並列生成 + 順序保証キュー)
        ├── tts_preprocessor (タグ除去フィルタ)
        ├── ConversationHandler (割り込み・skip_memory)
        └── ServiceContext (依存注入)
```

GitHub: `Open-LLM-VTuber/Open-LLM-VTuber` / クローン先: `oss-analysis/open-llm-vtuber`

---

### 転用候補 M: TTS 前テキストフィルタ (`tts_preprocessor.py`) ★★★ HIGH

- **該当ファイル**: `src/open_llm_vtuber/utils/tts_preprocessor.py` (L1-196)
- **何をしているか**: `[brackets]` / `(parentheses)` / `*asterisks*` / `<angle_brackets>` をネスト対応で正確に除去。TTS 呼び出し直前専用で LLM メモリや字幕には影響しない
- **v-mateへの転用方法**: v-mate は `[happy]` 等の感情タグが Aivis TTS に渡っている可能性がある。`backend/app/main.py` の TTS 呼び出し直前に `filter_brackets()` を挿入するだけで解決
- **実装コスト**: 低（関数コピペで即使用可）
- **優先度**: 高（現行バグの可能性あり — 確認優先）

```python
import re

def filter_brackets(text: str) -> str:
    # [emotion] タグ除去
    text = re.sub(r'\[.*?\]', '', text, flags=re.DOTALL)
    # (parentheses) 除去
    text = re.sub(r'\(.*?\)', '', text, flags=re.DOTALL)
    # *asterisks* 除去
    text = re.sub(r'\*.*?\*', '', text, flags=re.DOTALL)
    return text.strip()
```

---

### 転用候補 N: ストリーミング文分割器 (`sentence_divider.py`) ★★★ HIGH

- **該当ファイル**: `src/open_llm_vtuber/utils/sentence_divider.py` (L301-608)
- **何をしているか**: LLM ストリームトークンを受け取り、pysbd（多言語文境界検出）+ `faster_first_response` モードで即時に最初の文を切り出す。`[tag]` 感情タグを保持したまま分割可能。日本語 (`ja`) 対応
- **v-mateへの転用方法**: `backend/app/main.py` の `/api/chat` でストリーム受信後にこの Divider を挟み、文完成ごとに TTS へ投げる。依存: `pysbd`, `langdetect` のみ
- **実装コスト**: 低（Python ファイル1本、`requirements.txt` に2行追加）
- **優先度**: 高（TTS 初音レイテンシが大幅改善）

---

### 転用候補 O: TTS 並列生成 + 順序保証キュー (`tts_manager.py`) ★★ MEDIUM

- **該当ファイル**: `src/open_llm_vtuber/conversations/tts_manager.py` (L17-183)
- **何をしているか**: `TTSTaskManager` が文ごとに TTS 生成を `asyncio` で並列実行しつつ、`sequence_number` でキューイングして送信は元の順序通りに保証する
- **v-mateへの転用方法**: `backend/app/main.py` の TTS パイプラインに導入。候補 N（文分割器）と組み合わせて「文完成 → 並列 TTS → 順序通り再生」を実現
- **実装コスト**: 中（Python backend への移植、Cloudflare Worker 版は TypeScript 書き直しが必要）
- **優先度**: 中（N を先に導入してから追加）

---

### 転用候補 P: nudge の `skip_memory` フラグ ★★ MEDIUM

- **該当ファイル**: `src/open_llm_vtuber/conversations/conversation_handler.py` (L35-55)
- **何をしているか**: AI 自発発言（`ai-speak-signal`）時に `skip_memory: True` / `skip_history: True` を付与し、nudge の応答を会話コンテキストに汚染させない
- **v-mateへの転用方法**: v-mate の `/api/nudge` ハンドラ (`backend/app/main.py`) で生成した応答を `conversations` テーブルに保存するかどうかを `skip_memory` フラグで制御する。現状は nudge 応答がメモリに混入している可能性あり
- **実装コスト**: 低
- **優先度**: 中

---

### 転用候補 Q: LLM 割り込み処理パターン ★ MEDIUM

- **該当ファイル**: `src/open_llm_vtuber/conversations/conversation_handler.py` (L112-143)
- **何をしているか**: `handle_individual_interrupt()` が `asyncio.Task` をキャンセルし、memory に `"[Interrupted by user]"` を挿入して履歴保存。次の LLM 呼び出しでモデルが割り込みを認識できる
- **v-mateへの転用方法**: iOS VAD が発話途中を検出したとき、バックエンドへ割り込みシグナルを SSE で送り、ストリームをキャンセルしてメモリに割り込みフラグを挿入するパターンとして参考にする
- **実装コスト**: 中（SSE ベースへの変換が必要）
- **優先度**: 中

---

## 全プロジェクト統合 — 最終優先度マトリクス

| # | 候補 | ソースプロジェクト | v-mate 移植先 | コスト | 優先度 |
|---|------|-----------------|-------------|--------|--------|
| D | `type:thinking` SSE イベント | kimjammer/Neuro | `chat.ts:98` 1行追加 | **低** | **高** |
| G | `<think>` ブロックフィルタ | moeru-ai/AIRI | `chat.ts` バッファ | **低** | **高** |
| M | TTS 前タグフィルタ | Open-LLM-VTuber | `backend/main.py` TTS前 | **低** | **高** |
| N | ストリーミング文分割器 | Open-LLM-VTuber | `backend/main.py` ストリーム | **低** | **高** |
| B | Lorebook テーブル+注入 | z-waif | `db.ts` + `persona.ts` | 低〜中 | **高** |
| A | BASED RAG / D1 FTS | z-waif | `db.ts:searchSimilarMessages()` | 中 | **高** |
| C | Summary 注入位置改善 | z-waif | `chat.ts:89-90` history[-2] | **低** | 中 |
| H | ML Lip Sync (wLipSync) | moeru-ai/AIRI | `viewer.ts` lipSync 置換 | 中 | 中 |
| I | Lerp 表情 blending | moeru-ai/AIRI | `viewer.ts:setEmotion()` | 低〜中 | 中 |
| J | VRMA hip ドリフト修正 | moeru-ai/AIRI | `viewer.ts` VRMAローダー | **低** | 中 |
| O | TTS 並列生成キュー | Open-LLM-VTuber | `backend/main.py` TTS pipeline | 中 | 中 |
| P | nudge skip_memory | Open-LLM-VTuber | `backend/main.py` nudge | **低** | 中 |
| E | Q&A リフレクションメモリ | kimjammer/Neuro | `persona.ts` + `db.ts` | 中〜高 | 中 |
| Q | LLM 割り込み処理 | Open-LLM-VTuber | iOS VAD + backend | 中 | 中 |
| K | Eye tracking モード抽象化 | moeru-ai/AIRI | `viewer.ts` gaze | 中 | 低〜中 |
| F | Module/Injection system | kimjammer/Neuro | `persona.ts` リファクタ | 高 | 低 |
| L | Message compaction | moeru-ai/AIRI | `chat.ts` summary 改善 | 低 | 低 |

---

## 統合実装ロードマップ

```
Phase 1 — 即日・低コスト (全部で数時間):
  M: TTS前タグフィルタ確認 → backend/main.py に filter_brackets() 追加
  D: type:thinking SSE → chat.ts:98 に await write({ type: "thinking" }); 1行
  G: <think>ブロックフィルタ → chat.ts バッファ処理に追加
  C: Summary注入位置 → chat.ts の history 配列末尾-2に差し込み

Phase 2 — 今週・中コスト:
  N: 文分割器 → backend/main.py に pysbd ベース SentenceDivider を組み込む
  B: Lorebook → db.ts に lorebook テーブル + persona.ts に注入ロジック
  I: Lerp表情blending → viewer.ts の setEmotion() を lerp 遷移に変更
  J: VRMA hipドリフト修正 → viewer.ts の VRMA ローダーに reAnchorRootPositionTrack()

Phase 3 — 次フェーズ:
  A: BASED RAG / D1 FTS → db.ts + chat.ts への意味検索統合
  O: TTS並列キュー → N と組み合わせ
  H: ML Lip Sync → viewer.ts に wLipSync 導入
  P: nudge skip_memory → backend nudge ハンドラを修正

Phase 4 — 将来:
  E: Q&Aリフレクション / Vectorize
  Q: LLM割り込み処理
  F: Module/Injectionシステム
```
