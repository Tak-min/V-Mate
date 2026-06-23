# マイク冒頭1〜2秒ロスの根治 + 応答レイテンシ短縮 (2026-06-23)

## 背景 / ユーザー要望
1. マイク初期化部分で**最初の1〜2秒の音声が取れていない**。改善ループを回すこと。
2. **LLM応答時間が長く**感じる。音声合成+バックエンド処理を見直して短縮し、没入感/人間性を高める。
3. 自律的に問題発見と改善を分析を繰り返して行う(承認待ちで止めない)。

実機マイクテストは本セッションでも不可(声を出せない環境)。ロジック改善+ユニットテスト+
静的な並行性レビューで完結させ、実機要パラメータは「申し送り」に回した。

---

## 問題A: マイク冒頭1〜2秒ロス

### 真因(architect agentで設計検証済み)
[[vad_onset_dropframes_and_sensitivity_2026-06-23]] で直したのは**フレーム単位(数十ms)**の
onsetロスだった。今回ユーザーが言う「1〜2秒」はそれより1〜2桁大きく、別の真因。

`SpeechRecognizer.start()`/`stop()` が **会話の1ターンごとに** `AVAudioEngine` をフル
ティアダウン+再構築(`removeTap`/`installTap` + `prepare()`/`start()`)していた。呼び出し元は
`CompanionViewModel`:
- `handleUtterance` → `recognizer.stop()`(発話確定でエコー防止)
- `resumeListening` → `startListening()` → `recognizer.start()`(応答完了+TTS空で再開)

`.playAndRecord`/`.voiceChat` セッションはAEC(音響エコーキャンセラ)を持つ。エンジンを
ターンごとに再起動すると、そのAECが**毎ターン冷えた状態から再収束**する。この収束ウィンドウ
(数百ms〜数秒)の間、入力は減衰/歪みが乗り、「発話冒頭の1〜2秒が取れない」体感になる。
`warmupMs=200` と `resumeListeningDelay=0.45` を足しても約650msしか覆えず、冷間AEC収束には
全く届かない。しかも `warmupMs` はその間 onset検出を**抑制**するので二重に冒頭が削られていた。

### 修正方針: 会話中エンジンを止めない(常時稼働 + ソフトフラグでターン制御)
会話モード(`toggleHandsFree` ON〜OFF)の間、`AVAudioEngine`+tapを生かしたままにする。
ターンごとは**ソフトウェアフラグだけ**を切り替える。AECは会話を通して**1回だけ**収束する。

最重要ガード: [[vad_onset_dropframes_and_sensitivity_2026-06-23]] が潰した
「onset検出→request生成の間のMainActor非同期ホップで後続バッファが捨てられる」レースを
**絶対に再導入しない**こと。そのため、ターン境界のリセットも全てtapスレッド上で行う設計にした。

#### 変更点
- `SpeechRecognizer` を2層に分割(全て既存 `SpeechRecognizer.swift` 内、pbxproj編集なし):
  - **エンジン層(会話で1回)**: `beginSession(callbacks:)` / `endSession()`
  - **ターン層(毎ターン、エンジン不触)**: `resumeTurn()` / `pauseTurn()`
- `AudioCapturePipeline` に `LockedFlag` を2つ追加:
  - `enabled`(ターン単位の聞き取りON/OFF。MainActorが書き、tapが読む)
  - `pendingArm`(次ターンのVAD/preRoll/前ターンrequestリセット要求。MainActorが立て、
    **tapスレッドが消費**して実際のリセットを行う)
  - `arm()` は両方true、`disarm()` は `enabled=false` のみ。**どちらも `LockedFlag` しか触らない**
    (`vad`/`preRoll`/`request` には一切触れない=単一書き手=tapスレッドの原則を維持)。
  - `handleTap` は純関数 `gateDecision(enabled:pendingArm:)` でゲート判定 →
    `doReset` で `pendingArm` 消費+`vad.reset()`/`preRoll.drainAndClear()`/`endCapture()` を
    **tapスレッド上で**実行 → `guard gate.process`(disarm中はフレーム即破棄、エンジンは回り続ける)。
- `CompanionViewModel` 呼び出し側を `beginVoiceSession`(1回)/`pauseTurn`(発話確定)/
  `resumeTurn`(再開)に張り替え。`stopListening` は `endSession()`。
- `VoiceActivityDetector.warmupMs` を 200→**100**(エンジン再起動の不安定吸収が不要になったため。
  **実機再較正が必要**=後述)。
- `AudioSessionManager` に冪等ガード(同じ構成への再 `setCategory`/`setActive` をskip)。
  常時稼働化で誤って毎ターン呼んでもno-opになる保険。

### 検証
- `xcodebuild test -scheme VMate -only-testing:VMateTests -destination 'platform=iOS Simulator,name=iPhone 17'`
  → **17 tests, 0 failures**(既存11 + 新規:ゲート真理値表4 + LockedFlag往復2)。
- swift-reviewer(opus)で並行性レビュー → **APPROVE / CRITICAL・HIGHゼロ**。
  onsetレース非再導入の3条件すべてPASSを確認:
  1. request生成は今もtapスレッド上で完全同期(onset→appendの間に非同期ホップ無し)
  2. `vad`/`preRoll`/`request`/`task` は今もtapスレッドのみが変更(arm/disarmはフラグのみ)
  3. 境界を跨ぐのは `enabled`/`pendingArm` の2つだけ、両方 `LockedFlag`(既存 `useOnDeviceRecognition` と同型)

---

## 問題B: 応答レイテンシ

### B1: LLM/TTSのhttpxクライアント共有(毎ターンのTLSハンドシェイク削減)
`llm.py:stream_chat` と `tts.py:synthesize` が呼び出しごとに `httpx.AsyncClient` を新規生成
していた=毎ターン DNS+TCP+TLS handshake を払っていた。FastAPIのlifespanで keep-alive
プール付きクライアントを生成し、`set_client()` で各モジュールへ注入して再利用するように変更。
lifespan外(テスト・スクリプト直import)では遅延生成の `_fallback_client` にフォールバックして
挙動を変えない。LLM(120s)とTTS(30s)でタイムアウトが違うため**クライアントは別インスタンス**にし、
各リクエストでも明示的に `timeout=` を渡して二重タイムアウト/緩み事故を防いだ。

### B2: SSEストリームの感情タグ早期フラッシュ(time-to-first-token短縮)
旧実装は感情タグ(`[happy]`等)が確定する**か** buffer>24文字になるまで、**最初のトークンを
1つもクライアントに流さなかった**。タグの`]`が来るまで全部ホールドされ、最初の一言までの
体感レイテンシになっていた。`_could_still_be_tag_prefix()` を追加し、「bufferがまだ6種タグの
いずれかの接頭辞である間だけ」ホールド、接頭辞でなくなった瞬間に `neutral` 確定+即フラッシュ
するようにした。タグ無し応答は約1文字待ち、タグ有りでも最長`[relaxed]`≈9文字待ちに短縮
(従来は24文字 or `]`まで)。

### B3: Aivis TTSストリーミング調査 → 安全な即効策のみ適用、本格対応は申し送り
Aivis Cloud API(`/v1/tts/synthesize`、OpenAPI spec確認済み)の所見:
- **ストリーミングはトランスポート層の機能**(リクエストflagは無し)。レスポンスは生成しながら
  chunked MP3で届き、`stream`相当のTTFBは**約250ms**。
- **即適用した安全策**: `leading_silence_seconds` の既定が **0.1秒**(全発話の先頭に100msの無音)。
  これを **0.0** にして、発話冒頭の無音=体感レイテンシを毎回100ms削減。クライアント変更不要・
  リスクゼロ・即効。
- **本格ストリーミングは意図的に見送り(申し送り)**: TTFB 250msを活かすには、iOS側の
  `SpeechQueue` が `AVAudioPlayer(data:)`(=全データ受領後に再生)から**逐次再生プレイヤー**
  (`AVPlayer`/`AVAudioEngine`のバッファスケジューリング/`AVSampleBufferAudioRenderer`)へ
  載せ替える必要がある。これは音声再生経路そのものの差し替えで、**本環境では実機オーディオ
  検証が不可**=回帰すると全音声出力を壊しうる高リスク変更。今回の確実な改善(B1/B2/leading_silence/
  エンジン常時稼働)を優先し、本格ストリーミングは実機検証可能な次ステップとして切り出す。

### 検証
- `pytest` → **40 passed**(既存33 + 新規 `test_emotion_prefix.py` 7件:接頭辞真理値表 +
  「タグ前テキストを取りこぼさない」回帰テスト)。
- python-reviewer(sonnet)レビューで **HIGH 1件**を発見・即修正:
  早期フラッシュ化の初版で `buffer = buffer[match.end():]` としてしまい、**タグより前のテキストを
  破棄**していた(モデルがタグを冒頭に置く指示を守らないと無言ロス)。
  `buffer[:match.start()] + buffer[match.end():]` に修正し、タグ自身だけ除去して前後テキストを保持。
  回帰テスト `test_chat_preserves_text_that_precedes_the_emotion_tag` を追加。

---

## ハマりどころ (Symptom → Cause → Fix)
- **Symptom**: SourceKit(IDE)が `VoiceActivityDetector`/`VADConfig`/`Testing`モジュールを
  「スコープに無い」、`AVAudioSession`を「macOSで使用不可」と大量に誤検知。
  **Cause**: iOSターゲットをIDEが解決できない既知の偽陽性([[vad_onset_dropframes_and_sensitivity_2026-06-23]]
  でも既出)。 **Fix**: 無視してよい。真の判定は `xcodebuild test` の実ビルドのみ。
- **Symptom**: 早期フラッシュ初版が「タグ前テキスト」を無言で落とす。
  **Cause**: `buffer[match.end():]` がタグより手前を切り捨てる(旧 `EMOTION_TAG_RE.sub` は保持していた)。
  **Fix**: タグ範囲だけを除去。レビューが無ければテストをすり抜けた(ペルソナがタグを冒頭に置く
  前提で実データではほぼ顕在化しないため)。**「自分の書いたコードを自分で採点しない」レビュー
  ゲートが効いた実例。**

---

## 申し送り(実機検証が可能になったら — 最優先順)
1. **最優先・新条件**: エンジンが**TTS再生中も生きたまま**になった(従来は再生中エンジン停止)。
   `.voiceChat` のAECがシロ自身のTTSを打ち消す前提に**コードが依存するようになった**。実機で
   (a) TTS再生品質、(b) 自分の声でバージインが誤発火しないか、を確認。`resumeListeningDelay=0.45` と
   `warmupMs` がバックストップ。
2. **AEC収束が会話を通して保たれ、ターン頭の発話が切れない**こと(=本修正のコア仮説)を実機で確認。
3. **`warmupMs=100` の再較正**: 下げたことでTTS残響を発話誤検出しないか。誤検出が出るなら
   120〜150msへ戻す。逆にまだ冒頭が切れるなら 80ms も試す。
4. (B3続き)本格TTSストリーミングを入れるなら、iOS逐次再生プレイヤーへの載せ替えを別タスクで。
   バックエンドは `client.stream()` + `StreamingResponse(media_type="audio/mpeg")` 化が必要。
5. 実機較正値(`minThreshold`/`noiseMargin`/`thresholdOffset`/`initialNoiseFloor`)は今回も**未変更**
   (実機ログ無しでは触らない方針を踏襲)。

---

## 実機検証(2026-06-24・iPhone 15 Pro「俺のGALAXY Pro Max」ワイヤレス)
申し送りの最優先項目を実機で確認した。手順: 一時計測ログ`micdbg("[MICDBG] …")`を
beginSession/endSession/resumeTurn/pauseTurn/speechStarted/transcriptに仕込み →
`xcodebuild -destination 'id=FF649B7E-…' -allowProvisioningUpdates`で署名ビルド(自動署名・
Team NVZB82UK53で解決) → `xcrun devicectl device install/process launch --console`で
ワイヤレス書き込み&stdout観測(`log stream`は実機を拾えないため`devicectl --console`が正解)。

3ターン会話したコンソールトレースの実測:
- **`▶︎ beginSession`=1回のみ / `■ endSession`=1回のみ / `↻ resumeTurn`=3 / `⏸ pauseTurn`=3。
  3ターンをまたいでbeginSessionが再発ゼロ=エンジン非再起動を実証**(=本修正のコア仮説が実機で成立。
  毎ターンのAEC冷間再収束が消えた)。
- `🎤 speechStarted`=4回、rms=0.00189/0.00278/0.00189/0.00178(較正済みminThreshold 0.0006を
  超過、小さめRMSでも検出)。**各speechStartedの直後にpartial transcriptが発話の頭
  (「いや」「お」)から出力=発話冒頭ロスなし**。
- transcript: 「いや元気」「いや眠い」「おやすみ」を各ターン文字起こし。クラッシュ/
  AVAudioSessionエラーなし。TTS再生中もエンジン稼働のまま会話成立(自己バージイン誤発火は
  このセッションでは観測されず。長時間/大音量での再確認は引き続き推奨)。
- 検証後、`[MICDBG]`計測ログは全削除しクリーン版を再ビルド・再インストール(iOSソースは
  commit 04c4082とバイト一致=17テスト緑の状態を維持)。
- 残課題: `warmupMs=100`の最適値とTTS大音量時の自己バージイン耐性は、より長い実利用での
  継続観察に委ねる(現状の短時間検証では問題なし)。
