# バグハント Iter.3 — iOS SpeechQueueがisPlayingポーリングのみでデッドロックしうる (2026-06-22)

## 症状(想定)
`ios/VMate/Sources/Audio/SpeechQueue.swift` の `playFromBackend` は
`while newPlayer.isPlaying { try? await Task.sleep(...) }` で再生完了をポーリングしていた。
`AVAudioPlayer.isPlaying` は音声割り込み(着信・他アプリの音声・Siri等)が起きた際に
即座に `false` へ落ちない/落ちないまま固まるケースがある(iOSのバージョン・状況依存の
既知の不安定さ)。その場合このループが永久に抜けず、`processQueue()` 全体(以降に
キューされたシロの発話すべて)が無限に止まる。

## 原因
再生完了の検知を `isPlaying` のポーリングだけに依存しており、`AVAudioPlayerDelegate` の
完了通知を使っていなかった。タイムアウトによる強制脱出経路も無かった。

## 修正
`SpeechQueue` を `AVAudioPlayerDelegate` に準拠させ、`audioPlayerDidFinishPlaying` /
`audioPlayerDecodeErrorDidOccur` で `CheckedContinuation` を解決する経路を主とし、
`newPlayer.duration + 2.0秒` のタイムアウトを保険として並走させた(どちらか早い方で
必ず抜ける)。`stop()` 呼び出し時にも継続を解決するようにし、バージイン等での
中断時に再生待ちがリークしないようにした。

## 検証
xcodebuild MCP(`build_sim`、scheme VMate、iPhone 17シミュレータ)でビルド成功・
警告0件・エラー0件を確認(実機/シミュレータでの音声割り込み再現テストは未実施。
次回起動時に着信シミュレーション等で確認するのが望ましい)。

## 注記
SourceKitの静的診断が `Emotion`型未検出・`AVAudioSession` macOS非対応 等を誤検知するが、
これはエディタのインデックスがiOSターゲットを認識していないだけの偽陽性(実際の
xcodebuild simビルドは成功している)。次にこのファイルを触るAIエージェントは
慌てず無視してよい。
