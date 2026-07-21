# StoreKit2 購入フロー完成(2026-07-21)

## 背景

`product-priority-and-monetization-strategy-2026-07-21.md` が定めた P4(StoreKit 2 サブスク)に
着手する前に、前セッション(複数)の実装状況を実測で棚卸しした。結論: 年齢ゲート・モデレーション・
Sign in with Apple・Keychain・アカウント削除は実装済みでテストも green だったが、**決済の実体
(証明書チェーン検証)と配線(iOS購入UI)が手つかず**だった。具体的には:

- `ios/VMate/Sources/Store/StoreKitManager.swift` が完全な孤立コード(`grep -rn "StoreKitManager"`が
  自身以外にヒットせず、`.prepare()`もどこからも呼ばれず、アプリのどこにも購入ボタンが無かった)。
- `worker/package.json` に `schema_v4〜v7.sql`(identities/entitlements/purchases等)へのnpmスクリプトが
  無く、ローカルdev D1にもこれらのテーブルが実在しなかった(`sqlite3 ".tables"`で確認)。
- `postApplePurchaseVerify` は「証明書チェーン検証器を導入するまでfail-closedで拒否する」という
  誠実なスタブ(常に503)のままだった。

## 重要な追加発見: 本番はまだ何もデプロイされていない

`npx wrangler deployments list` / `versions list` を確認したところ、**本番Workerの最終デプロイは
2026-07-05T12:26**で止まっており、年齢ゲート以降の全機能(4afb1c9〜)は一度もライブに出ていない。
`npx wrangler d1 execute aikata --remote --command "SELECT name FROM sqlite_master..."`(読み取り専用)
で確認した本番D1のテーブルは `users, messages, facts, diary, kv, usage, lorebook, messages_fts*,
research_events(未使用・出所不明、放置)` のみで、`user_age`/`reports`/`identities`/`entitlements`/
`purchases`/`app_store_accounts`/`daily_metrics` は**すべて本番に存在しない**。

これは「実装が壊れて本番障害が起きている」のではなく、「実装がまだ本番に出ていないので実害が無い」
ということ。ただし裏を返すと、**次に `npm run deploy` する時は、DBスキーマ適用(schema.sql、後述)と
コードデプロイを両方セットで行わないと年齢ゲート必須化(mandatory_age_gate_completion_2026-07-21.md)
が即座に500エラーで全ユーザーを詰まらせる**。デプロイ自体は本セッションでは行っていない(破壊的・
本番影響のある操作はユーザー承認が必須なため)。

## やったこと

### 1. DBスキーマの統合(`worker/schema.sql`)

`schema_v2.sql`(lorebook/FTS5)〜`schema_v7.sql`(app_store_accounts)を全て `schema.sql` へ
`IF NOT EXISTS` で冪等に統合した。理由: pre-launchで保全すべきデータが無く、`schema_v4.sql`が前提と
していた「usersテーブルの再構築」も不要(現行`schema.sql`のusersは既にNULL許容だった)。
`schema_v2〜v7.sql`は変更履歴として残置(先頭に統合済み注記を追加)。`package.json`の
`db:migrate-v3:*`スクリプトは削除、`db:init:local`/`:remote`のみに一本化。

**ローカルdev D1には適用済み**(`npm run db:init:local`)。**本番remoteには未適用**(ユーザー承認が
必要な破壊的操作のため実施していない。次にデプロイする際は `npm run db:init:remote` を先に実行する
こと。冪等なので既存データへの影響は無い)。

### 2. Apple JWS/x5c 証明書チェーン検証(`worker/src/apple_store.ts`、新規)

- ライブラリ: `pkijs` + `asn1js`(依存)、`@peculiar/x509` + `reflect-metadata`(devDependency、
  テスト用証明書生成のみ)。**Cloudflare Workers実行環境(workerd)での動作を vitest-pool-workers上の
  スパイクテストで確認済み**(正規チェーン受理・偽造チェーン拒否の両方をworkerd実機で検証してから
  本実装に着手した)。
- `verifySignedTransaction(jws, { bundleId, trustedRootDER })`: JWSヘッダの`x5c`(**標準base64、
  base64urlではない**—ここを間違えると証明書が壊れる)から証明書チェーンを取り出し、
  `pkijs.CertificateChainValidationEngine`で`trustedRootDER`を信頼アンカーとして検証、
  葉証明書の公開鍵(`certificate.getPublicKey()`)でJWS署名(ES256)をWebCryptoで検証。
  失敗は必ず`AppleTransactionError`(fail-closed)。
- **本番の信頼アンカーはApple Root CA G3をハードコード**(`appleRootCaG3()`)。
  `https://www.apple.com/certificateauthority/AppleRootCA-G3.cer` から取得し、SHA-256フィンガープリント
  (`63:34:3A:BF:...`)を独立した情報源(web検索結果)と突き合わせて一致を確認済み。
- `applyAppleTransaction(store, userId, tx)`: 検証済みtxをDBへ反映。crypto検証とDB反映を分離したのは、
  ルートレベルの結合テストが実Apple署名を用意できない一方、DB反映ロジック(冪等性・巻き戻し防止・
  商品allowlist・アカウント紐付け)は合成`AppleTransaction`で直接検証できるようにするため。

### 3. `postApplePurchaseVerify`(`worker/src/index.ts`)

スタブを実装に置換。認証+年齢ゲート(`requirePurchasableAccount`)→JWS検証→
appAccountToken突合(発行済みトークンと不一致なら403)→catalog allowlist(`catalogItemByProductId`、
未知productIdは400)→`recordPurchaseIfAbsent`+`upsertEntitlement`。ストレージ層(`upsertEntitlement`
のmonotonic guard、`recordPurchaseIfAbsent`のON CONFLICT DO NOTHING)は前セッションの実装をそのまま
再利用(新規追加不要だった)。

### 4. `jstIsoFromEpochMs`(`worker/src/util.ts`)

StoreKitのepoch ms(signedDate/purchaseDate/expiresDate)を`jstIso()`と同じ文字列書式へ変換する
ヘルパー。`upsertEntitlement`の巻き戻し防止ガードが`updated_at`の**文字列比較**のため、書式が
ずれると古い通知が新しい権利を上書きしうる。書式統一はcorrectness-criticalな注意点。

### 5. `reassignUserData`(`worker/src/db.ts`)修正

匿名→アカウント引き継ぎ時に移すテーブルへ`entitlements`/`purchases`/`app_store_accounts`を追加。
`deleteAccount`は既にこれらを含んでいたが、`entitlements`実装時に`reassignUserData`側が追従して
いなかった(前セッションのdev-noteが「要追随」と自己申告していた既知のTODO)。実運用では匿名uidが
これらの行を持つことは無い(購入は認証必須)ため実害は無いが、一貫性のため修正した。

### 6. iOS: StoreKitManagerの配線

- `StoreKitManager.swift`: `purchase()`に`appAccountToken`(サーバ発行の安定UUID、
  `GET /api/store/account-token`)を付与。`prepare()`に、認証済みなら`Transaction.currentEntitlements`
  を毎回サーバへ再送する処理を追加(ASSN V2 webhook未実装のため、更新/失効をサーバへ伝える唯一の経路)。
- `APIClient.swift`: `fetchAppAccountToken()`を追加。
- `StoreView.swift`(新規): 購入UI。`AccountView.swift`から「シロ Pro」セクション経由でシート表示。
  未認証・未成年/年齢未確認には購入導線を一切出さない(サーバ権威ゲートは別にあるが、UIでも
  「買えない購入を煽らない」方針を踏襲)。iOS 16対応のため`ContentUnavailableView`(iOS 17+専用)は
  使わず自前の簡易ビューで代替。

### 7. ローカルStoreKit Testing Configuration

`ios/VMate/VMate.storekit`(新規、`vmate.pro`のauto-renewable subscription定義)+
`ios/project.yml`に`schemes.VMate.run.storeKitConfiguration`を追加、`xcodegen generate`で再生成。
これでApp Store Connectに商品登録する前でもシミュレータで購入UIの表示確認ができる
(実際の購入トランザクションはローカル設定でも動くが、`postApplePurchaseVerify`はApple実署名しか
受理しないため、ローカルStoreKitTestの署名では**検証は必ず400になる**。UI/フロー確認用と割り切ること。
本当にend-to-endで通すにはTestFlight/Sandboxでの実機検証が要る)。

## CRITICAL: 証明書チェーン検証のfail-openバグを発見・修正(実装直後、コミット前)

`apple_store.ts` の初版は `pkijs.CertificateChainValidationEngine` にチェーン検証を丸投げしていたが、
自己レビュー中(+独立して起動したsecurity-reviewerエージェントが並行して同じ結論に到達しかけていた
— 詳細後述)に **fail-open な欠陥**を発見した。

**根本原因**: pkijsのソース(`node_modules/pkijs/build/index.js` の `sort()`)を直接読んで確認したところ、
`CertificateChainValidationEngine` は内部で `localCerts = [...trustedCerts, ...certs]` を連結し、
**その配列の「最後の要素」を検証対象の葉証明書とみなして**チェーン構築を始める。これは x5c の並び順
(RFC 7515により葉が先頭)と噛み合わない。

**具体的な攻撃シナリオ**: 攻撃者が `x5c: [自作の葉証明書, 本物のApple中間証明書]` という配列を用意し、
JWS署名を自作の葉証明書の秘密鍵(=攻撃者が完全に管理)で署名する。この`signedTransaction`を
`postApplePurchaseVerify`へ送ると、旧実装は「中間証明書→本物のRoot」という**別の**有効なチェーンだけを
検証して`true`を返してしまい、JWS署名の検証に実際使った葉証明書(x5c[0])自体がRootへ連なっているかは
**一切確認されないまま通過する**。本物のApple中間証明書は秘密ではない(公開情報)ため、この攻撃には
Appleの秘密鍵は一切不要で、**任意の取引を無料で偽造してentitlementsを付与できてしまう**、
売上に直結するCRITICALな欠陥だった。

**修正**: `CertificateChainValidationEngine`を使わず、`verifyLinearCertificateChain()`を新規実装。
x5c[0](実際に署名検証した葉証明書)を起点に固定し、`pkiCerts[i]`が`pkiCerts[i+1]`に署名されている
ことを1本の線形チェーンとして順に確認する。あわせて、**中間証明書のBasicConstraints(cA=true)**の
検証も追加した(これが無いと、Apple Developer Programの一般会員が正規に取得できる非CAの
エンドエンティティ証明書=秘密鍵を本人が保持、を「中間証明書」に仕立てて同様の偽造ができてしまう
別の穴が残る)。

**検証**: `worker/test/apple-store.test.ts`に2件のリグレッションテストを追加(既存8件+2件=10件、
全green)。(1) 攻撃者の葉+本物だが無関係な中間証明書の組み合わせを拒否すること、
(2) CA権限の無い証明書を中間証明書として使おうとした場合に拒否すること。

**余談・プロセス面のメモ**: 独立して起動したsecurity-reviewerエージェント(サブエージェント)も、
自己レビューと並行してこの脆弱性のPoCを書きかけていた(`worker/test/poc-x5c-order.test.ts`に
「x5c[last]が本物のチェーンに繋がっていればx5c[0]が偽物でも通ってしまう」という、
私が特定したものと完全に一致する攻撃を実証するテストを書いていたが、Read連打でstallし2度killした)。
このPoCファイルはスコープ外の場所(スクラッチパッドではなく本物のtest/ディレクトリ)に残っていたため
削除し、内容が重複する正式なリグレッションテストへ差し替えた。2つの独立した経路(自己レビュー+
別エージェント)が同じ結論に到達したことは、この脆弱性が「見過ごしやすい罠」ではなく実在する
深刻な欠陥だったことの裏付けになる。

**教訓**: JWS+x5c形式の証明書検証を実装する際、汎用のチェーン検証ライブラリ(pkijs等)に
「証明書の集合(pool)」を渡す形のAPIは、**どの証明書を検証対象の葉とみなすかがライブラリの内部実装
依存になりうる**という罠がある。x5c[0](署名検証に使った鍵の証明書)を明示的に固定した線形検証を
自前で書く方が、たとえコード量が増えてもこの class of bug を構造的に避けられて安全。

## 未着手・意図的に見送ったもの

- **App Store Server Notifications V2 webhook**: 個人開発ROIの観点で今回は見送り(P4b)。代わりに
  クライアント起動時の`Transaction.currentEntitlements`再送(#6)で更新/失効に対応する設計にした。
  **既知のギャップ**: 返金/取消(revoke)はStoreKitの`currentEntitlements`から即座に消えるため
  クライアントは再送しない → サーバ側の`entitlements.expires_at`は元々の期限まで残り続ける
  (最大で残りサブスク期間分の露出)。返金は稀で露出は有界という判断で許容しているが、正式にwebhookを
  実装するまでの既知の限界として明記しておく。
- **iOS側のStoreKitManagerユニットテスト**(architectブループリントが提案していたプロトコルDI経由の
  submit経路テスト)は今回スコープ外。ロジックが薄い(トークン取得→StoreKit呼び出し→サーバ送信の
  glueのみ)ことと、money-criticalな検証/DB反映ロジックはworker側で厚くテスト済み(22件)なことから
  優先度を下げた。次にiOS側の課金ロジックを拡張する際に着手すること。
- **本番デプロイ・本番D1マイグレーション**: 実施していない。ユーザー承認必須。次にデプロイする際の
  手順: (1) `cd worker && npm run db:init:remote`(冪等) → (2) `npm run deploy`。**現状
  `wrangler.jsonc`の`IAP_ENABLED`は`"false"`のままコミットされていない(未コミット差分)ため、
  たとえ今デプロイしても購入検証エンドポイントは503のまま**(意図的な安全側デフォルト)。実際に
  課金を有効化するには、App Store Connectで`vmate.pro`商品を作成した上で`IAP_ENABLED`を`"true"`へ
  変更する判断が別途要る。

## 検証結果

- `cd worker && npm test`: 11ファイル72テスト green(新規24件: apple-store 10 [証明書チェーンの
  fail-open修正に対するリグレッション2件を含む], apply-apple-transaction 8, iap-verify.routes 6)。
- `cd worker && npm run typecheck`: クリーン(前セッションからの既存エラー2件も本セッションで解消: 
  `tsconfig.json`の`types`指定を`@cloudflare/vitest-pool-workers`→`@cloudflare/vitest-pool-workers/types`
  へ修正して`cloudflare:test`型解決を修正、`entitlements.routes.test.ts`の未使用変数を削除)。
- `npx wrangler deploy --dry-run`: pkijs/asn1js込みで本番バンドルサイズ 888KiB / gzip 137.62KiB
  (Cloudflare Workers無料/有料プランのサイズ上限に対して余裕あり)。
- iOSビルド(`build_sim`)・テスト(`test_sim`、既存24件): 警告0・エラー0。

## 次にやるべきこと(優先順)

1. 本セッションの変更をコミット(ユーザー未指示のため未実施)。
2. 自己レビューで証明書チェーン検証のCRITICALなfail-openバグを発見・修正済み(上記参照)。
   ただし money-critical なコードのため、コミット前にもう一段(別セッション/人力での)security-reviewerの
   通しレビューを推奨。特に`verifyLinearCertificateChain`(`apple_store.ts`)を重点的に。
3. App Store Connectで`vmate.pro`のサブスクリプション商品を実際に作成。
4. TestFlight/Sandbox実機で、ローカルStoreKit設定ではなく実Apple署名を使ったend-to-end検証
   (購入→検証→entitlement付与→復元)を行う。特に実際のApple x5cチェーンが2段(leaf+intermediate)か
   3段(leaf+intermediate+root)かをここで確認し、`verifyLinearCertificateChain`が両方のケースを
   正しく扱えることを実データで確認する(現状はテスト用に自作したチェーンでのみ検証済み)。
5. 上記が確認できたら、本番D1マイグレーション適用+デプロイ+`IAP_ENABLED=true`化をユーザー判断で。
6. 手が空いたら App Store Server Notifications V2 webhook(P4b)に着手し、#未着手の返金露出ギャップを閉じる。

## 追記(2026-07-21・コミット前 security-reviewer 通しレビューの反映)

「次にやるべきこと 2.」で推奨していた別経路の security-reviewer(Opus)通しレビューを実施した。
証明書チェーン修正(`verifyLinearCertificateChain`)は健全と再確認された一方、**新規で独立した実在の
脆弱性を2件**発見。コミット前に両方を修正した。

### 修正した脆弱性

- **Finding 1(CRITICAL): Sandbox/Production 環境の未検証。** `verifySignedTransaction` は
  `payload.environment` を読むだけで検証していなかった。Apple は Sandbox 取引を Production と**同一の
  証明書チェーン**で署名するため、チェーン検証も署名検証も通ってしまう。Sandbox 購入は捨てアカウントで
  誰でも無料で作れるので、本番公開後は「無料 Sandbox 購入の `jwsRepresentation` を捕捉 →
  `/api/purchase/apple/verify` へ POST → 無料で Pro 権利」が成立してしまう売上直結の欠陥だった。
  - 修正: `Env.APPLE_ENVIRONMENT`(`env.ts`)+ `wrangler.jsonc` の `vars` に `"APPLE_ENVIRONMENT":
    "Production"` を追加。`verifySignedTransaction` の `opts` に `expectedEnvironment: string` を追加し、
    payload 解析後に `payload.environment` が**文字列でない/欠落**または期待環境と厳密不一致なら
    `AppleTransactionError`(fail-closed)。`index.ts` の `postApplePurchaseVerify` で
    `expectedEnvironment: c.env.APPLE_ENVIRONMENT ?? "Production"` を渡す。
  - リグレッションテスト: `apple-store.test.ts` に「正規署名済みでも environment=Sandbox の取引は
    expectedEnvironment=Production で拒否される(かつ Sandbox 期待なら受理される)」を追加。既存テストは
    basePayload の `environment: "Sandbox"` に合わせ `expectedEnvironment: "Sandbox"` を渡してチェーン/
    署名機構の検証意図を保持。
  - **運用上の注意(TestFlight は Sandbox 決済):** `APPLE_ENVIRONMENT=Production` を既定でハードコード
    したため、TestFlight/Sandbox の end-to-end 検証(上記「次にやるべきこと 4.」)は本番Workerに対しては
    **意図的に必ず失敗する**。これはこのフィックスで「解決」しようとしてはいけない。プレローンチかつ
    `IAP_ENABLED="false"` の現状では正しい安全側デフォルト。TestFlight/Sandbox の実機検証を行うときは、
    **その検証に使うデプロイに限って** `APPLE_ENVIRONMENT` を一時的に `"Sandbox"` に差し替え、検証後・
    実ユーザー露出前に必ず `"Production"` へ戻すこと。

- **Finding 2(HIGH): appAccountToken 無しの取引がアカウント未束縛で横流し replay 可能だった。**
  `applyAppleTransaction` は `tx.appAccountToken` が null/欠落だと束縛チェックを丸ごとスキップして権利を
  付与していた。この null 経路は本番到達可能: iOS `StoreKitManager.purchase(_:)` はトークン取得に失敗
  すると**黙って**トークン無しで `product.purchase()` を続行し、appAccountToken の無い実 Apple 署名取引を
  生成していた。`recordPurchaseIfAbsent` の冪等性は purchases 台帳のみをガードし権利付与はガードしない
  ため、1つの null-token 取引 JWS を無数の別アカウントが各々検証して各々 Pro 権利を得られてしまう。
  - 修正(サーバ): `applyAppleTransaction` はトークン欠落を新 reason `"missing_account_token"`
    (`"account_mismatch"` とは別の失敗モードとして区別)で拒否。`index.ts` は同 reason を 400 +
    日本語文言(「購入者を確認できませんでした。アプリを最新版に更新して再度お試しください。」)で返す。
    JSDoc も「appAccountToken は必須・旧経路は存在しない」旨へ書き換え。
  - 修正(クライアント, サーバ修正とセット): `purchase(_:)` は `product.purchase()` の**前に**トークンを
    取得し、失敗/UUIDパース不能なら `StoreKitError.accountTokenUnavailable`(日本語 errorDescription)を
    throw して購入を開始しない。開始してしまうとサーバ側で必ず拒否され、ユーザーは Apple に支払ったのに
    権利が付与されない=ユーザー側の金銭損失バグになるため。`StoreView.swift` は StoreKitError を
    `message` に表示して握りつぶさないように catch を分岐。
  - **Finding 6(LOW, 同時修正):** appAccountToken 比較を `!==` から `.toLowerCase()` 正規化の
    case-insensitive 比較へ。現状は両側とも小文字だが、大小文字差だけで正規購入を誤 403 しないため。
  - リグレッションテスト: `apply-apple-transaction.test.ts` に「null-token → `missing_account_token`
    かつ entitlement/purchase を一切書かない」と case-insensitive 一致の 2 件を追加。既存 `baseTx` は
    `appAccountToken: null` だったため、正規束縛済み取引の replay-safety を検証し続けるよう `beforeEach`
    で `app_store_accounts` に既知トークンを seed し、baseTx 既定をそのトークンへ変更した。

### 未対応(要 real-money launch 前対応 — reviewer の優先度判断でコミット前必須ではない)

reviewer は次の3件も指摘したが、いずれも「証明済みの exploit」ではなく、`IAP_ENABLED` を本番で `true` に
する前(=実課金開始前)までに対応すればよいとの優先度判断。今回のコミットには含めていない。

- **Finding 3(hardening): チェーン検証が Apple Root のみをピン留めし、WWDR 中間証明書と葉の
  App Store OID `1.2.840.113635.100.6.11.1` を検証していない。** 証明済みの exploit ではないが、
  中間/葉の素性をさらに絞る hardening 余地。
- **Finding 4: `postApplePurchaseVerify` にレート制限が無い。** 検証エンドポイントの濫用対策。
- **Finding 5: 証明書 validity を wall-clock で判定している(取引の `signedDate` ではなく)。**
  証明書更新境界での軽微な可用性エッジケース。
