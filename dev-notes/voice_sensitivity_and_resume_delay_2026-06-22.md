# iOS音声: 感度向上(取りこぼし)+ 応答直後の自己拾い込み防止 — 2026-06-22

## 背景
`bughunt_ios_vad_threshold_scale_2026-06-22.md` でハンズフリー音声の「全く反応しない」を
VAD較正で根治した後、ユーザーから体感の2問題の報告:
1. **取りこぼし**: VAD発火条件が厳しく、小声・マイクから遠い発話を拾えない。
2. **応答直後の自己拾い込み**: コンパニオン応答終了と同時にマイクが開き、TTS(MP3)末尾・
   スピーカー残響をマイクが拾って誤検出する。

両者はトレードオフ(感度↑ ↔ 残響誤検出↑)なので二段構えで設計した。

## 修正1: 感度向上(`VoiceActivityDetector.swift` VADConfig)
ノイズフロア相対検出を主にし、絶対下限を下げた。実機実測スケール(無音~0.0003 /
通常発話~0.004 / 小声・遠距離~0.001-0.0015)に対し:
- `minThreshold` 0.001 → **0.0006**
- `noiseMargin` 2.2 → **1.8**
- `thresholdOffset` 0.0005 → **0.0003**
- `initialNoiseFloor` 0.0004 → **0.0003**
- `onsetFrames` = 2 維持(単発ノイズ除去のフィルタとして残す)

無音時しきい値 ≈ max(0.0006, noiseFloor*1.8 + 0.0003)。沈黙で noiseFloor が ~0.0001 まで
下がると threshold は下限 0.0006 に張り付き、小声(rms ~0.0009)でも超える。

## 修正2: 応答直後の自己拾い込み防止(二段構え)
- **(主) resume遅延** (`CompanionViewModel.swift`): `resumeListening()` を即時 `startListening()`
  から、`resumeListeningDelay = 0.45s` 後に `DispatchWorkItem` で開く方式に変更。TTS再生キューが
  空になっても即マイクを開かず、残響が物理減衰してから開く。Web版にあった RESUME_DELAY_MS 相当が
  iOS版に無かった。WorkItem は `startListening`/`stopListening`/`handleSpeechOnset` の各経路で
  確実に `cancel()`(会話OFF・バージイン・手動再開で遅延ジョブが暴発しないように)。
- **(補助) VADウォームアップ** (`VoiceActivityDetector.swift`): `warmupMs = 200` を追加。
  マイクを開いた直後(reset後最初の process から warmupMs 以内)は `speechStarted` を起こさない。
  さらにウォームアップ中は `rms <= threshold` のときだけ noiseFloor を更新し、大きな残響音で
  ノイズフロアを汚さない。resume遅延を逃れた残響があっても初動で誤検出しない二段目の保険。

## 検証(実機 iPhone 15 Pro・診断ログ実測)
**テストA(感度)**: `VAD speechStarted rms=0.00091790 threshold=0.0006` — 小声(rms 0.0009)が
検出され `partial: "明日何する"` 等と文字起こし成立。沈黙時 noiseFloor が ~0.0001 まで下がり
threshold が下限0.0006に張り付くことを確認。環境音(rms ~0.0001)では未発火(6倍マージン)で
誤検出も無し。**取りこぼし解消。**

**テストB(自己拾い込み)**: `resumeListening: 応答終了→0.45s後` → `startListening: マイクを開く`
の順で、startListening直後のrmsは 0.0002〜0.0004(静か)、**TTS末尾由来のspeechStarted/ゴミpartialは
一切出ず**、speechStartedが出るのは必ずユーザーの実発話(rms 0.0018〜0.005)のみ。**自己拾い込み解消。**

- VADユニットテスト7件パス(`warmupMs:0`でコア検出を単体検証 + ウォームアップ抑制テスト追加。
  既存の noiseFloor追従テストは新デフォルト値に合わせ testRms/ambientRms を再計算)。
- `xcodebuild` 実機ビルド警告0・エラー0。独立レビュー(swift-reviewer)で重大問題なし
  (二重発火は`running`ガード、キャンセル漏れは全経路cancel、ウォームアップ汚染は`rms<=threshold`
  ガードで実害なしと確認)。診断print全削除のクリーン版を実機インストール済み。

## チューニング余地(申し送り)
- 感度値は iPhone 15 Pro での実測較正。さらに小声/遠距離を拾うなら minThreshold 0.0006→0.0004、
  noiseMargin 1.8→1.5。逆に誤発火が増えたら onsetFrames 2→3。
- 残響をまだ拾うなら resumeListeningDelay 0.45→0.7s、warmupMs 200→350。実機ログの
  `rms/noiseFloor/threshold` 周期出力(本コミットで削除済みだが再追加容易)で判断するのが最短。
- 0.45s の resume遅延は会話テンポとのトレードオフ。応答直後にユーザーが即かぶせて話すと
  最初の0.45sは拾わない(通常は問題にならないが、体感が気になればさらに短縮を検討)。

## gotcha
- VAD/マイク無反応・感度系は**シミュレータで再現不能**(実マイク入力が無い)。実機に
  `xcrun devicectl device process launch --console` でコンソール接続し生RMSを数値観測するのが必須。
- 実機がスリープ/ロックだと launch が `NWError error 60 (timed out)` や
  `FBSOpenApplicationErrorDomain error 7 (Locked)` で失敗。ロック解除→再launchで復帰。
- 再インストールすると既存のコンソール接続セッションは signal 9/15 で終了する(正常)。
