# VISION — iOSハンズフリー音声の感度向上 + 応答直後の自己拾い込み防止

> loop-engineerアンカー。前段=`bughunt_ios_vad_threshold_scale_2026-06-22.md`(VAD較正で
> 「全く反応しない」を根治済み)。本ループはその続きの体感チューニング。

## Goal(ユーザー報告の2問題)
1. **取りこぼし**: VAD発火条件が厳しすぎ、小声・マイクから遠い発話を拾えない。
2. **応答直後の自己拾い込み**: コンパニオンの応答終了と同時にマイクが開くため、TTS(MP3)の
   末尾・スピーカー残響をマイクが拾って誤検出し、UXを損ねる。

## 設計判断(Opus本体で決定)
- **問題1 — 感度向上**: ノイズフロア相対検出を強め、絶対下限を下げる。実機実測スケール
  (無音~0.0003 / 通常発話~0.004 / 小声~0.0015 / 遠距離~0.001)に対し:
  - minThreshold 0.001→0.0006、noiseMargin 2.2→1.8、thresholdOffset 0.0005→0.0003、
    initialNoiseFloor 0.0004→0.0003、onsetFrames=2維持(単発ノイズ除去のため)。
  - 無音時しきい値 ≈ max(0.0006, 0.0003*1.8+0.0003=0.00084)=0.00084。遠距離小声0.001でも
    1.2倍で超え、onsetFrames=2(200ms持続)で検出。
- **問題2 — 自己拾い込み防止(二段構え)**:
  - (主) `CompanionViewModel.resumeListening()` に遅延(0.45s)。TTS再生キューが空になっても
    即マイクを開かず、残響が物理減衰してから開く。Web版の RESUME_DELAY_MS 相当がiOSに無かった。
  - (補助) VADに warmupMs(200ms)を追加。マイク開直後は speechStarted を抑制し、大きな音で
    ノイズフロアを汚さないようにしつつ環境追従。残響が遅延を逃れても初動で誤検出しない。

## Definition of Done(検証可能な停止条件)
- [ ] VADConfig感度を上記値に較正、warmupMs追加。process()でウォームアップ中はonset抑制。
- [ ] resumeListening()に遅延+DispatchWorkItemキャンセル(off/barge-in/再startで取消)。
- [ ] VADユニットテスト緑(既存6件にwarmupMs:0付与 + ウォームアップ抑制テスト追加)。
- [ ] xcodebuild simビルド警告0・エラー0。
- [ ] 独立レビュー(swift-reviewer/sonnet)でCRITICAL/HIGH無し。
- [ ] 実機で「小声/遠距離でも発火」「応答直後にTTS末尾を自己検出しない」を確認(診断ログ)。
- [ ] 診断print除去のクリーン版をcommit+push、実機インストール。

## Constraints
- iOSネイティブ変更のみ(Cloudflareデプロイ対象外)。実機=iPhone15Pro、ロック中はlaunch不可。
- 感度↑と残響誤検出↓はトレードオフ。resume遅延+warmup+onsetFrames=2で誤検出を抑える。
- セッションコスト高(~$105)。recon subagentは使わず本体の既知コンテキストで実装、
  レビューゲートのみsonnetへ委譲。

## 進捗
- [ ] iter1: VAD+ViewModel実装、sim build+unit test緑
- [ ] iter2: 診断付きで実機検証(小声/遠距離/応答直後)
- [ ] iter3: 必要なら再チューニング→診断除去→レビュー→commit/push
