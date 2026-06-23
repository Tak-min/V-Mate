# VISION — 3Dコンパニオン(シロ)の人間性UI/UX自律改善ループ

> loop-engineerアンカー。ユーザー要望(2026-06-23, /loop-engineer起動時の指示):
> 「ユーザがこの3Dモデルに対してより深く人間性を感じられるように、UI/UXを自律的に改善して、
> 見た目的にも機能的にも使いたいと思わせるようなテーマで作成してほしい。自律的に改善のループを
> 回して、改良のサイクルを繰り返してほしい」

## モード・停止条件(ユーザー確認済み, 2026-06-23)
- **実行モード**: ヘッドレス(放置)。`loop-engine.sh` でバックグラウンド実行し、最大反復数 or
  進捗停滞で自動停止するまで放置可能にする。
- **Definition of Done**: 固定の最大反復数(本スキル既定 **20**)まで改良サイクルを継続。
  各反復は「smallest verifiable step」を1つ実装→ビルド/lint/型チェック緑→
  (ロジックを触る場合は)reviewer subagentでCRITICAL/HIGH無し→commit、を1サイクルとする。
  20反復に到達 or 3反復連続で進捗(diff)が無い場合に停止。
- **優先したい改善方向(ユーザー選択, 複数選択)**:
  1. 視線・表情の自然さ(既存実装あり: gaze/blink/expression — さらに深化)
  2. 待機中の生命感(呼吸・重心移動・たまにある動きで「待っている」と感じさせる)
  3. UIの温かみ・触れたくなる質感(配色・タイポ・マイクロインタラクション)
  4. 全て自由裁量で進めてOK
  5. **明示要望**: 待機モーション・瞬きの「種類」を増やし、`.vrma`アニメーションファイルを
     増やして、ランダムではなく「実際にキャラクターが呼吸をしている」「アニメーションを
     待機しているかのように感じる」ような改善(=単純RNGではなく、文脈に応じた意図的な
     遷移に見えるようにする)。

## 制約(重要 — 反復前に必ず認識すること)
- **新規`.vrma`モーションキャプチャファイルをこのループで「作成」することはできない**
  (モーションキャプチャ/アニメーション制作ツールが無い)。既存5ファイル
  (`frontend/public/animations/{cool,genki,oshitoyaka,mujaki,shy}.vrma`)を再利用し、
  「複数の既存クリップをブレンド・ローテーション・文脈依存スケジューリングする」ことで
  種類の多さ・意図性を表現する。新規vrma素材の調達(無料/ライセンスOKな配布元)が見つかれば
  追加検討するが、それ自体に反復を消費しすぎない。
- 本番は Cloudflare Workers + 静的アセット25MB上限。`realistic.vrm`は既存の理由で常に
  デプロイ時除外中(別タスク、このループのスコープ外)。新規アセット追加時はサイズに注意。
- フロントは Vite + React + TypeScript。検証は実機マイクテスト不要(これはUI/UX/3D表示の
  視覚・コードレベル改善であり、iOS VADタスクとは無関係)。
- 既存の `frontend/src/features/vrm/viewer.ts` は既に高度(gaze/blink/breathing/expression/
  relationshipWarmth/procedural口パク等)。**作り直さず、上に重ねる/精緻化する**こと。
  既存の細かいコメント付き調整(2026-06-時点)を壊す大規模リライトは避ける。
- グローバルCLAUDE.mdのモデルルーティングに従う: 新規抽象(アイドル状態機械等)の設計判断は
  Opus(architect/code-architect)に委譲済み(下記参照)、実装はSonnet本体。

## 設計方針(code-architect/opus, 2026-06-23ブループリント確定)

設計の核: `viewer.ts`の`MOTIONS`は感情ごとに固定1クリップを永久ループしているだけ
(neutral=mujaki.vrma固定)。新規モーキャプ素材は作れないので、**既存5本のクリップを
文脈駆動でローテーション/ブレンド**することで「種類」と「意図性」を表現する。
`setEmotion()`は引き続き即座にそのクリップを強制する権限を持つ(emotion lock)。

### バックログ(優先順位順、1→2は依存あり、3は1のフィールド再利用、4-6は独立、7-9はCSSのみ独立)

1. **アイドルクリップローテーション基盤** — `attentionMode==='idle'`かつ
   `currentEmotion`がneutral/relaxedの時だけ、既存5クリップ(`idleClipUrls`)から
   `chooseNextIdleClip()`(直前と違うものを文脈重み付きで選ぶ)で次のクリップへ
   `CROSSFADE_SECONDS`でクロスフェード。`nextIdleSwitch`タイマー(14-26s, warmthで延長)。
   `renderLoop`の`updateGaze`後に`updateIdleMotion(delta)`を呼ぶ。
2. **emotion lockでスケジューラと`setEmotion()`の競合防止** — `emotionLockUntil`
   フィールド。`setEmotion()`で`elapsed+4.5`にセットし、`updateIdleMotion`はロック中bail。
3. **ワイドグランス後の瞬きクラスタ + 長時間アイドルのまどろみ瞬き** — `updateGaze`の
   `isWideGlance`発火時に`pendingBlinkCluster`をセット→`startBlink()`で強制二重瞬き。
   `lastInteractionAt`からの経過(45s超)で`randomBlinkInterval()`を1.4-1.9倍に伸ばし
   `blinkDuration`も少し伸ばして「まどろみ」を表現。
4. **発話の文末で瞬きを同期** — `viewer.ts`に`blinkSoon(maxDelay=0.5)`を追加し、
   `useCompanion.ts`のSentenceSplitterが文を1つ確定するたびに呼ぶ。
5. **アイドル中のマイクロ重心シフト** — `updatePresence()`に`nextSettle`カウントダウンを
   追加し、8-16s毎に`scene.rotation.z`/`position.y`へ極小オフセット(z≤0.012, y≤0.004)を
   `damp`でイン/アウト。`attentionMode==='idle'`時のみ。
6. **呼吸の深さ変調** — `updatePresence`/`updateGaze`の呼吸sin項の振幅を
   `0.7+0.3*sin(elapsed*0.18)`等の超低周波sinで変調し、機械的な一定振幅をやめる。
7. **UI温かみ: 押下フィードバック+チップのリフト** — `global.css`の
   `.chat-input button`/`.icon-button`/`.chat-suggestion-chip`に`:active{scale(0.96)}`、
   ホバーで`translateY(-2px)`+accent border。`prefers-reduced-motion`ブロック(L1148)にも追加。
8. **UI温かみ: assistantバブルの入場+アクセント** — `.bubble-assistant`に
   `--color-accent`の左ボーダー/inset shadow、既存`bubble-in`keyframeのtranslateY確認。
9. **UI温かみ: affinityバーのシマー+brand-markの呼吸(任意・優先度最低)** — 20反復に
   届かない場合は省略してよい(DoDはUI温かみ系1件で満たされるため、7があれば十分)。

対象ファイル: `frontend/src/features/vrm/viewer.ts`,
`frontend/src/features/chat/useCompanion.ts`, `frontend/src/styles/global.css`。

## Definition of Done チェックリスト(検証可能な停止条件)
- [ ] アイドル時の待機モーションが単一クリップのループだけでなく、複数既存クリップの
      ローテーション/ブレンドで構成され、遷移が「文脈(経過時間・感情・interaction有無)」
      に応じて決まる(完全な毎回ランダムではない)。
- [ ] 瞬きのバリエーション(間隔・二重瞬き・強さ)が現状よりさらに「その場の状態に意図的に
      反応している」ように見える調整が入っている(既存ロジックの拡張)。
- [ ] 待機中の「生命感」(呼吸・重心・視線)が強化され、何もしていない時でも生きているように
      見える(既存のbreath/sin波だけでなく、もう一段の自然さの工夫が入っている)。
- [ ] チャットUI(ChatPanel.tsx等)に「温かみ・触れたくなる質感」のマイクロインタラクション
      またはビジュアル改善が最低1件入っている。
- [ ] 各反復後 `npm run build`(または`tsc --noEmit`+`vite build`)が green。
- [ ] ロジックを触った反復は `react-reviewer` または `typescript-reviewer`(sonnet)で
      CRITICAL/HIGH無し。
- [ ] 反復ごとに `.loop/UIUX_state.json` を更新し、checkpointコミットをpush。
- [ ] 20反復 or 3反復連続無進捗で停止し、`.loop/UIUX_report.md` に成果・残課題をまとめる。

## 進捗ログ
- [ ] Phase 0: アンカーファイル作成(本ファイル) — 完了
- [ ] Phase 1: recon (code-architect blueprint) — 進行中
- [ ] Phase 2: ヘッドレスループ実行 (loop-engine.sh)
