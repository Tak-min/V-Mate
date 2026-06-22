# バグハント — ハンズフリー音声会話が動かない/音声がたまに途切れる (2026-06-22)

## 経緯
前回セッション(`ios/dev-notes/handsfree_voice_conversation_2026-06-22.md`)で
iOS版ハンズフリー音声入力を実装したが、実機マイクでの動作確認は未実施だった。
ユーザーから「ハンズフリー音声会話ができない」「音声がたまに途切れる」の2件の
不具合報告を受け、loop-engineerスキルで原因調査→修正のサイクルを実施。

## 不具合1: ハンズフリー音声会話ができない

### 症状
iOSシミュレータ+ビルド検証(警告0・エラー0、VADユニットテスト6件PASS)は通っていたが、
実機での発話→認識→自動送信が機能しない(ユーザー報告)。

### 原因
`ios/VMate/Sources/Audio/SpeechRecognizer.swift` の `beginCapture()` が
`req.requiresOnDeviceRecognition = true` を強制していた。これは
**SFSpeechRecognizerの既知の挙動**: 端末にその言語(ja-JP)のオンデバイス音声認識
モデルが未ダウンロードだと、オンデバイス指定の認識リクエストは**1件も結果を返さず
即座に失敗する**(無音のまま何も起きないように見える)。Siriや音声入力を日本語で
使ったことがない端末では高確率でこの状態になる。

**シミュレータでは再現しない**: `SFSpeechRecognizer.supportsOnDeviceRecognition` が
シミュレータ環境では基本 `false` を返すため、`requiresOnDeviceRecognition` 分岐に
そもそも入らない。これがビルド/シミュレータ検証が通っていたのに実機だけ動かない
というギャップの正体。

### 修正
`useOnDeviceRecognition`(初期true)を状態として持ち、1回でも「結果を1件も受け取れず
エラー終了」したオンデバイス認識セッションを検出したら、以後のセッションは
オンデバイスを諦めてサーバー認識にフォールバックするようにした。フォールバック発生時は
`onError(.transient, ...)` でユーザーに一度だけ通知する。

最初の発話1回分は失敗のままだが、2回目以降はサーバー認識で機能するようになる
(根本的にはオンデバイスモデルのダウンロード状況に依存するため、起動時に
事前ダウンロードを促す等の改善余地はあるが、今回は「動かないまま固まる」を
解消することを優先)。

## 不具合2: 音声がたまに途切れる

### 症状
ユーザー報告。発生条件(Web版/iOS版、再生中/認識中、ネットワーク状況との相関)は
未特定として前回セッションの申し送りに記載されていた。

### 原因
iOS版 `SpeechQueue.swift` ・ Web版 `frontend/src/features/voice/speech.ts` の両方で、
`processQueue()` が「現在の文のTTS取得(ネットワーク往復)→再生→完了を待つ→次の文の
TTS取得→再生」を**完全に逐次(直列)**で行っていた。文と文の間に必ず1回のTTS API
往復分の無音区間が生じる構造で、ネットワーク往復が速い時は気づかないほど短いが、
遅い時(回線状況やバックエンドの応答揺らぎ)に目立つ無音→「たまに途切れる」という
報告と一致する。Web版・iOS版どちらも同じ設計だったため、プラットフォーム間の
切り分けは不要だった(両方が原因だった)。

### 修正
両プラットフォームで「次に再生する文のTTSを、今の文の再生中に先読み(prefetch)する」
パイプライン化を実施。`processQueue()` をループの先頭で次アイテムのfetchを
`Task`/`Promise` として走らせ、現在アイテムの再生中に並行してネットワーク往復を
終えておくことで、文の切れ目での無音区間をほぼ解消する。

- iOS: `SpeechQueue.swift` — `makeFetchTask(_:) -> Task<Data?, Never>` を追加し、
  `processQueue()` でprefetchタスクを1つ先行させる。`playFromBackend` は
  fetch込みの旧実装から `play(data:)`(再生のみ)に分離。
- Web: `speech.ts` — `playFromBackend` を `fetchTTSBuffer`(fetch)と
  `playBuffer`(再生)に分離し、同様にprefetchを1つ先行させる。

**エッジケースの考慮**: prefetchタスクが計算された時点でqueueが空だった場合
(`queue.first`がnil)、次のアイテムがその後enqueueされても対応できるよう、
dequeue時に「prefetchがあればそれを使う、なければその場でfetchする」
(`prefetch ?? makeFetchTask(item)`)というフォールバックを入れている。
これがないと、再生の合間に新しい発話がenqueueされた場合にその発話がサイレントに
スキップされるバグになる(JS版はシングルスレッドのため`queue.shift()`から
`next = this.queue[0]`までの間に割り込みが入らないので発生しないが、Swift版は
async境界があるため明示的に保険を入れた)。

最初の文だけはfetch待ちが残る(これは応答生成中の"thinking"状態と被るため
体感上の影響は小さい)。

## 検証
- iOS: `xcodebuild` MCP `build_sim` — 警告0・エラー0。
- iOS: `test_sim` — VoiceActivityDetectorTests 6件全PASS(既存テスト、回帰なし)。
- iOS: `build_run_sim` — シミュレータ起動・クラッシュ無し確認。
- Web: `npm run build`(`tsc -b` + `vite build`)成功。

**未検証(このセッションの制約上不可)**: 実機マイクでのオンデバイス→サーバー
フォールバックの実際の発火確認、実際のTTS往復タイミングでの無音区間短縮の
聴感確認。次回起動時、実機での確認を推奨。

## ハマりどころ / gotcha
- SourceKitの静的診断(エディタ上の赤線)が `Emotion`/`APIClient`/`VoiceActivityDetector`
  を「スコープに見つからない」と誤検知する。これは前回のバグハントメモ
  (`bughunt_ios_speechqueue_deadlock_2026-06-22.md`)で既に記録済みの既知の偽陽性
  (エディタのインデックスがiOSターゲットを認識していないだけ)。実際の
  `xcodebuild` simビルドは成功している。次にこのファイルを触るAIエージェントは
  慌てず無視してよい。
- `requiresOnDeviceRecognition` は「対応している(`supportsOnDeviceRecognition`)」と
  「実際にオンデバイスで動く(モデルがダウンロード済み)」が別物、という点が
  Appleのドキュメントでは明示的に書かれていない落とし穴。シミュレータでは
  `supportsOnDeviceRecognition` がfalseになるため、実機専用の不具合になりやすい。

## 未着手 / 次回以降
- 実機での動作確認(オンデバイス→サーバーフォールバックの発火、TTS先読みの聴感)。
- オンデバイス音声認識モデルの事前ダウンロード促進(任意。根本対策ではあるが
  Apple側のAPIで直接コントロールできないため優先度は低い)。
