# iOS版ハンズフリー音声会話の追加 — 2026-06-22

## 背景 / なぜ
ユーザーの要望:「送信ボタンを押す必要がなく連続的に会話できる、本当の人間と話している
ような感覚」。調査の結果、Web版(`frontend/src/features/voice/recognition.ts`)には
VAD駆動の完全ハンズフリー会話が既に実装済みだったが、**iOSネイティブ版には音声入力(STT)が
一切存在せず**(grep 0件)、テキスト入力のみだった。ここが「人間と話す感覚」というゴールに
対する最大のギャップだったため、iOSへの音声会話パイプライン追加を実施。

設計はarchitectエージェント(opus)に委譲。Web版のVAD定数(`VAD_INTERVAL_MS=60`,
`ONSET_FRAMES=2`, `HANGOVER_MS=1100`, `MIN_THRESHOLD=0.025`, `NOISE_MARGIN=1.8`,
`MAX_CAPTURE_MS=15000`)をそのまま移植し、体感をWeb版と揃えている。

## 実装したもの
- `Audio/AudioSessionManager.swift`(新規): `AVAudioSession`構成を一元管理。
  会話モード=`.playAndRecord`+`.voiceChat`(AECで自己エコー抑制)、テキストのみ=`.playback`。
  **これが今回最大の非自明ポイント**: `SpeechQueue`が直接`.playback`をセットしていたため、
  そのままでは録音中にTTSが再生されるたびにマイクのセッションが落ちる。
- `Audio/VoiceActivityDetector.swift`(新規): Web版`monitor()`の純ロジック移植。
  RMS+ノイズフロア追従+ONSET/HANGOVER判定。I/O非依存でユニットテスト可能。
- `Audio/SpeechRecognizer.swift`(新規): `AVAudioEngine`のtap+VAD+`SFSpeechRecognizer`を結線。
  沈黙時は認識を起動しない(Web版と同じ「録音し続けない」設計)。
- `ViewModels/CompanionViewModel.swift`(変更): `VoiceMode`(off/listening/thinking/speaking)
  状態機械を追加。`send()`を`streamTask`保持に変更しバージイン時にcancel可能に。
  `toggleHandsFree()`/`handleUtterance()`/`handleSpeechOnset()`(バージイン)/
  `resumeListening()`を追加。
- `Networking/APIClient.swift`(変更・小): `streamChat`に`CancellationError`分岐+
  ループ内`checkCancellation()`を追加(バージインでエラーメッセージが出ないように)。
- `Views/RootView.swift`(変更): headerにマイクボタン追加(voiceModeに応じてSF Symbol切替)。
- `project.yml`(変更): `NSMicrophoneUsageDescription`/`NSSpeechRecognitionUsageDescription`
  追加(これが無いと実行時にTCC violationでクラッシュする)。`VMateTests`ターゲットを新規追加
  (これまでiOS側にテストターゲットが存在しなかった)。

## 検証
- `VMate/Tests/VoiceActivityDetectorTests.swift`: VADロジックを6ケースでテスト
  (発話開始/単発フレームでは未トリガ/ハングオーバでの終了/上限到達/ノイズフロア追従/reset)。
  xcodebuild MCP `test_sim` で6件全パス。
- xcodebuild MCP `build_sim`: 警告0・エラー0。
- `build_run_sim`でシミュレータ起動確認、osLog/runtimeLogにクラッシュ・fatal無し。
- **マイク実機での発話→認識→自動送信のエンドツーエンド動作、バージインの自己エコー耐性は
  シミュレータ+このセッションの制約上未検証**。次回起動時、実機(またはMacマイクをシミュレータに
  渡せる環境)で確認することを推奨。

## ハマりどころ / 申し送り
- `AVAudioSession`カテゴリの衝突に気づかず実装すると、「テキストモードでは音が出るのに
  音声会話モードに入るとTTSが聞こえない/マイクが反応しない」という分かりにくい不具合になる。
  `AudioSessionManager`を必ず経由させること。
- `SFSpeechRecognizer`のrecognitionTaskは長時間使い回さない(VADで短いターンに区切り、
  `endCapture`ごとに必ず破棄→次ターンで新規生成)。
- tapコールバックは非MainActorスレッドで呼ばれる。VAD判定結果イベントだけ`Task { @MainActor }`
  でホップし、`SFSpeechAudioBufferRecognitionRequest.append`自体はtapスレッドから直接呼んでよい
  (スレッドセーフ)。
- `project.yml`にテストターゲットが無かったため`VMateTests`を新規追加。`xcodegen generate`を
  忘れると新規ファイルが`.xcodeproj`に反映されない。

## 未着手(次回以降)
- バージインの自己エコー耐性の実機検証(`.voiceChat`のAECに依存している前提が崩れていないか)。
- Web版側の「人間らしさ」のさらなる改善(セッションコスト都合で今回は見送り)。

## 次回セッションの予定(2026-06-22 ユーザー指示)
- **ハンズフリー音声会話機能の継続改善**: 今回はiOS版の最小動作版(VAD+STT+自動送信+
  応答後の自動再開+バージインのロジック実装)までで止めている。マイク実機での
  エンドツーエンド検証(上記「未着手」参照)に加え、Web版/iOS版双方の体感の自然さ
  (ターン確定のタイミング、バージインの反応速度、聞き取り再開までのラグ等)を
  実際に使って詰めていく想定。
- **既知の不具合: 音声がたまに途切れる**: ユーザー報告。現時点では再現条件・発生箇所
  (Web版/iOS版どちら、TTS再生中か発話認識中か、特定の発話長さやネットワーク状況との
  相関があるか等)を未調査・未特定。次回セッション開始時に優先的に再現条件を詰めること。
  調査の当たりどころとして点検すべき箇所のメモ:
  - Web版 `frontend/src/features/voice/speech.ts`: `processQueue`はシーケンシャル再生
    (1文ずつ`await`)なので、文と文の間で`analyser`が一瞬nullになり`mouthLevel()`が0を
    返す空白がある(リップシンクの途切れに見える可能性。音声そのものの途切れではないが
    紛らわしいので要確認)。`SentenceSplitter`の分割粒度が短すぎる場合、文の切れ目ごとに
    一瞬無音区間ができ「途切れ」に聞こえる可能性もある。
  - iOS版 `Audio/SpeechQueue.swift` / 今回追加した `Audio/AudioSessionManager.swift`:
    会話モード中(`.playAndRecord`+`.voiceChat`)とテキストのみモード(`.playback`)を
    切り替えるタイミングで、切り替えの瞬間に再生中の音声が途切れる可能性がある
    (`configureForConversation()`/`configureForPlaybackOnly()`の呼び出し箇所を要確認)。
  - バックエンド側(`worker/src/tts.ts`、Aivis Cloud API呼び出し)のネットワーク遅延/
    タイムアウトで音声データ取得自体が途切れている可能性も切り分けが必要。
  - まずユーザーに「Web版かiOS版か」「どのタイミングで途切れるか(発話中/聞き取り中/
    切り替え時)」をヒアリングしてから上記のどこを疑うか絞り込むのが効率的。
