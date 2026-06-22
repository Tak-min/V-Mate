# VISION — リアルタイム会話体験(送信ボタン不要・連続会話)で人間と話す感覚に近づける

> loop-engineerスキルのアンカーファイル。バグハント用 `.loop/BUGHUNT_VISION.md`(収束済み)
> とは別ゴール。

## Goal
「いちいち音声認識→文字起こし→チャット欄確認→送信ボタン」ではなく、ユーザーが話すだけで
連続的に会話が回り、本当の人間と対話しているような感覚に近づける。

## Recon findings(2026-06-22)
- **Web版には既に実装済み**: `frontend/src/features/voice/recognition.ts` の `SpeechRecognizer`
  がVAD(音量RMS+ノイズフロア追従)でWeb Speech APIをゲートし、発話開始を自動検出→認識→
  沈黙(HANGOVER_MS=1100ms)で1ターン確定→自動送信→応答後に`resumeListening()`で自動的に
  マイクを開き直す、という完全ハンズフリーのループが`useCompanion.ts`の`voiceMode`
  ('off'/'listening'/'thinking'/'speaking')で動いている。送信ボタン操作は不要。
  バージイン(`interrupt()`)も実装済み。
- **iOSネイティブ版には音声入力が一切存在しない**: `ios/VMate/Sources/` 全体を検索しても
  `Speech`フレームワーク・VAD・voiceMode相当のものがゼロ。`CompanionViewModel.swift`は
  テキスト入力(`send(_:)`)のみで、`Audio/SpeechQueue.swift`はTTS再生(出力)専用、
  音声入力(STT)のパイプラインが存在しない。「本物の人間と話す感覚」というゴールに対して
  ここが最大のギャップ。
- 過去のdev-notesに `voice_conversation_handsfree_2026-06-20.md`(Web版ハンズフリー追加)、
  `voice_vad_infinite_loop_fix` 系(VADの安定化)があり、Web版の設計は複数回の実戦テストを
  経て安定している。iOS実装はこのWeb版のVAD設計(RMSしきい値+ノイズフロア追従+ONSET/HANGOVER)
  を参考にできる。

## Definition of Done(検証可能な停止条件)
- [ ] iOS版に音声入力(STT)パイプラインが実装され、ユーザーが話すだけで自動的に1ターンが
      確定し送信される(ボタン押下不要)
- [ ] iOS版にもバージイン(発話中にユーザーが話し始めたら中断して聞き取りに戻る)がある
- [ ] xcodebuild simビルドが警告0・エラー0で通る
- [ ] Web版側も、応答待ち中の沈黙が不自然に長い・聞き取り再開が遅いなど「人間らしさ」を
      損なう既知のギャップがあれば1件以上改善する(iOS実装後、余力があれば)

## Constraints / guardrails
- マイク権限(`NSMicrophoneUsageDescription`等のInfo.plist記述)を忘れない。
- SFSpeechRecognizerは音声データをApple/サーバに送る可能性があるため、オンデバイス認識
  (`requiresOnDeviceRecognition`、対応言語であれば)を優先検討する。
- Web版の設計(VADパラメータ、ターン確定の閾値感覚)をできるだけ踏襲し、プラットフォーム間で
  体感が大きく変わらないようにする。
- 既存の未コミットWIP(ios/project.yml の DEVELOPMENT_TEAM等)には触れない・混ぜない。
- 各ステップ後 xcodebuild simビルドで検証し、緑を保ったままcommit。
- セッションコストが既に$23超(2026-06-22時点)のため、スコープは「iOS音声入力の最小動作版」
  に絞り、過度な探索的subagent展開は避ける。

## TODO / progress
- [x] architectエージェントにiOS音声入力パイプラインの設計を依頼
- [x] 設計に基づき実装(AudioSessionManager/VoiceActivityDetector/SpeechRecognizer/
      CompanionViewModelのVoiceMode/APIClientのキャンセル対応/RootViewのマイクボタン)
- [x] xcodebuildで検証(ビルド警告0・エラー0、VADユニットテスト6件パス、起動確認)
- [x] commit(`0b0e584`) → push
- [ ] マイク実機でのエンドツーエンド動作確認(発話→認識→送信、バージインの自己エコー耐性)
      — シミュレータ+セッションコスト都合で未実施。次回起動時の最優先確認事項。
- [ ] Web版側の人間らしさのさらなる改善 — セッションコスト($28超)のため今回は見送り

## 収束状況(2026-06-22)
コア機能(iOSのハンズフリー音声入力)は実装・ビルド検証済みで一区切り。実機マイクでの
動作確認が次回の最優先事項。セッションコスト・変更ファイル数(21件)の両方が閾値を超えた
ため、ここでループを一旦停止して報告する。
