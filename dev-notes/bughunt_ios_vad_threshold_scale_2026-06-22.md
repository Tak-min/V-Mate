# バグハント(真因確定)— iOSハンズフリー音声が無反応 = VADしきい値のスケール不一致 (2026-06-22)

## 結論(先に)
iOSハンズフリー音声会話が「リスニング表示は出るのに一切文字起こしされない」不具合の
**真の根本原因は、VAD(音声区間検出)のRMSしきい値がWeb版スケールのまま移植されていて、
iOSの AVAudioEngine の実RMSスケールより10〜60倍高すぎたこと**。そのためユーザーが話しても
RMSがしきい値に永遠に届かず、`speechStarted` が発火せず、SFSpeechRecognizer に音声が
1サンプルも渡らなかった。**SFSpeechRecognizer 自体は完全に正常**で、しきい値を実スケールに
較正したら即座にオンデバイス認識で文字起こしできた。**ElevenLabs等の外部STTは不要**。

> 前回ログ `bughunt_voice_handsfree_and_cutout_2026-06-22.md` の「requiresOnDeviceRecognition
> フォールバック」修正は、シミュレータビルドだけで推測した仮説で**真因ではなかった**(実機では
> `supportsOnDeviceRecognition=true` でオンデバイスが普通に使えていた)。その修正自体は無害な
> 保険として残してある。教訓: **実機ログを取らずに推測で直すと的を外す**。

## 症状(ユーザー報告)
- iOS実機(iPhone 15 Pro)。マイクボタンをタップするとリスニング状態にはなる
  (マイクが青く光り、Dynamic Island に聞き取り中マークが出る)が、話しても何も
  文字起こし・反応されない。

## 調査方法(これが決め手)
シミュレータでは実マイク入力が無く再現不能なため、**実機にコンソール接続して
`print("[VMate-DIAG] ...")` の一時診断ログを仕込み**、`xcrun devicectl device process
launch --console` で実機の標準出力を直接観測した。

判明した事実(実機ログ):
```
speechStatus=3 (authorized)  micGranted=true              ← 権限OK
recognizer.isAvailable=true  supportsOnDevice=true        ← 認識エンジンOK
audioEngine started OK   input format: 48000Hz 1ch        ← マイク入力OK
raw tap rms=0.0001〜0.0047  hasFloatData=true             ← 音声データは流れている
（"VAD speechStarted" が一度も出ない）                     ← ここが異常
```
→ マイク・権限・音声エンジン・認識エンジンはすべて正常。**唯一 VAD が発火していない**。

## 原因の詳細
`VoiceActivityDetector` のしきい値計算:
```swift
threshold = max(config.minThreshold, noiseFloor * config.noiseMargin + 0.01)
```
旧値(Web版 frontend/src/features/voice/recognition.ts からの移植):
- `minThreshold = 0.025`、加算定数 `+ 0.01`、初期 `noiseFloor = 0.01`

ところが実機計測の iOS RMS スケールは:
- 無音 ≈ 0.0002〜0.0004 / **発話ピークでも ≈ 0.004**

Web Audio API は発話で RMS ≈ 0.1 前後まで出るので 0.025 のしきい値で機能していたが、
iOSの `AVAudioEngine`(`.voiceChat` モードの AGC/AEC/ノイズ抑制を通った信号)は桁が2つ
小さい。結果 `rms(0.004) > threshold(0.025+)` が永遠に偽 → 発話未検出。

さらに**初期 `noiseFloor = 0.01` も Webスケール**で、これだと起動直後の threshold が
`0.01*1.8+0.01 = 0.028` と高止まりし、0.95の指数追従で iOS無音(0.0003)まで落ちるのに
≈7秒かかる(その間さらに不感)。二重の意味でWebスケール固定値がiOSに合っていなかった。

## 修正(`VoiceActivityDetector.swift`)
しきい値パラメータを iOS実測スケールに較正し、Webスケール固定値を排除:
- `minThreshold`: 0.025 → **0.001**
- `noiseMargin`: 1.8 → **2.2**
- 加算定数 `+ 0.01`(ハードコード)→ 設定化 `thresholdOffset = 0.0005`
- 初期/`reset()` の `noiseFloor`: 0.01 → 設定化 `initialNoiseFloor = 0.0004`

これで iOS無音時の threshold ≈ `max(0.001, 0.0004*2.2+0.0005=0.00138) = 0.00138`、
発話ピーク 0.004 が 約2.9倍の余裕で超える。ノイズフロア追従ロジック自体は維持
(環境ノイズが上がれば threshold も上がる)。

## 検証
- **実機(iPhone 15 Pro)で文字起こし成功を確認**(診断ログ):
  ```
  VAD speechStarted rms=0.0017      ← 較正後、発話で発火
  beginCapture usedOnDevice=true    ← オンデバイス認識起動
  partial result: "いた"→"いたし"→…→"いたしまして"   ← リアルタイム認識
  commit text="いたしまして"          ← 1ターン確定→送信
  ```
- `xcodebuild test_sim`: VADユニットテスト6件パス(較正に合わせ
  `noiseFloorAdaptsDuringSilenceOnly` の testRms/ambientRms をiOSスケールに更新)。
- `xcodebuild` 実機ビルド: 警告0(向き警告のみ)・エラー0。診断ログ全削除済みのクリーン版を
  実機にインストール済み。

## ハマりどころ / 申し送り
- **VADやマイク無反応系は、シミュレータでは絶対に再現できない**(実マイク入力が無い)。
  必ず実機にコンソール接続(`devicectl ... --console`)して raw RMS を観測すること。
  `log stream` はMac自身のログしか拾えず実機には使えなかった。
- **`requestRecordPermission` 等が通っていても「音が小さすぎてVADが反応しない」という
  別レイヤーの無音化があり得る**。権限・エンジン起動の成功＝音声検出の成功ではない。
  生RMSを必ず数値で見る。
- iOS実機の起動は**端末ロック中は `FBSOpenApplicationErrorDomain error 7 (Locked)` で失敗**
  する。ロック解除してもらってから launch する。
- SourceKitが `VoiceActivityDetector`/`Emotion`/`APIClient` 等を「スコープに無い」と誤検知
  するのは既知の偽陽性(iOSターゲット未認識)。`xcodebuild` 実ビルドは通る。

## チューニング余地(次回以降・任意)
- 較正値は iPhone 15 Pro 1台・1回の発話音量で合わせたもの。他機種や小声で取りこぼす場合は
  `minThreshold`/`thresholdOffset` をさらに下げる。逆に環境ノイズで誤発火するなら `onsetFrames`
  を 2→3 に上げる。実機ログの raw RMS を見て調整するのが最短。
- ごく短い物音で `speechStarted`→即`speechEnded`(認識結果ゼロ)になるケースがログに見える。
  `commit()` で `minUtteranceLength` 未満は破棄するので実害なしだが、気になれば onsetFrames で抑制可。
