# Vision: マイク初期化の冒頭ロス + 応答レイテンシ改善 (2026-06-23)

## ユーザー要望(原文)
1. マイク初期化部分で最初の1〜2秒の音声が取れていない。改善ループを回すこと。
2. LLM応答時間が長く感じる。音声合成+バックエンド処理を見直して短縮し、没入感/人間性を高める。
3. 両方とも「自律的に問題点の発見と改善を分析を繰り返して」行うこと(承認待ちで止めない)。

## 既知の前提(今回のrecon結果)
- 同日(2026-06-23)に既に1回、VADのonset数フレーム(数十ms)ロストは
  `dev-notes/vad_onset_dropframes_and_sensitivity_2026-06-23.md` で修正済み。
  → 今回ユーザーが言う「1〜2秒」はそれより1〜2桁大きい。別の真因を疑う。
- 実機マイクテストは本セッションでも不可(環境制約)。ロジック改善+ユニットテスト+
  静的なアーキテクチャレビューで完結させ、実機要パラメータは申し送りにする
  (今日の前回ループと同じ運用方針)。

## 疑われる真因(コード読みから — architectで検証・優先順位付けすること)

### A. マイク初期化(iOS)
- `ios/VMate/Sources/ViewModels/CompanionViewModel.swift` の `resumeListening()` →
  `startListening()` は**会話の1ターンごとに** `recognizer.stop()` → `recognizer.start()`
  を呼んでいる(`handleUtterance`でstop、応答完了+TTS空で`resumeListening`からstart)。
  つまり「マイク初期化」は会話開始時の1回だけでなく**ターンごとに毎回発生**している。
- `SpeechRecognizer.start()` (`ios/VMate/Sources/Audio/SpeechRecognizer.swift:203`) は
  毎回 `audioEngine.prepare()` + `try audioEngine.start()` をフルでやり直す。
  `.voiceChat` モード(AEC有効)はエンジン再起動ごとにAEC収束が必要になりうる
  (業界的に既知: AEC再起動直後は数百ms〜数秒、検出感度/品質が不安定になりうる)。
- `VoiceActivityDetector` の `warmupMs=200`(`VoiceActivityDetector.swift:33`)はこの
  再起動コストを想定した値ではなく、TTS残響対策の「保険」として設定されたもの
  (`resumeListeningDelay=0.45` がメインの残響待ち)。AEC収束やエンジンの実ハード
  ウェアramp-upが200msを超える場合、ここが「冒頭が無音/低品質に見える」原因になりうる。
- 仮説: エンジンの破棄→再構築をターンごとに行わず、**エンジンは会話モード中ずっと
  起動したままにして、tap自体の有効/無効だけをソフトウェアフラグで切り替える**設計に
  すれば、「マイク初期化」が会話の最初の1回だけになり、(1)毎ターンの再初期化コストが
  消える (2) AEC再収束もターンごとに発生しなくなる可能性が高い。要architect検証。

### B. 応答レイテンシ(バックエンド)
- `backend/app/llm.py:65` `stream_chat()` が呼び出しごとに
  `async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:` で**新規クライアントを
  生成**している。TCP+TLS handshakeを毎ターン払っている(Keep-Alive接続の再利用なし)。
- `backend/app/tts.py:61` `synthesize()` も同様に毎回新規 `httpx.AsyncClient`。
- `backend/app/main.py:430-441` のSSEストリームは、感情タグが確定する(`EMOTION_TAG_RE`
  マッチ、または24文字超)まで**最初のトークンを一切クライアントに流さない**。これが
  「最初の一言が出るまで」の追加レイテンシになっている。
- TTSは `tts.synthesize()` がAPIから全MP3バイト列を受け取ってから返す(ストリーミング
  出力ではない)。Aivis Cloud APIがチャンク転送/ストリーミング出力に対応しているかは
  未確認(architect/code-architect段階でAPI仕様を確認すること)。
- iOS側 `SpeechQueue.swift` は既に次文のTTSを先読み(prefetch)しており、文間ギャップは
  対策済み。**最初の文**のTTS往復(コールドスタート)だけがボトルネックとして残る。

## Definition of Done
- [ ] iOS: 会話中の各ターンでマイク冒頭の音声(ユーザーが「聞き取り開始」表示直後に話した
      最初の発話)が一貫してテキスト化される設計に変更されている。ロジック変更点に
      ユニットテストがあり、`xcodebuild test -scheme VMate -only-testing:VMateTests
      -destination 'platform=iOS Simulator,name=iPhone 17'` が green。
- [ ] バックエンド: LLM/TTSの httpx クライアントが接続再利用される(プロセス内で
      共有・再利用、毎リクエスト新規生成しない)。`pytest` green。
- [ ] バックエンド: 最初のSSEトークンが出るまでの不要なバッファリングを削減(感情タグ
      確定前でも安全にテキストを出し始められるよう見直す、または許容できる理由を明記)。
- [ ] 変更点はdev-notes配下に日付つきで記録(根本原因→対策→検証→申し送り)。
- [ ] code-reviewer(+該当言語reviewer)のCRITICAL/HIGH指摘ゼロ。
- [ ] 各ステップでcommit、ユーザーfeedbackメモ([[feedback-vmate-push-deploy-every-turn]])
      に従い、確認待ちで止めずGitHub pushまで行う(Cloudflareデプロイはbackendのみ
      Renderの場合は対象外、フロントエンドがCloudflare Pages運用ならpush後の自動デプロイ
      まで確認する)。

## ガードレール
- 実機較正値(`minThreshold`/`noiseMargin`/`thresholdOffset`/`initialNoiseFloor`)は
  実機ログなしで変更しない(前回ループと同じ方針)。
- pbxproj手編集が必要な新規.swiftファイル追加は避け、既存ファイルに同居させる
  (前回ループのハマりどころを踏襲)。
