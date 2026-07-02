# 事前バグ潰し — SpeechQueue / CompanionViewModel (2026-07-02)

> コードベース全体の事前調査で発見した潜在バグ3件を修正。BUILD SUCCEEDED 確認済み。

---

## 修正1: `SpeechQueue.stop()` が in-flight TTS フェッチを止められない

**ファイル:** `ios/VMate/Sources/Audio/SpeechQueue.swift`  
**症状:** `stop()` を呼んでも、`processQueue()` が `await task.value`(TTS HTTP フェッチ待ち)で
ブロックされている場合、`resumePlaybackContinuationIfNeeded()` は `playbackContinuation == nil` なので
何もしない。フェッチが完了すると `play(data:)` が呼ばれ、`stop()` 後にも音声が再生される。

**根本原因:** `makeFetchTask(_:)` が返す `Task<Data?, Never>` はローカル変数に保持されており、
`stop()` がアクセスできない。

**修正:**
- `activeFetchTask` / `pendingFetchTask` 2つのプロパティを追加
- `processQueue()` で各タスクを割り当て
- `stop()` で `cancel()` してから `nil` に

**Gotcha:** `Task { try? await fetchTTS(...) }` はキャンセルされると `try?` が nil を返すため、
`await task.value` は nil を返す。`if let data = await task.value` が false になり、
ループが `!queue.isEmpty`(空)を見て自然終了する。追加の `guard` 等は不要。

---

## 修正2: `playViaPlayerNode` の `defer` 配置ミス

**ファイル:** `ios/VMate/Sources/Audio/SpeechQueue.swift:playViaPlayerNode`  
**症状:** `data.write(to: tmpURL)` が成功してファイルを作成したが書き込みが途中で失敗した場合、
`return` が実行される時点でまだ `defer` が登録されていない(Swift の defer は宣言行に到達した時点で
スタックに積まれる)。テンポラリファイルが `/tmp` に残存する。

**根本原因:**
```swift
do { try data.write(to: tmpURL) } catch { return }   // ← ここで return
defer { ... }  // ← return の後に宣言 → 登録されない
```

**修正:** `defer` を `do-catch` より前に移動した。

---

## 修正3: `CompanionViewModel.deinit` が `streamTask` をキャンセルしない

**ファイル:** `ios/VMate/Sources/ViewModels/CompanionViewModel.swift`  
**症状:** ViewModel が解放されても、SSE ストリームを回している `streamTask` が生き続ける。
`[weak self]` があるため実際のクラッシュは起きないが、ストリーム完了まで HTTP 接続が保持され、
`busy = false` コールバックが宙ぶらりんの状態になる。

**修正:** `deinit` に `streamTask?.cancel()` を追加。`Task.cancel()` はスレッドセーフなため
`@MainActor` deinit から直接呼んでも問題ない。

---

## 調査で確認した「バグではない」件

- `processQueue()` の二重起動リスク: フックが `enqueue()` 内で `playing = true` をタスク起動前に
  セットするよう修正済み(調査前に既に修正されていた)。
- `CheckedContinuation` の二重 resume: `resumePlaybackContinuationIfNeeded()` が nil チェックで
  one-shot 保護しているため安全。
- `finishCapture()` での `task = nil` 後のコールバック到着: `isFinal` コールバック後にタスクは
  自然終了しており、その後に `cancelCapture()` が呼ばれてもキャンセル対象がない(意図的設計)。
  前ターン結果が次ターンに混入するリスクは `finalText = ""` の `resumeTurn()` 内リセットで緩和。
- `APIClient.url()` の force unwrap: パスは内部定数、クエリ値は URLComponents が URL エンコード
  するため nil になりえない。

---

**ビルド結果:** `xcodebuild ... build → BUILD SUCCEEDED`  
**関連ファイル:** `SpeechQueue.swift`, `CompanionViewModel.swift`
