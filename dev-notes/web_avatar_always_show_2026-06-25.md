# Web版「キャラが何も表示されない」根治 — 研究条件ゲートの除去 (2026-06-25)

> ループ(loop-engineer)IT1の記録。次セッションがコールドスタートで続きを進められるように残す。
> 関連: `.loop/ALWAYSAVATAR_VISION.md` / メモリ [[aikata-companion]] / `dev-notes/cloudflare_deploy_workflow_2026-06-18.md`

## 症状 → 原因 → 修正

- **症状**: ユーザー報告「ウェブ版でキャラクターが読み込まれず、何も存在しない」。
- **再現/診断(本番 https://aikata.taku810616.workers.dev で実施)**:
  - `/models/shiro.vrm` は **HTTP 200・16.8MB・654ms で正常配信**(404ではない)。コンソールエラー0。
  - 私の高速回線の既定アクセスでは**キャラは正常表示**(乖離)。→ ネットワーク失敗ではない。
  - コード追跡で確定: `App.tsx` `visualBodyEnabled = condition !== 'text'`(L35)+ `useCompanion.ts`
    `if (condition === 'text') { setReady(true); return; }`(viewer未生成)。
- **真因**: 本番 `v-mate` に**研究A/B条件システム(text/stylized/realistic)が残存**。サーバが
  uidハッシュで条件を安定割付し、**`text` を引いた約1/3のユーザーは3Dアバターが一切描画されない**
  =「何も存在しない」の正体。研究は本来 **別リポ `v-mate-study`** の責務(2026-06-16のブランド分離参照)。
  2026-06-23の一時対応は `realistic`→404 だけを潰し、`text` ブラックアウトは見落としていた。
- **修正(IT1)**:
  - `useCompanion.ts`: アバター初期化を `condition` から**完全に切り離し**、`canvas` が出たら即
    `shiro.vrm` をロード(mount時 `[]` effect)。`text` 早期returnを削除。
  - `App.tsx`: `canvas` を常設(条件ゲート撤去)、`visualBodyEnabled`/text-only分岐を削除。
  - 堅牢性: `loadError` state追加。load/parse/WebGL失敗時に「再読み込み」フォールバックUI(無言ブランク根絶)。
  - `global.css`: `.load-error`/`.retry-button`。

## 検証(本番デプロイ後)

- `?condition=text`(`RESEARCH_ALLOW_CONDITION_OVERRIDE=true` で上書き可)で確認:
  `condition-text` クラス・`vrm-canvas` 存在・`shiro.vrm` 200・loading消滅。
- **gl.readPixels で非ブランクを客観実証**: canvas中央帯4064サンプル中 **opaque 2630 / 黒(パーカー)1586**。
  従来(text)は0のはず。デプロイ Version `30a4d0a4`、commit `a5cb3d5`(push済)。

## 重要なgotcha

- **MCP `browser_take_screenshot` は本番WebGL連続描画(rAFループ)下で5秒タイムアウトを多発**。
  本番SPAは `preserveDrawingBuffer` 無しのため `canvas.toDataURL()` も不可。
  → **`gl.readPixels` でピクセル占有/色を数値検証**するのが確実な代替(本ループで実証)。
  spring-debugハーネスのように自前canvasなら `preserveDrawingBuffer:true`+toDataURL が使える。
- **iOSは元から正しい**: `ios-avatar/entry.ts` は条件ゲート無しで常に `shiro.vrm` をロード。
  つまり「web+iOSを同じ形に」の収束は、**webをiOS側(常時表示)に寄せる**のが正解で IT1 で達成。

## IT2/IT3 完了追記(2026-06-25 同ループ)

- **IT2(Web研究撤去・完了)**: ユーザー判断「製品から完全撤去」に従い、`ResearchSurvey`(2メッセージ後の
  アンケート割込=オンボーディング阻害)・`condition`/`startResearchSession`/`logResearchEvent`/
  `submitSurvey`、`streamChat`の`condition`引数、研究系typesを撤去。**worker側は`condition`を
  "stylized"既定にしておりLLM応答に非影響**=client撤去でchat非破壊。本番で`condition`無し
  `/api/chat`が200+`emotion/token/done`正常ストリーム実証。commit `8dd81b1`/deploy `ec964bd1`。
- **IT3(iOS収束・完了)**: iOSも同じ研究スキャフォールドを持っていた(`CompanionViewModel`/`APIClient`/
  `Models`)。Web版と同一の撤去を実施。**`send()`の`let condition else { return }`という
  Web版と同じ潜在バグ(条件未取得で送信不能)も解消**。`xcodebuild`(iPhone 17 Pro sim)BUILD SUCCEEDED。
  iOSアバターは元から`condition`非依存で常時表示=収束完了。native変更のためCloudflareデプロイ不要。commit `01bd760`。
- **収束の結論**: Web/iOS とも「常時shiroアバター + 研究機能なし + chatはcondition無し送信」で一致。

## 残(任意・次イテレーション・要ユーザー判断あり)

- **研究スキャフォールドの製品からの除去**: `ResearchSurvey`(userTurns>=2でポップ)・`condition` 割付・
  `logResearchEvent`・`submitResearchSurvey` は製品UXを阻害(コンパニオンアプリにアンケート割込)。
  研究が `v-mate-study` 責務なら production から外すべきだが、**本番でも研究データを取りたいかは
  ユーザー判断**。除去するなら App.tsx/useCompanion.ts/api.ts/worker側の condition 割付も整理。
- dead CSS(`.stage-text-only`/`.text-only-presence`/`.text-only-pulse`)の掃除。
- iOSのオンボーディング/UIをWebと同等に収束(差分確認・実機目視)。
