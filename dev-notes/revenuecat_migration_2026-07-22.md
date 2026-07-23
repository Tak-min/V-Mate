# RevenueCat SDK 移行(2026-07-22)

## 背景

Shipaton 2026(RevenueCat主催のハッカソン)への応募を計画。公式ルール(2025年版、2026年詳細は
8/1公開前のため代理指標)の Project Requirements に "Entrants must create a working software
application that uses the RevenueCat SDK to power in-app purchases" と明記されており、応募必須要件と
確認した(`asc_cli_setup_2026-07-22.md`参照)。v-mateは`storekit_purchase_flow_completion_2026-07-21.md`
で完成させた自前StoreKit2実装(JWS/x5c証明書チェーン検証込み)だったため、RevenueCat SDK経由へ
移行した。

設計はcode-architect(Opus)に依頼し、そのブループリント通りに実装した(要旨: 自前の署名検証
[apple_store.ts]は削除しRevenueCatに委譲、`entitlements`/`purchases`テーブルはそのまま流用し
webhook同期のキャッシュとして再利用、`app_store_accounts`は廃止しRevenueCatの`app_user_id`
[=users.idをそのまま使う]がアカウント束縛の役目を引き継ぐ)。

## 実施内容

### worker側(Cloudflare Workers)

- **新規** `src/revenuecat.ts`: webhookペイロードの検証(`parseRevenueCatWebhookEvent`)、
  定数時間の shared secret 比較(`timingSafeEqual`)、RevenueCat REST API
  (`GET /v1/subscribers/{app_user_id}`)からの正規化状態取得(`fetchSubscriber`)、
  purchases/entitlementsへの反映(`applyRevenueCatEntitlements`)。
- **新規** `POST /api/webhooks/revenuecat`(`index.ts`の`postRevenueCatWebhook`): JWTではなく
  `Authorization: Bearer <REVENUECAT_WEBHOOK_AUTH>`で認証するサーバー間エンドポイント。
- **削除**: `src/apple_store.ts`(自前JWS/x5c検証、pkijs依存)、`GET /api/store/account-token`、
  `POST /api/purchase/apple/verify`、`db.ts`の`getOrCreateAppAccountToken`、
  `schema.sql`の`app_store_accounts`テーブル(本番未デプロイのため既存データへの影響なし)、
  `package.json`の`pkijs`/`asn1js`/`@peculiar/x509`/`reflect-metadata`。
- **変更**: `catalog.ts`に`revenueCatEntitlementId`フィールド追加(RevenueCat側の
  entitlement identifier「pro」と`vmate.pro`商品を対応付け)。`env.ts`/`wrangler.jsonc`の
  `IAP_ENABLED`/`APPLE_ENVIRONMENT`を`REVENUECAT_ENVIRONMENT`(既定"Production")+
  secrets(`REVENUECAT_WEBHOOK_AUTH`, `REVENUECAT_SECRET_API_KEY`、共に`wrangler secret put`で
  設定する前提、未設定)へ置き換え。`authMe`のレスポンスに`user_id`を追加(iOS側がRevenueCatの
  `Purchases.shared.logIn`に渡すため)。

### セキュリティ学びの引き継ぎ(2026-07-21に発見した2件の脆弱性クラス)

- **Sandbox/Production環境の厳密検証**: 旧実装のCRITICAL修正(payload.environmentの厳密一致)を、
  webhookの`event.environment`が`REVENUECAT_ENVIRONMENT`と厳密一致しない限り権利を付与しない形で
  再実装。テスト`revenuecat-webhook.routes.test.ts`の「SANDBOX webhookはPRODUCTIONワーカーで
  grantしない」で回帰確認済み。
- **アカウント未束縛の取引拒否**: 旧実装のHIGH修正(appAccountToken必須化)を、
  `event.app_user_id`が`store.getUserById`で実在ユーザーに解決できない限り権利を付与しない形で
  再実装(専用テーブル不要、RevenueCatの`app_user_id`=`users.id`をそのまま使うため)。テストで
  「未知のapp_user_idはentitlement/purchaseを一切書かない」を回帰確認済み。
- **副産物としての改善**: RevenueCatの`is_active`フラグをそのまま`status: "revoked"`として
  即座に反映するようにしたため、旧実装が抱えていた既知の限界(返金がexpires_atの残り期間だけ
  露出し続ける)が解消された。`apply-revenuecat.test.ts`の
  「EXPIRATION/CANCELLATION revokes access immediately」で確認済み。

### iOS側

- **新規** `Sources/Store/RevenueCatManager.swift`(旧`StoreKitManager.swift`を置換): 起動時
  `configureIfNeeded()`(APIキー未発行の間は何もせずクラッシュを避ける)、`logIn`/`logOut`、
  `loadOfferings`/`purchase`/`restorePurchases`/`refreshCustomerInfo`。
- **変更**: `StoreView.swift`をStoreKitの`Product`直接購入からRevenueCatの`Offering`/`Package`
  ベースへ全面書き換え(旧`appAccountToken`事前取得ロジックは不要になり削除、購入導線が単純化)。
  `APIClient.swift`から`verifyApplePurchase`/`fetchAppAccountToken`を削除、`fetchMe()`を追加。
  `AccountView.swift`(Sign in with Apple成功直後)と`CompanionViewModel.swift`(永続トークンでの
  復帰時)の両方でRevenueCatへの`logIn`を実行(匿名IDをアカウントへ紐付ける2つの経路)。
  `VMateApp.swift`起動時に`RevenueCatManager.shared.configureIfNeeded()`を呼ぶ。
- **project.yml**: `packages:`にRevenueCat SPM(`https://github.com/RevenueCat/purchases-ios`,
  `from: 5.0.0`)を追加、VMateターゲットの`dependencies:`に追加。`xcodegen generate`で反映済み。

## 検証結果

- `cd worker && npm test`: 10ファイル63テストgreen(旧apple_store関連24件削除、新規
  apply-revenuecat 7件 + revenuecat-webhook.routes 8件を追加)。
- `cd worker && npm run typecheck`: クリーン。
- `npx wrangler deploy --dry-run`: エラー無し。
- iOS `build_sim`: 警告0・エラー0(初回、`RevenueCat`/`StoreKit`両方が`SubscriptionPeriod`を
  持つため型があいまいになるビルドエラーが1件出たが、`RevenueCat.SubscriptionPeriod`と明示して解消)。
- iOS `test_sim`: 既存24件全てgreen(回帰なし、購入ロジックのユニットテストは元々スコープ外
  だったため今回も追加していない)。

## 未着手・構造的にブロックされている部分(Apple Developer Program加入待ち)

以下はコードでは対応不能で、依頼者本人のApple Developer Program加入(申請中、24〜48時間審査待ち)
完了後に着手する:

1. **RevenueCatアカウント・プロジェクト作成**(ADP不要、いつでも着手可): 公開SDKキーを発行し
   `RevenueCatManager.swift`の`apiKey`プレースホルダーを実キーへ差し替える。
2. **(ADP必須)** App Store ConnectでPaid Apps Agreement同意+税務・銀行口座情報登録。
3. **(ADP必須)** App Store Connectで`vmate.pro`サブスクリプション商品を作成、RevenueCat
   ダッシュボードとApp Store Connectを連携(ASC API Key経由)、RevenueCat側でOffering+
   Entitlement「pro」を`vmate.pro`へマッピング。
4. **(ADP必須)** TestFlight/Sandbox実機でのend-to-end検証(購入→webhook→entitlement反映→復元)。
   検証時は`REVENUECAT_ENVIRONMENT`を一時的に`"Sandbox"`へ差し替え、検証後・実ユーザー露出前に
   必ず`"Production"`へ戻すこと(旧実装から引き継いだ運用上の注意点)。
5. 上記が確認できたら、本番D1マイグレーション(`npm run db:init:remote`)+デプロイを依頼者判断で。

## 次にやるべきこと(優先順)

1. 本セッションの変更をコミット(ユーザー未指示のため未実施)。
2. 依頼者がApple Developer Program加入完了後、RevenueCatアカウントを作成し公開SDKキーを発行、
   `RevenueCatManager.swift`のプレースホルダーを差し替える。
3. `wrangler secret put REVENUECAT_WEBHOOK_AUTH` / `REVENUECAT_SECRET_API_KEY`を設定(値は
   RevenueCatダッシュボードのWebhook設定画面・API Keys画面から取得)。
4. 上記「未着手」の2〜5を順に。
