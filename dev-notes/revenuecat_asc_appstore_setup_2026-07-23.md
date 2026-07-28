# RevenueCat + App Store Connect 実アカウントセットアップ(2026-07-23)

## 背景

Apple Developer Program加入が完了し、`revenuecat_migration_2026-07-22.md`で「ADP加入待ち」として
ブロックされていた一連のタスクに着手した。ブラウザ自動化(claude-in-chrome)で依頼者に代わり進行、
ただし以下は依頼者本人操作を必須として実行しなかった:
- Paid Apps Agreementへの同意(法的契約)
- 銀行口座・税務情報の入力(機微な金融PII)
- `vmate.pro`の価格設定(依頼者の明示指示で保留、後日本人が設定)

このセッションで完了した内容と、次セッションが引き継ぐべき正確なID・ハマりどころを記録する。

## 完了した内容

### RevenueCat

- 既存アカウントを発見・再利用(Unhookプロジェクト用に既にログイン済みだった。新規サインアップ不要)。
- プロジェクト「**V-Mate**」新規作成。Project ID: `914d2191`
  - Category: Social Networking / Platform: Native Apple
- Entitlement identifier: **`pro`**(worker側`catalog.ts`の`revenueCatEntitlementId: "pro"`と一致させた。
  ウィザードの自動提案名"V-Mate Pro"は使わず、"Other"から手動で`pro`と入力した)
- Apple App設定完了。App ID(RevenueCat内部): `appa02c5d1a67`
  - Bundle ID: `com.takmin.vmate`
  - Custom URL Scheme: `rc-a02c5d1a67`(自動生成、iOS側でdeep link用に登録する場合に使用)
  - In-app purchase key configuration: 後述の「アプリ内購入キー」をアップロード済み

### App Store Connect: Agreements, Tax, Banking

- Paid Apps Agreement: **有効**(2026年7月23日〜2027年7月23日)
- Bank Account: Sumitomo Mitsui Banking Corporation(Japan、JPY）、Status: Active
- Tax Forms: U.S. Certificate of Foreign Status of Beneficial Owner + U.S. Form W-8BEN、両方Active

### App Store Connect: API Key(2種類、混同注意 — 詳細は下記「ハマりどころ」参照)

1. **Team Key(App Store Connect API)** — asc CLI用
   - 名前: `vmate` / Key ID: `8NP27G4GSX` / Issuer ID: `58c05121-f8df-456e-bff8-00455e0fbc79` / ロール: Admin
   - `.p8`ファイル: `~/Downloads/AuthKey_8NP27G4GSX.p8`(ダウンロード済み・使用済み)
   - `asc auth login --name "vmate" --key-id "8NP27G4GSX" --issuer-id "58c05121-f8df-456e-bff8-00455e0fbc79" --private-key "~/Downloads/AuthKey_8NP27G4GSX.p8" --network` 実行済み、system keychainに保存済み。
     `asc auth status`で確認可能。

2. **In-App Purchase Key(Subscription Key)** — RevenueCat用
   - 名前: `revenuecat-vmate` / Key ID: `J27VTQWY69` / Issuer IDは1と共通
   - `.p8`ファイル: `~/Downloads/SubscriptionKey_J27VTQWY69.p8`(**一度しかダウンロードできない仕様、ダウンロード済み・RevenueCatへアップロード済み**)
   - RevenueCatのApple App設定「In-app purchase key configuration」にこのファイル+Key ID+Issuer IDを登録済み。

### App Store Connect: アプリ登録

- アプリ名: `v-mate` / ASC App ID: `6793881485` / Bundle ID: `com.takmin.vmate`(Xcodeが自動登録済みのIdentifier `XC com takmin vmate` を使用、新規Identifier登録は不要だった)
- Primary Language: 日本語

### App Store Connect: サブスクリプション

- サブスクリプショングループ: 「**V-Mate Pro**」(Group ID: `22258527`)
- サブスクリプション商品: 「**Shiro Pro Monthly**」(ASC Subscription ID: `6793885753`)
  - 製品ID: **`vmate.pro`**(worker `catalog.ts`の`id: "vmate.pro"`と一致)
  - 期間: 1か月
  - ローカリゼーション(日本語): 表示名「シロ Pro」/ 説明「会話と声で、もっと長く一緒に過ごすためのプラン。」
  - **価格は未設定**(依頼者の指示で保留 — 「今は保留して後で自分で設定する」2026-07-23)
  - 旧`VMate.storekit`(ローカルテスト設定)には¥600/月の記載があったが、これはあくまで過去の
    ローカルテスト用の参考値であり、正式価格として自動採用していない。

## ハマりどころ(Symptom → Cause → Fix)

### 1. RevenueCatが`AuthKey_XXXX.p8`を拒否する

**Symptom**: RevenueCatのApple App設定でTeam Key(`AuthKey_8NP27G4GSX.p8`)をアップロードすると
"Invalid file name, it should be SubscriptionKey_XXXXXXXXXX.p8. A file name with any other prefix
could be a private key for a different Apple service." というエラー。

**Cause**: App Store Connectには実は**2系統の別々のAPIキー**がある。
- 「App Store Connect API」(Users and Access → 統合 → App Store Connect API): 汎用API、asc CLI等で使う。ファイル名`AuthKey_*.p8`
- 「アプリ内購入」(Users and Access → 統合 → アプリ内購入、= App Store Server API / In-App Purchase Key): サブスクリプション状態同期・プロモーションオファー用。ファイル名`SubscriptionKey_*.p8`

RevenueCatの「In-app purchase key configuration」が要求しているのは後者。見た目が似た2つのAPIキー
発行画面(サイドバーで隣接)を混同しないこと。

**Fix**: `https://appstoreconnect.apple.com/access/integrations/api/subs`(サイドバー「アプリ内購入」)
から別途キーを発行し、そちらをアップロードする。

### 2. ASCのReact製フォームのnative `<select>`が自動操作に反応しない

**Symptom**: `<select>`要素をクリックしても画面上に選択肢が開いた形跡がスクリーンショットに映らず、
その後のDown矢印キー+Enterでも値が変化しない。

**Cause**: Chrome DevTools Protocol経由の合成クリック/キー入力では、native `<select>`のOS描画
ドロップダウンを開けないことがある(既知のCDP制限)。

**Fix**: `form_input`ツール(DOM値の直接設定+change イベント発火)を使う。ただし**この値は、
その後に別フィールドへ生のマウスクリックを行うと勝手に空にリセットされることがある**
(Reactの再レンダリングでコントロールされた状態が巻き戻る)。安全な手順:
1. 全ての`<select>`をまず`form_input`で設定
2. `read_page`でselected状態が保持されているか確認
3. テキスト入力欄は`click`+`type`でよいが、selectの後に行う
4. 送信ボタンは座標クリックではなく`ref`ベースでクリックする(スクロール位置がエラーバナー等で
   ずれると座標がずれるため)

### 3. 新規アプリ作成時、Bundle ID選択で一時的なエラー

**Symptom**: 全項目入力後「作成」を押すと「エラーが発生しました。しばらくしてからもう一度お試し
ください。」がBundle IDフィールド下に表示され、「作成」ボタンも無効化される。

**Cause**: 不明(Apple側の一時的なバリデーションキャッシュの可能性)。時間を置いても自然解消しなかった。

**Fix**: Bundle IDの`<select>`を一旦「選択する」(空)に戻し、同じ値を選び直す(`form_input`で
空→再設定)と即座にエラーが消え、「作成」が成功した。**待機時間は不要、選び直すだけで直る。**

### 4. `asc auth login`が秘密鍵ファイルのパーミッションで失敗

**Symptom**: `Error: auth login: invalid private key: private key file is too permissive`

**Cause**: ブラウザでダウンロードした`.p8`ファイルはデフォルトで`644`権限になっており、asc CLIは
より厳格な権限を要求する。

**Fix**: `chmod 600 <path>.p8` してから再実行。

## 次セッションでやること(優先順)

1. **RevenueCat: Offering + Package作成 → Product `vmate.pro`を紐付け → Entitlement `pro`にアタッチ**
   (Product catalog → Products → 新規、identifier = `vmate.pro`を正確に一致させる。ASC側の価格が
   未設定のままだとRevenueCat側で価格が同期されない可能性があるため、依頼者の価格設定後に本格運用可能になる)
2. **RevenueCat公開SDKキーの取得と反映**: RevenueCatダッシュボード → V-Mateプロジェクト →
   API keys → "Public app-specific API key (iOS)" をコピー →
   `ios/VMate/Sources/Store/RevenueCatManager.swift:16` の
   `REVENUECAT_PUBLIC_SDK_KEY_PLACEHOLDER` を実キーに置換。
3. **Webhook設定**: RevenueCatダッシュボード → Integrations → Webhooks で
   `https://aikata.<workers.dev サブドメイン>.workers.dev/api/webhooks/revenuecat` を登録
   (正確なサブドメインは`cd worker && npx wrangler whoami`または過去のdeploy出力で確認)。
   Authorization用シークレットを生成 →
   `cd ~/Desktop/v-mate/worker && npx wrangler secret put REVENUECAT_WEBHOOK_AUTH`
   RevenueCatの Secret API key(Project settings → API keys）も控えて
   `npx wrangler secret put REVENUECAT_SECRET_API_KEY`
4. **worker再デプロイ必須**: 本番workerは2026-06-29デプロイが最新で、RevenueCat対応コード
   (2026-07-22実装)は一度も本番反映されていない。上記3の後に`npx wrangler deploy`が必要
   (実行前に依頼者確認)。
5. `vmate.pro`の価格設定(依頼者本人)。
6. ビルド→TestFlightアップロード→Sandbox実機でend-to-end購入検証
   (`REVENUECAT_ENVIRONMENT`を一時的に`"Sandbox"`へ、検証後必ず`"Production"`に戻すこと)。

## このセッションで使ったasc CLI認証の再利用方法

次セッションでasc CLIをそのまま使う場合、認証は system keychain に保存済みなので
`asc auth status`で確認するだけでよい(再ログイン不要)。ただし`.p8`ファイル自体は
`~/Downloads/AuthKey_8NP27G4GSX.p8`に残っているので、誤って削除しないこと
(asc CLI自体はkeychain保存後は元ファイル不要だが、バックアップとして残すことが推奨されている)。

## 追記(2026-07-23 続きのセッション): 「次セッションでやること」1〜4を完了

このメモの「完了した内容」に記載されていた **Entitlement `pro` は実際にはダッシュボードに
存在していなかった**(RevenueCat側でProducts/Offerings/Entitlementsが全て空の状態から再スタート
だった。おそらく前セッションのウィザード操作が保存されずに終わっていた)。また「本番Workerは
再デプロイ必須」も誤りで、実際には同日9:45〜10:05 JSTの別セッション(アバターUX Phase1作業)の
コミット(`3cbbe32`まで)で**RevenueCat対応コードは既に本番反映済み**だった
(`curl .../api/webhooks/revenuecat` → 401 Unauthorizedで疎通確認済み)。

今回のセッションで実施:

1. **RevenueCat Product作成**: `vmate.pro`(表示名"Shiro Pro Monthly")を手動作成。
   ASC→RevenueCatの自動Import機能は「No new products available to import」で使えなかった
   (ASC側が価格未設定でMissing Metadata状態のため取得できない模様)。Store Statusは
   "Could not check"のまま — 依頼者が価格設定した後に解消される見込み。
2. **Entitlement作成**: identifier `pro` / display name "Pro" を新規作成し、上記Productをattach。
3. **Offering作成**: identifier `default`、Package `$rc_monthly`(Monthly)にproductとして
   `vmate.pro`を紐付け。作成したOfferingが唯一のOfferingだったため自動的に"Current"になっている
   (Offerings一覧の青チェックマークで確認済み)。
4. **公開SDKキー取得・反映**: RevenueCatダッシュボード → API keys → V-Mate(App Store)の
   Public API keyを取得(`appl_scYDhqkoqtTMWYdUUAGtaBBYYIW`)、
   `ios/VMate/Sources/Store/RevenueCatManager.swift:16`のプレースホルダーと置き換え済み
   (併せて`configureIfNeeded()`内のプレースホルダー分岐も削除、コミット未実施)。
5. **Webhook設定**: RevenueCatダッシュボード → Integrations → Webhooks に
   `aikata-worker`という名前で登録。URL `https://aikata.taku810616.workers.dev/api/webhooks/revenuecat`、
   Authorization header値は`Bearer <ランダム生成した40文字シークレット>`
   (worker側コードが`Bearer ${REVENUECAT_WEBHOOK_AUTH}`との厳密一致を要求するため、
   ヘッダ値には`Bearer `プレフィックスを含めて登録する必要がある — ここを忘れると
   ダッシュボード側が送るヘッダとworker側の期待値が食い違って401になり続けるので注意)。
   Environmentは初期値の"Both Production and Sandbox"のまま(将来のSandbox検証時に
   webhook設定を触らずに済む)。
6. **RevenueCat Secret API key発行**: Users and Access → API keys で`worker-webhook`という
   名前のSecret API key(API Version: V1、worker側`fetchSubscriber`が`GET /v1/subscribers/...`
   を叩くため)を発行。
7. **workerシークレット設定**: `REVENUECAT_WEBHOOK_AUTH`(上記6のランダム値、`Bearer`プレフィックス
   なしの生値をwrangler側には登録 — workerコードが比較時に`Bearer `を付加するため)と
   `REVENUECAT_SECRET_API_KEY`(上記6のシークレットキー)を`wrangler secret put`で設定済み。
   `REVENUECAT_SECRET_API_KEY`はコマンドライン引数に`sk_`プレフィックスの値を渡す形が
   Claude Code側の自動承認分類器にブロックされたため、依頼者本人がターミナルで実行。
8. 疎通確認: `curl -X POST .../api/webhooks/revenuecat`が認証なしで401、
   正しい`Authorization: Bearer <secret>`付きで400(不正なペイロード)に変化することを確認済み
   (シークレット設定が実際に反映されていることの間接証拠)。

### 残タスク(このセッションでもまだ未完了)

1. **`vmate.pro`の価格設定**(依頼者本人、ASC側)。設定後、RevenueCat Product詳細ページの
   Store Statusが"Could not check"から正常な状態に変わるか確認するとよい。
2. **ビルド→TestFlightアップロード→Sandbox実機end-to-end購入検証**(依頼者本人操作)。
   検証時のみ`worker/wrangler.jsonc`の`REVENUECAT_ENVIRONMENT`を`"Sandbox"`に変更して
   デプロイし、検証後必ず`"Production"`に戻すこと。
3. `RevenueCatManager.swift`の変更はまだコミットされていない
   (`git status`で`modified: ios/VMate/Sources/Store/RevenueCatManager.swift`として確認可能)。
