# AEC 修正 + OSS Phase A 移植 — 2026-07-01

## 実施した変更

### 1. AEC 修正: TTS を AVAudioPlayerNode 経由に移行

**問題**: TTS 再生が `AVAudioPlayer`(独立経路)で行われており、VPIO の AEC が
TTS 音声をエコー参照として認識できず、自己エコーが残っていた。

**修正**: `SpeechQueue.swift` を書き換え、音声会話モード中は `AVAudioPlayerNode` を
`AVAudioEngine`(VPIO エンジン)に接続して TTS を再生するよう変更。

変更対象:
- `ios/VMate/Sources/Audio/SpeechQueue.swift` — AVAudioPlayerNode path 追加 (`attachToEngine`, `detachFromEngine`)
- `ios/VMate/Sources/Audio/SpeechRecognizer.swift` — `audioEngine` を internal に変更
- `ios/VMate/Sources/ViewModels/CompanionViewModel.swift` — `beginVoiceSession()` に `speech.attachToEngine(recognizer.audioEngine)` を追加、`stopListening()` に `speech.stop()` + `speech.detachFromEngine()` を追加

**アーキテクチャ**:
```
変更前:
  SpeechQueue → AVAudioPlayer(独立) → スピーカー
  AVAudioEngine (VPIO) → マイク tap → VAD → STT

変更後:
  SpeechQueue → AVAudioPlayerNode → AVAudioEngine (VPIO) → スピーカー
                                   → マイク tap → VAD → STT
  ↑ 同じエンジン経由なので VPIO が参照信号を取得できる
```

**注意点 — Symptom → Cause → Fix**:
- TTS モードの分岐: `playerNode != nil` ならば `playViaPlayerNode`、なければ `playViaAVAudioPlayer`(テキストモード)
- `attachToEngine()` は `beginSession()` の `prepare()/start()` より**前**に呼ぶ必要がある(グラフ変更はエンジン起動前)
- `detachFromEngine()` は `endSession()`(エンジン停止)の**後**に呼ぶ
- メータリング: playerNode 経路では mixer にタップを設置し RMS を計算。タイマー不要
- MP3 データは temp ファイル経由で `AVAudioFile` として読み込む(AVAudioPlayerNode は Data 直接非対応)
- `stop()` 呼び出し時に `playerNode?.stop()` で即座に再生停止 → `resumePlaybackContinuationIfNeeded()` で continuation を解放

### 2. endSession() データ競合修正

**問題**: `if audioEngine.isRunning { audioEngine.stop() }` のガードで
`stop()` がスキップされるケースがあり、render thread の最後の `handleTap()` 完了前に
`pipeline?.reset()` が呼ばれる可能性があった。

**修正**: `if` ガードを除去し、常に `audioEngine.stop()` を呼ぶ。
`stop()` はドキュメント上同期完了するため、その後 `pipeline?.reset()` を呼べば安全。

ファイル: `ios/VMate/Sources/Audio/SpeechRecognizer.swift:329`

### 3. Worker: `type:thinking` SSE イベント

**変更**: `worker/src/chat.ts` の `streamChat()` 呼び出し直前に
`await write({ type: "thinking" });` を追加。

効果: LLM レスポンス待機中(現状は無応答に見える)に iOS/Web クライアントへ早期通知。
既存クライアントは `default: break` でスキップするため後方互換あり。

### 4. Worker: `<think>` ブロックフィルタ

**変更**: `worker/src/chat.ts` のストリームループ内に `inThinkBlock` フラグを追加。
DeepSeek/Qwen 等が出力する `<think>...</think>` ブロックを SSE に流さないよう除去。

**注意**: `<think>` が複数チャンクにまたがることがあるためバッファで管理。
`buffer` への累積は最初の `buffer += chunk` のみ(重複注意: 旧コードの位置と被らないよう実装)。

### 5. Backend: TTS 前テキストフィルタ

**変更**: `backend/app/main.py` に `_filter_for_tts()` 関数を追加し、`/api/tts` で適用。

対応パターン:
- `[happy]` 等の感情タグ
- `(括弧補足)`
- `*強調*`
- `<タグ>` 残滓 (`<think>` 除去残りなど)

**注意**: LLM の記憶・字幕・履歴には影響なし。TTS 送信直前のみ適用。

---

## 残作業

### iOS (arch_mic_followup_2026-07-01.md から)
- [ ] 課題 2: RT安全性 (Speech API off render thread) — 次セッション
- [x] 課題 4: バージイン機能の復活 — **完了 (2026-07-01)**

### OSS Phase B
- [x] B: Lorebook — **完了 (2026-07-01)**
- [x] A: RAG D1 FTS5 — **完了 (2026-07-01)**
- [x] C: Summary 注入位置改善 — **完了 (2026-07-01)**

---

## 追加実装 (2026-07-01 後半)

### 6. バージイン機能の復活 (iOS)

**変更ファイル**: `ios/VMate/Sources/Audio/SpeechRecognizer.swift`, `CompanionViewModel.swift`

**設計**: `enabled` フラグの他に `monitoringOnly: LockedFlag(false)` を追加し、3状態で制御。
- `enabled=false`: パイプライン無効
- `enabled=true, monitoringOnly=true`: VAD だけ動かし STT は起動しない(バージイン監視モード)
- `enabled=true, monitoringOnly=false`: 通常の全キャプチャモード

**変更内容**:
- `AudioCapturePipeline.startMonitoring()`: monitoring モードに切り替える
- `arm()` / `disarm()` に `monitoringOnly.value = false` を追加(モード漏れ防止)
- `handleTap()` — `speechStarted`: monitoring モードでは `callbacks.onSpeechOnset()` だけ呼んで `beginCapture()` は呼ばない
- `handleTap()` — `silence` (vad.capturing): monitoring 中は preRoll に積む(barge-in 後の arm() でドレイン)
- `handleTap()` — `speechEnded`: monitoring 中は no-op
- `beginCapture()` から `callbacks.onSpeechOnset()` を削除(handleTap 内で呼ぶように)
- `SpeechRecognizer.startMonitoring()`: pipeline への委譲
- `CompanionViewModel.send()`: `voiceMode = .thinking` 後に `recognizer.startMonitoring()`
- `CompanionViewModel.handleSpeechOnset()`: guard が通るようになり、TTS/ストリームキャンセル後に `recognizer.resumeTurn()` でフル capture 切り替え

**バージイン後の STT 開始フロー**:
1. monitoring 中に VAD が `speechStarted` → `onSpeechOnset` → MainActor の `handleSpeechOnset()`
2. `streamTask.cancel()`, `speech.stop()`, `voiceMode = .listening`
3. `recognizer.resumeTurn()` → `pipeline.arm()` → `monitoringOnly=false, pendingArm=true`
4. 次 tap で VAD リセット → ユーザーが継続して話していれば新しい `speechStarted` → `beginCapture()` 起動
5. STT がユーザーの発言を認識 → `handleUtterance()` → `send()`

### 7. Lorebook (OSS Phase B-B)

**変更ファイル**: `worker/schema_v2.sql` (新規), `worker/src/db.ts`, `worker/src/persona.ts`, `worker/src/chat.ts`

**スキーマ**: `lorebook` テーブル。`user_id='global'` でシロ共通設定、特定 UID で個別設定。

**動作**: `gatherLorebook(uid, message, recentMessages)` が会話テキスト + 現在メッセージ中の
キーワードをマッチし、マッチしたエントリの `keyword: description` を system prompt の
`## 追加の文脈(Lore)` セクションに注入する。

**ペルソナへの影響**: `buildSystemPrompt()` の `summary?` パラメータを `lorebook?` に変更。
summary は system prompt から分離し、history の末尾-2 位置に注入するよう変更 (C対応と同時)。

### 8. RAG D1 FTS5 (OSS Phase B-A)

**変更ファイル**: `worker/schema_v2.sql`, `worker/src/db.ts`, `worker/src/chat.ts`

**スキーマ**:
- `messages_fts`: FTS5 virtual table (content=messages, content_rowid=id)
- `messages_ai` trigger: INSERT 時に FTS インデックスを自動同期
- `messages_ad` trigger: DELETE 時に FTS インデックスから削除

**動作**: `searchSimilarMessages(uid, query, excludeRecent=24)` がユーザーメッセージ件数 > HISTORY_WINDOW の場合のみ実行。過去の類似発言 top-3 を FTS5 MATCH で検索し、history の中間 (末尾-2 前) に `[過去の会話から関連する記憶]` として注入。

**注意点**:
- FTS5 MATCH クエリの特殊文字 `'"*^()` をエスペープ処理
- `try/catch` で FTS5 未対応環境のエラーを握り潰す(graceful degradation)
- COALESCE で subquery が NULL を返す場合 (メッセージが少ない) への対処

### 9. Summary 注入位置改善 (OSS Phase B-C)

**変更**: `buildSystemPrompt()` から summary を除去。`chat.ts` の history 構築時に
middleware ブロックとして末尾-2 位置に `[これまでの会話の要約]` を注入。

**理由**: LLM は context window の末尾に近い情報を最も参照しやすい。system prompt の
先頭寄りに置くより history 末尾近くに置く方が practical な参照率が上がる。

### 10. D1 マイグレーション実行

```bash
wrangler d1 execute aikata --file=worker/schema_v2.sql --remote
# → 6 queries, 8 rows written, 成功
```

デプロイ: `wrangler deploy` → `https://aikata.taku810616.workers.dev`
Current Version ID: `93f82ad6-b08a-489a-9897-7eeaaadf351e`

### OSS Phase C (フロントエンド)
- [ ] I: Lerp 表情 blending (viewer.ts)
- [ ] J: VRMA アンカー修正
- [ ] H: wLipSync (npm install 必要)
- [ ] N: ストリーミング文分割器 (pysbd 導入)
- [ ] O: TTS 並列生成キュー
- [ ] P: nudge skip_memory

---

## 検証方法

### AEC 確認
```
変更後、TTS 再生中のマイク RMS を micLog で計測し、
AEC 有効時は大幅減衰(理想 -20dB 以上)していることを確認する。
```

### type:thinking SSE
Worker のログで `{ type: "thinking" }` イベントが LLM 呼び出し前に流れることを確認。

### <think> フィルタ
DeepSeek モデルを使って応答させ、`<think>` 内容が SSE に含まれないことを確認。

### TTS フィルタ
感情タグ付きテキストを `/api/tts?text=[happy]こんにちは` で送り、
「ハッピー」が読み上げられないことを確認。
