# iOS マイク アーキテクチャ課題 — 次セッション対応メモ (2026-07-01)

このファイルは今セッションで修正できなかった構造的問題のリスト。
次のAIエージェントが「なぜ変更が必要か」をゼロから再調査しなくて済むよう記録する。

---

## 1. AEC が実質効いていない [HIGH]

### 症状
`.voiceChat` AVAudioSession を使っているのに TTS の音声がマイクに回り込む。
warmup/resume 遅延で症状を抑えているだけで根本解決できていない。

### 真因
TTS 再生は `SpeechQueue.swift` 内の `AVAudioPlayer(data:)` が担っている。
これは STT 用の `AVAudioEngine` とは**独立した経路**で再生される。

iOS の `.voiceChat` モード (Voice-Processing I/O = VPIO) のエコーキャンセラは、
「同じ VPIO 出力スコープにレンダーされた信号」を参照音として使う。
独立した `AVAudioPlayer` の出力は VPIO のエコー参照に供給されない可能性が高く、
現状では AEC がほとんど機能していないと考えられる。

### 必要な変更
TTS 再生を `AVAudioEngine` 内の `AVAudioPlayerNode` 経由に移行する。

```
現状:
  SpeechQueue → AVAudioPlayer (独立) → スピーカー
  AVAudioEngine (VPIO) → マイク tap → VAD → STT

目標:
  SpeechQueue → AVAudioPlayerNode → AVAudioEngine (VPIO) → スピーカー
                                                          → マイク tap → VAD → STT
  ↑ 同じエンジン経由なので VPIO が参照信号を取得できる
```

変更対象:
- `ios/VMate/Sources/Audio/SpeechQueue.swift` — `AVAudioPlayer` → `AVAudioPlayerNode`
- `ios/VMate/Sources/Audio/SpeechRecognizer.swift` — `AVAudioEngine` に playerNode をアタッチ
- `ios/VMate/Sources/ViewModels/CompanionViewModel.swift` — SpeechQueue/SpeechRecognizer の接続

検証方法: 変更後、TTS 再生中のマイク RMS を `micLog` で計測し、
AEC 有効時は大幅減衰(理想 -20dB 以上)していることを確認する。

---

## 2. レンダースレッドからの Speech API 呼び出し [HIGH]

### 症状
現状では目立ったドロップアウトはないが、リアルタイム安全性の保証がなく、
将来的にオーディオドロップアウトや優先度逆転を引き起こす可能性がある。

### 真因
`AudioCapturePipeline.handleTap()` はオーディオレンダースレッドから呼ばれる。
その中で以下の非 RT-safe な処理を直接実行している:

```swift
// handleTap() → render thread から呼ばれる
beginCapture()       // SFSpeechAudioBufferRecognitionRequest() + recognitionTask(with:)
cancelCapture()      // task?.cancel() — SFSpeechRecognitionTask のスレッド安全性未保証
finishCapture()      // request?.endAudio()
```

`SFSpeechRecognizer.recognitionTask(with:)` は XPC セッション起動を含む可能性があり、
リアルタイムスレッドでの呼び出しは Apple の推奨に反する。

### 必要な変更
`beginCapture`/`cancelCapture`/`finishCapture` の Speech API 操作を render スレッドから外す。

設計案:
1. render スレッドは「バッファを lock-free リングに積む」と「VAD 判定」だけを行う
2. Speech API 操作は dedicated serial DispatchQueue か MainActor で実行
3. バッファ落ちを防ぐため、「onset 検出 → Speech タスク起動」間の時間は
   世代カウンタ(世代ID)で担保し、古い世代のコールバックは破棄する

```swift
// 概念コード
// render thread:
case .speechStarted:
    currentGen += 1
    pendingBuffers.append(contentsOf: preRoll.drainAndClear())
    pendingBuffers.append(buffer)
    let gen = currentGen
    let drained = pendingBuffers
    pendingBuffers = []
    DispatchQueue.main.async {
        self.startRecognition(gen: gen, preBuffers: drained)
    }

// MainActor:
func startRecognition(gen: Int, preBuffers: [AVAudioPCMBuffer]) {
    guard gen == currentGen else { return }  // stale onset は無視
    let req = SFSpeechAudioBufferRecognitionRequest()
    ...
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
        self?.handleResult(gen: gen, result: result, error: error)
    }
    for buf in preBuffers { req.append(buf) }
}
```

変更対象: `ios/VMate/Sources/Audio/SpeechRecognizer.swift`(AudioCapturePipeline クラス全体)

---

## 3. `endSession()` と in-flight `handleTap()` のデータ競合 [HIGH]

### 症状
まれにクラッシュまたは認識の不整合が起きる可能性がある。
Swift 6 strict concurrency では本来警告対象。

### 真因
`SpeechRecognizer.endSession()` は MainActor から `pipeline?.reset()` を呼ぶが、
`removeTap(onBus:)` / `audioEngine.stop()` はタップの最後の呼び出しが完了するまで
ブロックしない(ドキュメントに明示がない)。

`reset()` が `request/task/vad/preRoll` を触る同タイミングで、
最後の `handleTap()` がレンダースレッドから同じ変数にアクセスする可能性がある。

### 必要な変更
`endSession()` を以下の順序に変更し、tap が確実に停止してから reset する:

```swift
func endSession() {
    running = false
    audioEngine.inputNode.removeTap(onBus: 0)
    audioEngine.stop()           // ← stop() は同期完了するはず
    pipeline?.reset()            // tap 停止後に呼ぶ
    pipeline = nil
    finalText = ""
}
```

または `AudioCapturePipeline` の変数を actor で保護する抜本対応。

変更対象: `ios/VMate/Sources/Audio/SpeechRecognizer.swift`

---

## 4. バージイン(割り込み)が到達不能なデッドコード [MEDIUM]

### 症状
ユーザーが AI の発話中に話し始めても、AI が止まらず会話を聴けない(割り込み不可)。

### 真因
`handleSpeechOnset()` のガードは `voiceMode == .thinking || .speaking` だが、
これらのモードでは `pauseTurn()`(= `disarm()`)が呼ばれており、
`handleTap()` が `gate.process == false` で早期 return するため VAD が動かない。
結果として `onSpeechOnset` コールバック自体が発火せず、`handleSpeechOnset()` に到達しない。

```swift
// CompanionViewModel.handleSpeechOnset() は実質デッドコード
private func handleSpeechOnset() {
    guard voiceMode == .thinking || voiceMode == .speaking else { return }
    // ↑ ここに来るためには speechStarted が発火している必要があるが、
    //   .thinking/.speaking 中は disarm されているので発火しない
```

### 必要な変更
バージインを実現するには:
1. `.thinking`/`.speaking` 中も VAD だけは動かす(enabled は true のまま)
2. ただし `beginCapture()` は起動しない(request/task は生成しない)
3. VAD が `speechStarted` を検出したら `handleSpeechOnset()` を発火し、
   TTS を止めて `resumeTurn()` を呼ぶ

これには `AudioCapturePipeline` に「VAD だけ動かす監視モード」を追加する必要がある。
現在の `enabled` フラグを `enum PipelineMode { case off, monitoring, capturing }` に拡張する案が有力。

変更対象:
- `ios/VMate/Sources/Audio/SpeechRecognizer.swift` (AudioCapturePipeline)
- `ios/VMate/Sources/ViewModels/CompanionViewModel.swift`

---

## 優先度まとめ

| 課題 | 深刻度 | 推奨実施タイミング |
|------|--------|-----------------|
| 1. AEC (AVAudioPlayerNode 移行) | HIGH | 次セッション最優先 |
| 2. RT安全性 (Speech API off render thread) | HIGH | AEC 移行と同時 |
| 3. endSession データ競合 | HIGH | 比較的小さい変更、早めに対応 |
| 4. バージイン機能の復活 | MEDIUM | UX 改善フェーズ |

---

## 関連コミット / ファイル

- `69a8626` — cancelCapture/finishCapture 分割 (Phase 1)
- `ea72ac6` — onDeviceEverSucceeded + isSpeaking ループ修正 (Phase 2)
- `dev-notes/mic_stale_task_and_self_echo_2026-07-01.md` — Phase 1/2 の真因記録
- `ios/VMate/Sources/Audio/SpeechQueue.swift` — TTS 再生の実装(AEC 修正の変更対象)
- `ios/VMate/Sources/Audio/SpeechRecognizer.swift` — AudioCapturePipeline(RT安全性/データ競合の変更対象)

---

# OSS 転用候補リスト (次セッション実装待ち)

分析元: `dev-notes/predecessor_analysis_2026-06-30.md`(OSS 分析セクション)
ソースリポジトリ: z-waif / kimjammer-Neuro / moeru-ai-AIRI / Open-LLM-VTuber

---

## Phase A — 低コスト・高優先 (まず着手)

### D: `type:thinking` SSE イベント
- **ソース**: kimjammer/Neuro `neuro/signals.py`
- **移植先**: `worker/src/chat.ts:98` 付近、LLM 呼び出し直前
- **変更量**: 1行
```typescript
await write({ type: "thinking" });  // streamChat() 呼び出し直前に追加
```
- **iOS 側**: `APIClient.swift` の SSE パーサに `case "thinking":` を追加し「シロが考えています…」状態を表示
- **効果**: LLM レスポンス待機中の体験改善。現在は無応答に見える
- **注意**: 未知の type は既存クライアントがスキップするため後方互換あり

---

### G: `<think>` ブロックリアルタイムフィルタ
- **ソース**: moeru-ai/AIRI `packages/core-agent/src/runtime/response-categoriser.ts`
- **移植先**: `worker/src/chat.ts` ストリームループ内のバッファ処理
- **変更量**: 数行(バッファ保留ロジックを含む)
```typescript
// streaming 中に <think>...</think> を除去するフィルター
// ※ <think> が複数チャンクに分かれる場合があるためバッファで管理する
let buffer = '';
let inThinkBlock = false;

for await (const chunk of stream) {
  buffer += chunk;
  if (!inThinkBlock && buffer.includes('<think>')) {
    inThinkBlock = true;
  }
  if (inThinkBlock) {
    if (buffer.includes('</think>')) {
      buffer = buffer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      inThinkBlock = false;
    } else {
      continue; // </think> が来るまで SSE に流さない
    }
  }
  // 通常のトークン処理...
}
```
- **効果**: Groq/DeepSeek/Qwen 等の推論モデルが出力する `<think>` ブロックが TTS に流れるのを防ぐ

---

### M: TTS 前テキストフィルタ
- **ソース**: Open-LLM-VTuber `src/open_llm_vtuber/utils/tts_preprocessor.py`
- **移植先**: `backend/app/main.py` の TTS 呼び出し直前
- **変更量**: Python 関数1本追加
```python
import re

def filter_for_tts(text: str) -> str:
    """[emotion]タグ、(括弧)、*アスタリスク*、<タグ> を TTS 送信前に除去"""
    text = re.sub(r'\[.*?\]', '', text, flags=re.DOTALL)   # [happy] 等の感情タグ
    text = re.sub(r'\(.*?\)', '', text, flags=re.DOTALL)   # (補足)
    text = re.sub(r'\*.*?\*', '', text, flags=re.DOTALL)   # *強調*
    text = re.sub(r'<[^>]+>', '', text)                    # <think> 残滓
    return text.strip()
```
- **効果**: Aivis TTS に `[happy]` 等がそのまま渡って読み上げられるバグを防ぐ
- **注意**: LLM メモリ・字幕・履歴には影響させないこと(TTS 直前のみ適用)

---

### N: ストリーミング文分割器
- **ソース**: Open-LLM-VTuber `src/open_llm_vtuber/utils/sentence_divider.py`
- **移植先**: `backend/app/main.py` の `/api/chat` ストリーム受信後
- **依存**: `pysbd`, `langdetect` (`requirements.txt` に追加)
- **変更量**: Python ファイル1本 + 呼び出し追加
- **効果**: LLM ストリームの最初の文が揃った瞬間に TTS 生成を開始 → 初音レイテンシを大幅短縮
- **実装方針**:
  1. `pysbd.Segmenter(language="ja", clean=False)` でトークン蓄積文字列を随時分割
  2. `faster_first_response=True` モードで最初の文のみ短めの句読点でも即送信
  3. `[emotion]` タグを保持したまま分割できるのが pysbd の強み
- **参考**: z-waif ではなく Open-LLM-VTuber の実装が日本語対応で完成度が高い

---

## Phase B — 中コスト・高優先 (Phase A 完了後)

### B: Lorebook テーブル + プロンプト注入
- **ソース**: z-waif `z-waif/utils/lorebook.py` + `Configurables/Lorebook.json`
- **移植先**:
  - `worker/src/db.ts` — `lorebook` テーブル追加(D1 migration)
  - `worker/src/persona.ts` — `buildSystemPrompt()` に `lorebook: string` 引数追加
  - `worker/src/chat.ts` — `handleChat()` 内で `gatherLorebook()` 呼び出し
- **DB スキーマ**:
```sql
CREATE TABLE lorebook (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  TEXT NOT NULL,  -- 'global' でシロ共通設定
  keyword  TEXT NOT NULL,
  description TEXT NOT NULL,
  cooldown INTEGER DEFAULT 7
);
```
- **実装スニペット** (`db.ts`):
```typescript
async gatherLorebook(userId: string, message: string, recentMessages: MessageRow[]): Promise<string> {
  const { results } = await this.db
    .prepare("SELECT keyword, description FROM lorebook WHERE user_id = ?1 OR user_id = 'global'")
    .bind(userId).all<{keyword: string; description: string}>();
  const allText = recentMessages.map(m => m.content).join(' ') + ' ' + message;
  const matched = results.filter(e => allText.includes(e.keyword));  // 日本語は includes() で部分一致
  if (matched.length === 0) return '';
  return 'Lore:\n' + matched.map(e => `${e.keyword}: ${e.description}`).join('\n');
}
```
- **注意**: 日本語は `\b` 単語境界が使えないため `includes()` または形態素解析を使う
- **初期データ**: シロの設定(趣味・口癖・背景)を seed として投入する

---

### A: BASED RAG / D1 FTS5
- **ソース**: z-waif `z-waif/utils/based_rag.py`
- **移植先**:
  - `worker/src/db.ts` — `searchSimilarMessages()` 追加
  - `worker/src/chat.ts` — `handleChat()` 内で RAG 結果を system prompt に注入
- **D1 FTS5 セットアップ** (`schema.sql` に追加):
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(content, content=messages, content_rowid=id);

-- トリガーで messages と同期
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
```
- **実装スニペット** (`db.ts`):
```typescript
async searchSimilarMessages(userId: string, query: string, excludeRecent = 20): Promise<MessageRow[]> {
  const { results } = await this.db
    .prepare(`SELECT m.id, m.role, m.content
              FROM messages m JOIN messages_fts f ON m.id = f.rowid
              WHERE m.user_id = ?1 AND f.content MATCH ?2
              AND m.id < (SELECT MIN(id) FROM (
                SELECT id FROM messages WHERE user_id = ?1
                ORDER BY id DESC LIMIT ?3))
              ORDER BY rank LIMIT 3`)
    .bind(userId, query, excludeRecent)
    .all<MessageRow>();
  return results;
}
```
- **注意**: D1 の `CREATE VIRTUAL TABLE` は `wrangler d1 execute` で動作確認が必要。schema.sql に追加してテスト実行すること
- **効果**: 数週間前の会話内容をシロが「覚えている」体験が生まれる

---

### C: Rolling Summary の注入位置改善
- **ソース**: z-waif `API/api_controller.py:encode_new_api()`
- **移植先**: `worker/src/chat.ts:89-90` の `history` 組み立て部分
- **変更量**: 数行
```typescript
// 現状: summary を system prompt 冒頭に注入
// 改善: summary を history 配列の末尾-2位置に挿入することで LLM が忘れにくくなる
const historyWithSummary = summary
  ? [
      ...history.slice(0, -2),
      { role: 'system', content: `[過去の会話の要約] ${summary}` },
      ...history.slice(-2),
    ]
  : history;
```
- **効果**: 系プロンプト末尾に近い位置に要約を置くと LLM が参照しやすくなる

---

## Phase C — 中コスト・中優先 (フロントエンド / UX 改善)

### H: ML ベースリップシンク (wLipSync)
- **ソース**: moeru-ai/AIRI `packages/stage-ui-three/src/composables/vrm/lip-sync.ts`
- **移植先**: `frontend/src/features/vrm/viewer.ts` のリップシンク処理
- **依存**: `npm install @tachibana-ak/wlipsync`(WASM パッケージ、フロントエンド側で動作)
- **現状**: 振幅ベース(音量のみ)→ 母音が反映されない
- **改善後**: WASM 音素推定で `AA/IH/OU` 等の VRM モーフをセット、winner+runner-up blending でなめらか補間

---

### I: Lerp 表情 blending + 自動リセット
- **ソース**: moeru-ai/AIRI `packages/stage-ui-three/src/composables/vrm/expression.ts`
- **移植先**: `frontend/src/features/vrm/viewer.ts:setEmotion()`
- **実装方針**:
```typescript
// requestAnimationFrame ループ内で毎フレーム実行
function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
// currentValue += (target - currentValue) * rate で lerp
// setEmotionWithResetAfter(name, ms) で一定時間後に neutral へ自動リセット
```
- **注意**: iOS WebView は 30fps に制限される場合あり。`delta` を正確に計測して rate を補正

---

### J: VRMA ルート位置アンカー修正
- **ソース**: moeru-ai/AIRI `packages/stage-ui-three/src/composables/vrm/animation.ts:reAnchorRootPositionTrack()`
- **移植先**: `frontend/src/features/vrm/viewer.ts` の VRMA 読み込み処理
- **効果**: VRMA アニメーション再生時のキャラ画面外ドリフトを防止
- **変更量**: 関数1本追加 + ローダー呼び出し1行

---

### O: TTS 並列生成 + 順序保証キュー
- **ソース**: Open-LLM-VTuber `src/open_llm_vtuber/conversations/tts_manager.py`
- **移植先**: `backend/app/main.py` の TTS pipeline
- **前提**: N(文分割器)を先に導入してから追加
- **効果**: 「文完成 → 並列 TTS 生成 → 順序通り再生」で TTS レイテンシを並列化

---

### P: nudge の `skip_memory` フラグ
- **ソース**: Open-LLM-VTuber `src/open_llm_vtuber/conversations/conversation_handler.py`
- **移植先**: `backend/app/main.py` の `/api/nudge` ハンドラ
- **変更量**: 低(nudge 応答を conversations テーブルに保存しないフラグを追加するだけ)
- **効果**: AI 自発発言(挨拶・アイドル声かけ)が会話コンテキストを汚染しなくなる

---

## Phase D — 将来 (後回し可)

### E: Q&A リフレクションメモリ
- **ソース**: kimjammer/Neuro `neuro/modules/memory.py` (ChromaDB → D1/Vectorize に移植)
- **移植先**: `worker/src/persona.ts:factExtractionPrompt()` 改修 + `db.ts` の facts テーブル拡張
- **コスト**: 中〜高 (Vectorize 利用の場合は高)

### Q: LLM 割り込み処理パターン
- **ソース**: Open-LLM-VTuber `conversation_handler.py:handle_individual_interrupt()`
- **移植先**: iOS VAD バージイン + backend SSE キャンセル
- **前提**: iOS 側バージイン復活(アーキテクチャ課題 #4)が完了してから

### K: 視線追従モード抽象化
- **ソース**: moeru-ai/AIRI `packages/stage-ui-three/src/composables/eye-tracking.ts`
- **移植先**: `frontend/src/features/vrm/viewer.ts` gaze 処理
- **備考**: iOS では cursor モードが使えないため camera モードのみ実装

### F: Module/Injection 優先度システム
- **ソース**: kimjammer/Neuro `neuro/modules/prompter.py`
- **移植先**: `worker/src/persona.ts:buildSystemPrompt()` のモジュール化リファクタリング
- **前提**: A/B/C/E がすべて実装済みで整理フェーズに入ってから

---

## 実装順まとめ

```
Phase A (低コスト先着順):
  D → type:thinking SSE (chat.ts 1行 + iOS 数行)
  G → <think> ブロックフィルタ (chat.ts バッファ処理)
  M → TTS 前タグフィルタ (backend/main.py Python 関数1本)
  N → ストリーミング文分割器 (backend pysbd 導入)

Phase B (中コスト・メモリ強化):
  B → Lorebook (D1 migration + persona.ts)
  C → Summary 注入位置 (chat.ts 数行)
  A → RAG D1 FTS5 (schema + db.ts + chat.ts)

Phase C (フロントエンド UX):
  I → Lerp 表情 blending (viewer.ts)
  J → VRMA アンカー修正 (viewer.ts)
  H → wLipSync 音素リップシンク (viewer.ts + npm)
  O → TTS 並列生成キュー (backend)
  P → nudge skip_memory (backend)

Phase D (将来):
  E → Q&A リフレクションメモリ
  Q → LLM 割り込み (バージイン復活後)
  K → 視線追従モード
  F → プロンプトモジュール化リファクタ
```
