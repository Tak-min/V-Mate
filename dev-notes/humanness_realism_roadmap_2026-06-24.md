# 「より人間に近づける」UX改善ロードマップ(3Dリアリティ中心) — 2026-06-24

> 目的: 次セッション(別AIエージェント想定)がコールドスタートで着手できるよう、批判的・懐疑的
> 分析の結論と、各改善トラックの「根本原因・実装方針・該当ファイル・検証方法・落とし穴」を
> 具体的に残す。**今回は実装せず設計のみ**(ユーザー指示「ドキュメントにまとめて次回参照できるように」)。
> 関連: [[aikata-companion]] / `ios/dev-notes/ui_button_clarity_2026-06-24.md` / 親メモリ
> [[feedback-analysis-before-implementation]](分析依頼=実装許可ではない、を踏まえ本回は文書化に留めた)。

## 0. 前提と懐疑的スタンス
3Dキャラ「シロ」はWeb版`frontend/src/features/vrm/viewer.ts`(three-vrm 3.5.3 / three 0.184)を
**WKWebView越しにiOSでも再利用**している(1コードベース方針)。`.vrm`は
`frontend/public/models/shiro.vrm`(本番=Worker/R2配信、`backend/static/models/shiro.vrm`にも複製、
要同期)。`realistic.vrm`(51MB)は現状未使用(2026-06-23に`modelUrl`をshiro.vrm固定化)。

**懐疑的事実**: 手続きアニメによる「人間らしさ」は既に高度に作り込まれている(`viewer.ts`を実読):
瞬き(二重瞬き/まどろみ/文末同期)、視線(ワイドグランス/凝視回避/微小サッカード/ポインタ追従)、
呼吸、体重移動(settle)、アイドルモーション巡回、リップシンク(実音声+手続き代替)、親密度で
距離感/表情ベースライン変化。**→「アニメをさらに足す」系は費用対効果が逓減。安易に追加しても
体感は上がりにくい。** 伸びしろは「描画の質」と「物理(貫通)」と「接地感」に偏在している。

## 1. トラック評価サマリ(impact × 実現可能性 × 検証可能性)

| # | トラック | impact | この環境での検証可能性 | 優先 |
|---|---|---|---|---|
| A | 描画リアリティ(トーンマッピング/ライティング/リムライト/色) | 高 | ◎ スクショで確実 | **最優先** |
| B | 接地感(コンタクトシャドウ) | 中〜高 | ◎ スクショで確実 | 高 |
| C | 髪・スカートの貫通(スプリングボーン コライダー) | 中〜高 | △ 動的3D・正面スクショで判別困難/実機目視依存 | 中(要ユーザー目視) |
| D | 会話/声の人間らしさ(間・相づち・プロアクティブ) | 中 | ○ ログ検証可 | 別軸 |

**結論(批判的)**: ユーザーが例示した「髪の貫通(C)」は、実は**最も検証しづらく最も資産依存が
大きい**。AとBは同等以上の"リアルさ"体感を、スクショで確実に検証しながら低リスクで出せる。
よって**着手順は A → B → C** を推奨。Cに入る前にA/Bで「土台のリアルさ」を上げてから、Cは
実機目視を挟みつつ慎重に。

---

## 2. トラックA: 描画リアリティ(最優先・低リスク・スクショ検証可)
**該当**: `frontend/src/features/vrm/viewer.ts` のコンストラクタ(renderer/lights 設定, L133-152)。

### 現状の問題(根本原因)
- `renderer` に**トーンマッピング未設定**(= `THREE.NoToneMapping`)。`outputColorSpace=SRGB`のみ。
  → ハイライトが飛び/陰影が硬く「のっぺり」。実写系/PBR寄りの見栄えにならない。
- ライトは key(directional 1.6) + fill(directional 0.7) + hemisphere(0.9) の3点のみで**リムライト無し**。
  → 背景(AmbientBackground)とキャラの輪郭が分離せず、立体感・存在感が弱い。
- MToon(VRM)シェーダ前提だが陰影のトーンが単調。

### 実装方針(次回)
1. `renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0前後`を
   設定(まず最大の体感差。露出は0.9〜1.15でスクショ比較して詰める)。MToonはtoneMappingの影響を
   受けるので**露出過多に注意**、スクショで白飛びチェック。
2. **リムライト(バックライト)追加**: キャラ背後やや上から弱い寒色 directional を当て、髪/肩の
   輪郭を起こす。`new THREE.DirectionalLight(0xbfd4ff, 0.5〜0.8)`をカメラ反対側・上方に。
3. key/fillの色温度・強度を露出変更に合わせて再バランス(暖色keyを少し下げ、立体の階調を残す)。
4. (任意・重め)EffectComposer+UnrealBloomで瞳ハイライトだけ軽く滲ませると生命感が出るが、
   モバイルWebGL負荷とWKWebView性能を要計測。**まずは1〜3だけで十分な可能性が高い**。

### 検証
- `npm run build:ios-avatar`相当 → シミュレータ起動 → `xcrun simctl io <sim> screenshot`で
  before/afterを並べて目視。露出値ごとに撮って比較。**スクショで完結する**のが本トラックの強み。
- iOSはWKWebView経由なので、Web(`npm run dev`)のブラウザでも同viewerを確認できる(より速い反復)。

### 落とし穴
- iOSアバターは本番Workerの`/ios-avatar/avatar`から配信される(同一オリジンでCORS回避)。viewer変更は
  `npm run build`(build:ios-avatar内包)→ Worker再デプロイで実機反映。**realistic.vrm 51MB退避手順**
  (デプロイ落とし穴1, [[aikata-companion]]参照)を忘れずに。
- toneMapping変更はMToonの見え方を大きく変える。happy/sad等 各感情の表情でも白飛び/黒潰れしないか確認。

---

## 3. トラックB: 接地感(コンタクトシャドウ)
**該当**: `viewer.ts` シーン構築。現状キャラは影が無く「床から浮いて」見える=非現実感の一因。

### 実装方針(次回・2択)
- **軽量案(推奨)**: 足元に**ぼかした楕円の半透明黒プレーン**(疑似コンタクトシャドウ)を1枚置く。
  `PlaneGeometry` + 放射状グラデのcanvasテクスチャ or `ShadowMaterial`不使用の安価な板。背景は
  透過(`alpha:true`)でアプリ側AmbientBackgroundに合成されるため、**全面の床は置かず足元の影だけ**に
  するのがデザイン的に正解。settle/breathで体が動く分、影をmodelBaseに固定し微小追従。
- **本格案**: `renderer.shadowMap.enabled=true` + directionalに`castShadow` + 受け影プレーン。
  MToon+シャドウは設定が増え負荷も上がるので、**まず軽量案で十分**。

### 検証
- スクショで「足元に影があり接地して見えるか」を目視。◎ この環境で完結。

---

## 4. トラックC: 髪・スカートの貫通(ユーザー例 / 最も厄介)
**該当**: `viewer.ts` の `this.vrm?.update(delta)`(L638)がスプリングボーン物理を駆動。
**根本原因**: viewer.tsに**スプリングボーンのコライダー設定が一切無い**。髪/スカートの揺れは
`.vrm`にオーサリングされたコライダーだけに依存し、**shiro.vrmが胴体コライダーを十分に持っていなければ
髪は必ず胴・服を貫通する**(ユーザー報告と整合)。

### 対応の3レイヤ(下に行くほど本格的・高コスト)
1. **実行時パラメータ調整(最小)**: 髪ジョイントの剛性(stiffness)を上げ/可動域(hitRadius等)や
   gravityを調整して、貫通が目立つ大揺れを抑える。**根治ではない**が軽減はできる。three-vrm 3.xの
   `vrm.springBoneManager.joints`(各 `VRMSpringBoneJoint` の `.settings` に stiffness/dragForce/
   gravityPower 等)を走査して調整。
2. **実行時コライダー追加(中)**: 胴体/胸/腰にカプセル/球コライダーを生成し、髪のスプリングボーン
   グループに割り当てる。three-vrm 3.x API(**インストール版3.5.3で正確なexport名を要確認**):
   - `vrm.humanoid.getNormalizedBoneNode('chest'|'spine'|'upperChest'|'hips')` でボーンnode取得。
   - `VRMSpringBoneCollider`(Object3D) + shape(`VRMSpringBoneColliderShapeCapsule`/`...Sphere`、
     `offset`/`radius`/`tail`)を、そのボーンnodeに `add` してワールド追従させる。
   - `VRMSpringBoneColliderGroup{ name, colliders[] }` を作り、対象の各髪ジョイントの
     `colliderGroups` に push。`vrm.springBoneManager` 経由で登録が要る場合があるのでmanagerの
     reset/再構築要否を確認。
   - **採寸が肝**: モデルのスケール/ボーン位置に合わせてカプセル半径・長さを実測調整。
     値はスクショ+実機目視で詰める(自動では決まらない)。
3. **アセット編集(本格・周辺ファイル)**: `shiro.vrm` をBlender(VRM-Addon-for-Blender / UniVRM)で
   開き、胴体・胸・腰のスプリングボーンコライダーを正しく作り込んで再エクスポート。ユーザーの言う
   「コードベースだけでなく周辺ファイルを巻き込む大規模改善」はこれ。**この環境(ヘッドレス)では
   Blender自動化が非現実的**=人手 or 別途GUI作業が必要。再エクスポート後は
   `frontend/public/models/shiro.vrm` と `backend/static/models/shiro.vrm` の両方を更新+Worker再デプロイ。

### 検証(ここが難所)
- 貫通は**動きながら横/斜めから見て初めて分かる**。正面静止スクショでは判別困難。次回は:
  - **デバッグ用にカメラを軌道回転(OrbitControls)できる検証ページ**を一時的に用意し、各.vrmaモーション
    (mujaki/genki/oshitoyaka/cool/shy)を再生しながら多角度で貫通を確認するのが効率的。
  - 最終判定は**ユーザーの実機目視**に依存する前提で、各反復ごとに確認を依頼する設計にする。
- コライダー可視化(three-vrmのhelper、`VRMSpringBoneJointHelper`/`colliderHelper`があれば)を一時表示
  すると採寸が早い。

### 落とし穴
- 実行時コライダーはモデル個別採寸=shiro.vrm専用。realistic.vrm復活時は別採寸。
- スプリングボーンは`vrm.update(delta)`順序に依存。コライダー追加後にmanagerの再初期化が要るか確認。

---

## 5. トラックD: 会話/声の人間らしさ(3D以外・別軸)
3Dと独立で効く。**本番=worker/(TS)**であることに注意(backend/Pythonを直しても本番未反映、要移植)。
- 間(ま): 文末ポーズ、相づち("うん"、"そうなんだ")の自然挿入。persona.ts/chat.tsのストリーム整形。
- プロアクティブ: nudge/greetingの文脈精度(既存`/api/nudge`)を上げる。
- 声の抑揚: Aivisの`emotional_intensity`/`speaking_rate`は感情マップ済み。SSML(`use_ssml`)で
  ポーズ/強調を入れる余地。tts.ts。
- 検証: SSEログ/実機会話で確認可能(3Dより検証は楽)。

---

## 6. 次セッションの推奨ビルド順(コールドスタート用TODO)
1. **A-1**: viewer.tsにACESトーンマッピング+露出。Web(`npm run dev`)でスクショ比較 → 露出確定。
2. **A-2**: リムライト追加 → スクショ比較。
3. **B**: 足元コンタクトシャドウ(軽量案) → スクショ。
4. ここまでを commit/push + Worker再デプロイ(realistic.vrm退避手順)→ 実機確認。
5. **C-1**: 髪スプリングボーンの剛性/重力を実行時調整で貫通軽減 → OrbitControls検証ページで多角度確認。
6. **C-2**: 胴体コライダー実行時追加(採寸) → 多角度+実機目視(ユーザー依頼)。
7. C-3(.vrm Blender編集)は、C-1/C-2で不足な場合のみ。GUI作業/人手が要る前提でユーザーと相談。
- 各ステップでビルド緑(`npm run build` tsc / iOS `xcodebuild`)+ swift/ts-reviewerゲート。

## 7. 検証インフラの整備(次回最初にやると効率的)
- three-vrmの**OrbitControls付き単体検証ハーネス**(各.vrmaモーション再生+多角度+コライダー可視化)を
  `frontend/`にdev専用ページとして用意。髪貫通/描画/接地を回しながら見られる。これが無いと
  トラックCは検証コストが高すぎる。

## 7.5 実装ログ(2026-06-24 同日・Track A+B 実装/デプロイ済み)
- **Track A 実装済み**(`viewer.ts`): `renderer.toneMapping = ACESFilmicToneMapping` + `exposure 1.15`、
  寒色リムライト(`0xbcd2ff`, intensity 1.1, pos(-0.9,2.3,-2.0))追加、key/fill/ambientを微調整。
  **検証**: ios-avatar standaloneをローカル静的配信(`python3 -m http.server`)+ヘッドレスブラウザ
  (Playwright)でbefore/afterスクショ比較 → 髪のツヤ/輪郭分離・顔の階調が明確に向上(`/Users/taku8/
  avatar_baseline.png` vs `avatar_trackA.png`)。露出1.15で白飛び無し。
- **Track B 実装済み**(`viewer.ts` `addContactShadow`): bounding box最下端基準の放射状グラデ
  CanvasTextureプレーンを足元に敷設(`toneMapped:false`/`depthWrite:false`/`renderOrder:-1`)、
  dispose時にgeometry/material/**texture**を解放。
- **検証の落とし穴(重要発見)**: `cameraPosition`/`cameraLookAt`のコンストラクタ引数は
  **`updateRelationship()`が毎フレーム上書き**するため事実上デッド。standaloneの構図は
  compactViewport判定(=ビューポート幅)で決まり、近め(上半身)構図に固定される。よって
  **足元のコンタクトシャドウはこの検証ビューポート(840×873≒正方形)では枠外**で見えない。
  実機の縦長フル構図(iPhone ~390×844)では足が映る(過去のUIスクショで確認済)ため、**Bの影は
  実機目視で最終確認が必要**。影は上半身構図では枠外=無害(回帰なし=スクショで確認)。
  → 次回: フル構図検証には`updateRelationship()`のbaseZ/lookYを一時的に変える or ブラウザ
  ビューポートを縦長にする必要がある。`cameraPosition`引数を活かしたいなら
  updateRelationshipが引数を尊重するよう要改修(別タスク)。
- **デプロイ済み**: commit `215f116` → push → `worker`へ`npm run deploy`(realistic.vrm退避手順)。
  本番bundleに`ACESFilmic`/`toneMapping`が含まれることをcurlで確認(=live)。本番
  `ENABLE_TTS=true`同様、iOSアプリは次回起動時に新描画を読み込む(WKWebViewが`/ios-avatar/`を取得)。
- **Track C(髪貫通)は本ループ見送り**: 検証困難(多角度/実機目視必須)かつ高リスクのため、
  ロードマップ§4の設計のまま次回へ。「検証可能なものから出す」原則に従いA/Bを先行リリースした。

## 8. 既知の環境制約(再掲)
- SourceKit(IDE)はiOSターゲットを誤検知(偽陽性)。真判定は`xcodebuild`のみ。
- SE級シミュレータ無し(iPhone 17系/iPad miniのみ)。狭幅UIは`layoutPriority`等で防御済み。
- 本番デプロイ時 realistic.vrm(51MB>Cloudflare 25MB上限)の一時退避が必須。
- 3D貫通は静止スクショで検証困難=実機目視/多角度ハーネスが要る(本ロードマップ最大の検証課題)。
