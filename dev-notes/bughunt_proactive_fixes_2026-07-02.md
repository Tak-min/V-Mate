# プロアクティブバグ修正ログ — 2026-07-02

自律的なコードベース調査で見つけたバグを事前に修正。全件 BUILD SUCCEEDED(iOS xcodebuild / Worker tsc --noEmit)で確認済み。

---

## 修正1: SpeechQueue.swift — processQueue() 二重起動 [HIGH]

**ファイル:** `ios/VMate/Sources/Audio/SpeechQueue.swift`

**症状:** TTS が途中で途切れる・`isSpeaking` が早期に `false` になり聞き取り再開が早すぎる。

**原因:** `enqueue()` が同じ同期ブロック内で複数回呼ばれると(e.g. `SentenceSplitter.feed()` が複数文を同時返却)、`Task { await processQueue() }` はスケジュールされるだけで即実行されない。そのため2回目の `enqueue()` も `playing == false` を見て `processQueue()` を再スケジュールし、二重起動が発生する。

2つ目の processQueue が起動すると:
1. `queue.isEmpty` が true になっている(1つ目が消費済み)
2. ループを抜けて `playing = false`, `isSpeaking = false` を設定
3. 1つ目がまだ再生中なのに `isSpeaking` が偽になり、聞き取り再開が早発する

**修正:** `Task` スポーン前に `playing = true` を同期的にセット。

```swift
if !playing {
    playing = true          // ← ここで即セット
    Task { await processQueue() }
}
```

**注:** `processQueue()` 内の `playing = true` は削除(今は enqueue 側で設定)。

---

## 修正2: SpeechRecognizer.swift — finishCapture 後の stale コールバック [MEDIUM]

**ファイル:** `ios/VMate/Sources/Audio/SpeechRecognizer.swift`
**クラス:** `AudioCapturePipeline`

**症状:** 非常に稀なケースで、前ターンの認識結果テキストが次ターン開始後に届き、前ターンのテキストが `send()` される。

**原因:** `finishCapture()` が `task = nil` してから `cancelCapture()`(次 arm 時)が呼ばれるまでに時間差がある。`cancelCapture()` は `task?.cancel()` を呼ぶが、`task` がすでに nil なのでキャンセルできない。古い認識タスクのコールバックが新ターン開始後に届く可能性がある(通常は 1.2s の resumeListeningDelay が緩衝するが理論的には起こり得る)。

**修正:** `finishCapture()` でタスク参照を `finishingTask` に退避。`cancelCapture()` が両方をキャンセルするように変更。

```swift
private var finishingTask: SFSpeechRecognitionTask?

private func finishCapture() {
    request?.endAudio()
    request = nil
    finishingTask = task   // ← タスク参照を退避
    task = nil
}

private func cancelCapture() {
    task?.cancel()
    task = nil
    finishingTask?.cancel()  // ← 次ターン開始時に古いタスクもキャンセル
    finishingTask = nil
    request = nil
}
```

`reset()` でも `finishingTask?.cancel()` を追加。

---

## 修正3: db.ts — setSummary の非原子的2重KV書き込み [MEDIUM]

**ファイル:** `worker/src/db.ts`

**症状:** 会話要約が正しく更新されているのに、次回リクエストで同じメッセージ群が再要約される。

**原因:** `setSummary()` が `conversation_summary` と `summary_through_id` を別々の `setKv()` で書いていた。Worker が2回の書き込みの間でCPU時間切れ等で終了すると、`summary_through_id` だけが古い値のまま残り、次回 `summarizeOldHistory()` が同じメッセージ群を対象に再要約する。

**修正:** `db.batch()` で2つの upsert を1トランザクションにまとめる。

```typescript
await this.db.batch([
  this.db.prepare(upsertSql).bind(userId, "conversation_summary", summary),
  this.db.prepare(upsertSql).bind(userId, "summary_through_id", String(throughId)),
]);
```

---

## 修正4: chat.ts — work 関数のトップレベル try-catch 欠落 [MEDIUM]

**ファイル:** `worker/src/chat.ts`

**症状:** D1/KVへのアクセス(messagesOn, addMessage, addAffinity, gatherLorebook等)が失敗した場合、SSEストリームがクライアント側で突然切れ、エラーイベントも届かない。

**原因:** `work` 非同期関数内でLLMストリームは try-catch されているが、それより前後の `store.*` 呼び出しは素のまま。これらが throw すると `execCtx.waitUntil(work)` が unhandled rejection になり、TransformStream の readable 側も途中で終了する。

**修正:** `work` 関数全体をトップレベル try-catch で囲み、予期しないエラーを `{ type: "error" }` SSEで通知してから writer を閉じる。

```typescript
const work = (async () => {
  try {
    // 既存の全処理
  } catch (err) {
    try {
      await write({ type: "error", message: `予期しないエラー (${name})。` });
      await writer.close();
    } catch { /* writer already closed */ }
  }
})();
```

---

## 修正5: db.ts — gatherLorebook() の try-catch 欠落 [HIGH — オーケストレーターが追加]

**ファイル:** `worker/src/db.ts`

**症状:** `lorebook` テーブルが D1 に存在しない状態(= `schema_v2.sql` 未適用)でデプロイすると、  
`gatherLorebook()` が SQL error を throw し、`chat.ts` の外側 try-catch が捕捉して  
クライアントにエラーイベントが届く。事実上「新機能をデプロイするとチャットが壊れる」。

**原因:** iOS bugfind エージェントが Lorebook 機能を実装した際、`gatherLorebook()` に  
try-catch を付け忘れた。`searchSimilarMessages()` には try-catch があるのにそちらだけ抜けていた。

**修正(オーケストレーターが手動適用):**
```typescript
async gatherLorebook(...): Promise<string> {
  try {
    // 既存のSQLクエリ...
  } catch {
    // lorebook テーブルが未作成(schema_v2.sql 未適用)の場合は空文字を返す
    return "";
  }
}
```

これにより `schema_v2.sql` 未適用の状態でもチャットが正常動作する。

**注:** `schema_v2.sql` を D1 に適用するまで Lorebook 機能は沈黙するが、クラッシュはしない。

---

## 確認済みビルド状態

- **iOS:** `xcodebuild` → **BUILD SUCCEEDED** (iPhone 17 / iOS 26.5)
- **Worker TS:** `tsc --noEmit` → **エラーなし**

---

## 未修正の既知事項(意図的に放置)

- `SpeechQueue`: `stop()` 後も prefetch タスクがネットワーク往復を完了させる(TTSクォータを1件余分に消費する可能性)→ linter が `activeFetchTask`/`pendingFetchTask` を追加済みで対処された
- `APIClient`: 429レスポンスボディをバイト単位で読む非効率 → 軽微、優先度低
- `CompanionViewModel`: `bootstrap()` の `try? APIClient.shared.fetchState()` がエラーをサイレントに飲む → nil 時 UI がそれを graceful に扱うため現状維持
