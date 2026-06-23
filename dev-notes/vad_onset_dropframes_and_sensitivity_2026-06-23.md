# VAD: 発話冒頭フレームのロスト修正 + 感度チューニング (2026-06-23)

## 背景
ユーザー要望: 「小声の取りこぼしを減らし、音声検出をより敏感にしてほしい。実機マイクテストは不可(声が出せない環境)、PC上のロジック改善+ユニットテストだけで完結させること」。

実機較正値([[bughunt_ios_vad_threshold_scale_2026-06-22.md]] / [[voice_sensitivity_and_resume_delay_2026-06-22.md]] 由来の minThreshold=0.0006, noiseMargin=1.8, thresholdOffset=0.0003, initialNoiseFloor=0.0003)は実機ログでしか較正できないため、**今回は変更していない**。代わりに、(1) 構造的バグの修正、(2) 較正値に依存しないアルゴリズム改善、の2本で感度を上げた。

## 発見した真因: 発話冒頭の数フレームが認識リクエストに渡っていなかった
旧 `SpeechRecognizer.handleTap` は `vad.process()` が `.speechStarted` を返すと
`Task { @MainActor in self?.beginCapture() }` で**非同期に** `SFSpeechAudioBufferRecognitionRequest` を生成していた。
一方、同じ `handleTap` 内の `if let request, vad.capturing { request.append(buffer) }` は**同期的に**評価される。
つまり:
- `speechStarted` を検出したそのバッファ自体
- `beginCapture()` の Task が MainActor 上で実際に走るまでの間に届く後続バッファ(複数フレーム分になりうる)

これらは `request` がまだ `nil` のため `append` がスキップされ、**発話の最初の音素が確実に失われていた**。声が小さい/短い発話ほど致命的(全体の情報量に対する冒頭ロス比率が大きい)。

これはWeb検索で裏付けた業界標準パターン(WebRTC VAD等のhangover/adaptive threshold資料、および look-back/pre-roll buffer によるonset欠落防止の手法)とも合致する既知の問題クラス。

## 修正方針(architect agentで並行性設計をレビュー済み)
1. **`AudioCapturePipeline`という専用クラスに切り出し**、tapコールバックから完全に同期的に
   `SFSpeechAudioBufferRecognitionRequest` 生成・`recognitionTask` 起動まで行う。MainActorへの
   非同期ホップを挟まないため、上記のレースが構造的に消える。
   - `vad`/`preRoll`/`request`/`task` はこのクラス内、tapスレッドからのみ触る → 競合なし。
   - `useOnDeviceRecognition` だけは MainActor側(認識結果ハンドラ)からも書かれるため
     `LockedFlag`(`OSAllocatedUnfairLock`ラッパー)で保護。
   - `finalText`/`receivedAnyResult`/`onDeviceFailureNotified` は元のまま `SpeechRecognizer`(MainActor)
     側にのみ残し、pipelineは一切触らない設計にして、単一書き手の原則を保った。
2. **`PreRollBuffer`** (リングバッファ) を追加。VADのonset確認待ち(`onsetFrames`連続要求、デフォルト2フレーム)
   の間に届くバッファを `.silence`イベント且つ`vad.capturing==false`のときに溜めておき、`.speechStarted`
   確定の瞬間にまとめて `request.append` してから現フレームを追加する。これで onsetFrames 分の
   フレームも含めて冒頭ロスがゼロになる。
   - `AVAudioPCMBuffer` をそのまま(コピーせず)保持する設計にした。tapはコールバックごとに新しい
     バッファインスタンスを渡す(既存コードも `request.append(buffer)` でtapスコープ外保持を前提に
     動いていた=Appleの典型的な使い方)ため、ディープコピーは不要と判断。
3. **ノイズフロアの非対称EMA**: `noiseFloor` の追従を `floorAttack=0.05`(上昇、既存と同値=回帰なし)/
   `floorDecay=0.2`(下降、4倍速)に分離。突発ノイズの後にしきい値が高止まりせず、静かな環境に戻った
   直後の小声を早く検出できるようにした。較正済みの絶対値(minThreshold等)は変更していない。

## 検証
- `xcodebuild test -scheme VMate -only-testing:VMateTests -destination 'platform=iOS Simulator,name=iPhone 17'`
  → **11 tests, 0 failures**(既存6件 + 新規 decay経路1件 + PreRollBuffer 3件 + Suite構成変更)。
- 既存の較正テスト(`noiseFloorAdaptsDuringSilenceOnly` 等)は無修正のまま全パス → 回帰なし。
- ビルド警告0、エラー0。

## ハマりどころ
- SourceKit(IDE)は `VoiceActivityDetector` 等を「スコープにない」と誤検知する(既知の偽陽性、
  iOSターゲット未認識)。`xcodebuild` の実ビルド/テストでのみ正しく判定される。
- このプロジェクトはXcode 16の File System Synchronized Groups を使っておらず、`project.pbxproj`
  に手動でファイル参照が列挙されている。**新規 `.swift` ファイルを追加する場合は pbxproj に
  PBXFileReference/PBXBuildFile/グループ/Sourcesフェーズの4箇所を手で追記しないとビルド対象に
  入らない**。今回はそのリスクを避け、`AudioCapturePipeline`/`PreRollBuffer`/`LockedFlag` を
  既存の `SpeechRecognizer.swift` に同居させ、テストも既存の `VoiceActivityDetectorTests.swift`
  に追加することで pbxproj編集を回避した。

## 申し送り(実機検証が可能になったら)
- 今回はロジック側のみの改善。**実機ログでの再検証は依然必須**(特に小声環境でPre-roll込みの
  文字起こし精度、decay=0.2が環境ノイズの種類によって誤検出を増やさないか)。
- もし実機ログで「decay側が速すぎて環境ノイズの谷間を発話と誤検出する」が見えたら `floorDecay`
  を 0.2→0.1 程度に下げる。逆にまだ小声を取りこぼすなら `PreRollBuffer` の容量
  (`onsetFrames + preRollMargin`、現在 2+1=3フレーム)を増やすより先に、`onsetFrames` を
  2→1に下げて確定を早める方が効果的(pre-rollは「確定が遅れた分の音声データ」の欠落は防ぐが、
  「確定そのものが遅い」ことによる体感レイテンシは解決しない)。
