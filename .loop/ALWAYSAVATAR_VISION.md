# VISION — Web/iOSで必ずシロ(shiro.vrm)が表示され、UX/オンボーディングを収束改善する

## 目的(ユーザー指示 2026-06-25)
ウェブ版でキャラクターが読み込まれず「何も存在しない」状態を根治し、**必ず shiro.vrm が
表示される**ようにする。Web と iOS を同じような形に収束させ、UI/オンボーディングを批判的・
懐疑的に分析しながら改善ループを回す。各反復でスクリーンショットを撮って検証する。

## 根本原因(2026-06-25 本番で再現・診断)
- 本番 `v-mate` に**研究A/B条件システム(text/stylized/realistic)が残存**。
  `App.tsx` `visualBodyEnabled = condition !== 'text'` + `useCompanion.ts` `if (condition==='text') return`
  により、サーバがuidハッシュで **`text` を割り当てた約1/3のユーザーは3Dアバターが一切出ない**
  = 「何も存在しない」の正体。研究は本来 `v-mate-study`(別リポ)の責務。
- shiro.vrm 自体は本番で HTTP 200・16.8MB で正常配信されている(404ではない)。

## Definition of Done(停止条件)
1. **[最重要] Web で研究条件に関わらず必ず shiro.vrm が描画される。** `?condition=text` を含む
   全条件で、Playwrightスクショにキャラが写ること(ブランクでない)。
2. ロード失敗/WebGL非対応時も**無言のブランクにせず**、明示メッセージ or 再試行を出す(堅牢性)。
3. オンボーディング/UIを批判的分析し、初見ユーザーが迷わない導線にする(研究アンケートの
   製品からの除去/名前入力導線/最初の一言など)。
4. iOS版がWebと同じ「常時アバター表示+同等オンボーディング」に収束している(実機目視は申し送り可)。
5. 各反復で `npm run build` 緑 + ts/react-reviewer の CRITICAL/HIGH ゼロ。Web変更はデプロイして
   本番スクショで確認。

## 非対象/制約
- 研究データ収集機能は「製品からは外す」が、コードを物理削除するかは最小ステップで判断
  (まずアバター表示のゲートを外す→survey等の研究UI除去は後続反復)。
- realistic.vrm(51MB>25MB)は引き続きデプロイ除外。全条件 shiro.vrm 固定で問題なし。
- iOSの最終的な実機動作確認はユーザー目視に依存(ヘッドレス環境の制約)。

## 反復計画(smallest verifiable step)
- IT1: Webアバターを条件から切り離し常時 shiro.vrm ロード(根治)。`?condition=text`で検証。← 今
- IT2: ロード失敗/WebGLフォールバックUI(無言ブランク根絶)。
- IT3: オンボーディング/UI批判分析→改善(研究アンケート除去・初見導線)。
- IT4: iOS収束(常時アバター+同等オンボーディングの差分確認・修正)。

## 検証手段
- 本番 https://aikata.taku810616.workers.dev を Playwright で開く → console/network/`toDataURL`スナップ。
- MCP `browser_take_screenshot` は連続WebGL下で5秒タイムアウト多発 → 確実なら preserveDrawingBuffer +
  canvas.toDataURL()(spring-debugハーネスで実証済の手法)。本番SPAは preserveDrawingBuffer 無しなので
  `browser_take_screenshot` をリトライで使う(数回で成功する実績あり)。
