# 収益化アーキテクチャ設計 (2026-07-19)

サブスクリプション・ボイスパック・衣装・投げ銭・企業スポンサーの5メカニズムを実装するための設計。
architect(opus)による設計、実装はまだ未着手。

## 0. 前提(コードベース実測)

- 全データは `user_id` でスコープ。`worker/src/index.ts` の `resolveUid()` が「JWT の sub(アカウント)」or「匿名 Cookie `aikata_uid`」を返す。エンタイトルメントもこの `user_id` を鍵にすれば既存の分離モデルにそのまま乗る。
- **重要な制約(実測)**: `ios/VMate/Sources/.../APIClient.swift` には signup/login が無く、**iOS は匿名 Cookie のみ**。Cookie は再インストール/機種変で消える → IAP には「Restore」導線＝安定 ID が必須。**課金実装の前提条件として、Sign in with Apple 等でのアカウント連携、または `originalTransactionId` への権利紐付けによる復元可能性を先に入れる必要がある。**
- 親密度は `kv` テーブルの `affinity`(`Store.addAffinity`)、段階判定は `persona.ts stageFor()`(閾値 0/20/50/100/200)。レート制限は `usage` + `Store.bumpUsage`(`enforceRateLimit`)。TTS は `worker/src/tts.ts synthesize()` が env の単一 `AIVIS_MODEL_UUID` を使用、`getTts` は現状 `resolveUid` すら呼ばない。VRM は `frontend/src/features/vrm/viewer.ts` が `/models/shiro.vrm` 固定だが `CompanionViewer` は `options.modelUrl` を受け付ける。

## 1. データモデル (`worker/schema_v3.sql` 新規、冪等 `IF NOT EXISTS`)

- **`entitlements`(唯一の真実の源)**: `PK(user_id, feature)`。`feature` は `'subscription'` / `'voicepack:<id>'` / `'costume:<id>'`。列: `status`(active/expired/revoked), `source`(apple/stripe/grant), `expires_at`(サブスクのみ、NULL=永続), `updated_at`。iOS/Web どちらの検証経路もここに upsert する。
- **`purchases`(不変の台帳)**: `external_id` を **UNIQUE**(Apple `originalTransactionId` / Stripe `subscription`・`payment_intent` id)に取り冪等性を担保。列: `platform, product_id, kind`(subscription/iap/tip), `amount_cents, currency, raw_payload(JSON), created_at`。投げ銭は独立テーブルにせず `kind='tip'` で吸収。
- **カタログ**: `voice_packs`(`id, name, aivis_model_uuid, apple_product_id, stripe_price_id`)と `costumes`(`id, name, vrm_url, thumb_url, apple_product_id, stripe_price_id`)。初期は件数が少ないので `worker/src/catalog.ts` の定数マップでも可。ユーザーの選択状態は既存 `kv` を流用(`selected_voice_pack` / `selected_costume`)。
- **`sponsor_slots`(B2B、決済なし)**: `id, slot_type`(diary_footer/costume/topic), `sponsor_name, content(JSON), asset_url, starts_at, ends_at, active`。サーバ管理のみ。

`Store`(`db.ts`)に `getEntitlements(uid)` / `upsertEntitlement(...)` / `recordPurchase(...)`(`INSERT ... ON CONFLICT(external_id) DO NOTHING`)/ `isSubscribed(uid)` を追加。

## 2. API設計 (`worker/src/index.ts route()` に追加、実装は `entitlements.ts` / `purchases.ts` / `sponsors.ts` へ分割)

- `GET /api/entitlements` — 現ユーザーの有効権利＋選択中 voice/costume(の解決済み `vrm_url`)
- `GET /api/catalog` — 購入可能なサブスク階層/ボイス/衣装/投げ銭額(apple_product_id と stripe_price_id 併記)
- `POST /api/purchase/apple/verify` — StoreKit2 の `signedTransaction`(JWS) をサーバでApple証明書チェーン検証 → purchases+entitlements upsert
- `POST /api/webhooks/stripe` / `POST /api/webhooks/apple` — Stripe署名検証(`STRIPE_WEBHOOK_SECRET`)とApp Store Server Notifications V2。更新・失効・返金をここで権利に反映
- `POST /api/checkout/stripe` — Web用Checkout Session生成
- `POST /api/select` — 所有権利を検証してkvの選択を更新
- `GET /api/sponsors/active`(公開読み取り) / `POST /api/admin/sponsors`(管理鍵で保護)

## 3. プラットフォーム別決済とサーバ検証

- **iOS = StoreKit 2 一択**(Apple 3.1.1)。サブスク=auto-renewable、ボイス/衣装=non-consumable、投げ銭=consumable。サーバ側はJWSのx5c証明書チェーン検証で完結(旧verifyReceipt共有シークレット不要)。加えてServer Notifications V2を購読し権利を権威化。
- **Web = Stripe推奨**(実装量・審査リスク最小、解約UIはCustomer Portalに委譲)。権利書き込みはリダイレクトではなく必ずwebhookを信頼。
- **集約**: 両経路とも `entitlements` に `resolveUid()` の `user_id` を鍵に upsert。**iOSアプリ内からStripeへ誘導するのは3.1.1/anti-steering違反**につき厳禁。

## 4. 親密度×サブスク連携

`kv.affinity` の生値は加算し続け、表示/口調に使う段階だけゲート。`persona.ts` に `effectiveStage(score, subscribed)` を追加。
- 会話: 無料30/日、サブスクで実質無制限(`enforceRateLimit` を `isSubscribed` で分岐)
- 親密度: 無料は「友達」(score 50)で頭打ち。「親友/相棒」はサブスク解放
- 日記: サブスク限定 or 無料は月N件
- 感情表現は**ゲートしない**(体験を壊すため)。TTSはコストがかかるためサブスク特典化が妥当

## 5. ボイス/衣装の配信・解放

- **ボイス(軽い・最優先)**: `getTts` を `resolveUid` + 選択packの `aivis_model_uuid` 解決に変更、`tts.ts synthesize()` に `modelUuid` 引数を追加。サーバがAivisのモデルUUIDを差し替えるだけでクライアント配信物は不要。
- **衣装(重い)**: 権利 `costume:<id>` → 選択をkv → `/api/entitlements` が解決済み `vrm_url` を返す。フロントは `CompanionViewer` の `options.modelUrl` に渡すだけ。セッション中の着替えは `viewer.ts` に `swapModel(url)` を追加(既存 `load()` 再利用、dispose→再ロード)。iOSも `VRMAvatarView.swift` で同様(**未検証**、衣装機能実装前に要確認)。VRMはR2配信(`R2_MODEL_KEYS` 追加、>25MiB対応)。
- **content制約**: 各衣装VRMが同じblendshape名とhumanoidリグを持つことが必須。`viewer.ts` の `TORSO_COLLIDER_SPECS` はshiro.vrm専用実測なので**衣装ごとにコライダー再調整が必要**(髪/スカート貫通対策)。ここが衣装のコスト中心。

## 6. 実装優先順位(個人開発規模でのROI)

1. **エンタイトルメント基盤**(schema_v3・Store・`/api/entitlements`・`/api/catalog`) — 他4機能の依存基礎
2. **サブスク**(Web Stripe先→iOS StoreKit) — 既存のレート制限/親密度/日記ゲートを再利用でき収益確度が最も高い。Webは審査リスクゼロで先行検証可能
3. **ボイスパック** — 変更面が `tts.ts`＋`getTts`＋選択のみで最小、新規アセット配信不要
4. **衣装** — アート制作＋衣装別コライダー調整＋viewer差し替えで最重量。ボイスの後
5. **投げ銭** — 技術は容易だがiOSは審査グレー(下記)。Web先行、iOSはconsumable IAPで慎重に
6. **企業スポンサー** — 決済コード不要で疎結合。最後。開示要件を満たす表示だけ実装

## 7. App Store / Google Play審査リスク

- **3.1.1**: サブスク・ボイス・衣装・投げ銭は**iOS上では必ずIAP**。Stripeを直接叩くとリジェクト確定
- **投げ銭(グレー)**: 「シロ/運営を応援」は寄付ではなくデジタルコンテンツ扱い→consumable IAP必須。実世界の便益や慈善を示唆すると別規約に抵触。**iOS初期は投げ銭を外しWeb限定で始める判断も合理的**
- **恋愛/親密度コンパニオン**: Apple 1.1.4 / Googleの成人向け・年齢確認要件が厳格化傾向(Replikaの EU/伊Garante事例)。**実効的な年齢ゲート(17+/18+)＋ユーザー入力チャットのモデレーション**を課金前提として実装
- **スポンサー開示**: スポンサード日記/衣装/話題はApple 3.2.2・FTC上**明示ラベル必須**(「Sponsored」等)。ペルソナに紛れ込ませる形は不可

## 主要ファイル参照

- 追加: `worker/schema_v3.sql`, `worker/src/entitlements.ts`, `worker/src/purchases.ts`, `worker/src/catalog.ts`, `worker/src/sponsors.ts`, `ios/VMate/Sources/Store/StoreKitManager.swift`
- 改修: `worker/src/index.ts`(`route()`・`getTts`・`resolveUid`), `worker/src/db.ts`(Store追加メソッド), `worker/src/tts.ts`(`synthesize`に`modelUuid`), `worker/src/chat.ts`(`statePayload`/`enforceRateLimit`のゲート), `worker/src/persona.ts`(`effectiveStage`), `worker/src/env.ts`(Stripe/Appleシークレット), `frontend/src/features/vrm/viewer.ts`(`swapModel`), `frontend/src/features/chat/{api.ts,types.ts}`, `ios/.../{APIClient.swift,Models.swift}`(`CompanionState`/`entitlements`拡張)

## 未検証事項

- `ios/VMate/Sources/Avatar/VRMAvatarView.swift` の衣装差し替え可否は本レビューで内部を精読していない(衣装機能のiOS実装前に要確認)
- カタログを定数化するかテーブル化するかは商品点数が固まってから判断(初期は定数マップ推奨)
