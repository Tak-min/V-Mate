# P-H7: RevenueCatログイン失敗による権利未付与バグの修正(2026-07-28)

## 背景

security-reviewer(opus)がPaywall改善ループのレビュー中(同日、`federated_auth_google_line_and_paywall_loop_2026-07-28.md`参照)に発見した、
依頼者本人が懸念を表明した重大バグ。`RevenueCatManager.logIn(_:)`が失敗すると購入がRevenueCatの
匿名ID(`$RCAnonymousID:...`)に紐づいたままになり、worker側webhookが`getUserById`でユーザーを
見つけられず、権利を一切付与せずサイレントに終わっていた(ログすら残らない)。ユーザーは実際に
Apple/Googleへ課金されるのに、V-Mate側は何もアンロックしないという金銭被害になりうる欠陥。

設計はcode-architect(Opus)に委譲した。実装前にRevenueCat SDKソース(`purchases-ios` 5.81.1の
`IdentityManager.swift`)を実測で確認した上でブループリントを作成してもらっている。

## 根本原因と設計上の重要な発見

**`logIn`のthrow/成功は束縛状態の判定に使えない。** `IdentityManager.performLogIn`は、新しい
appUserIDが実際に永続化されるのは成功パスの中だけだが、**既に同一IDで束縛済みの場合は
`customerInfo(fetchPolicy: .cachedOrFetched)`を呼ぶだけの早期分岐**になっており、オフラインで
キャッシュミスすると束縛は正常なのに`logIn`はthrowする。つまり「`logIn`がthrowしたら未束縛」と
判定すると、オフライン環境で正しく束縛済みのユーザーを誤ってブロックしてしまう。

唯一の信頼できる判定基準は`Purchases.shared.appUserID`(SDKが`UserDefaults`に永続化する同期
プロパティ、ネットワーク不要)とサーバの`user_id`の**文字列一致**そのもの。この比較を
`RevenueCatManager.syncIdentity()`に集約し、購入導線はこれが一致している(`.bound`)ときにしか
開かないようにした。

## 実装内容

### iOS側

- `RevenueCatManager.swift`: `StoreIdentityState`(`.unknown`/`.signedOut`/`.bound(userId)`/`.unbound`)
  と、MainActor非依存の純関数`StoreIdentity.matches(appUserID:serverUserID:)`を追加。
  `syncIdentity()`が起動時・Sign in with Apple直後・StoreView表示時・購入タップ時の4箇所から
  呼ばれる単一の入口になった。既に`.bound`かつSDK側のappUserIDも一致していればネットワークI/O
  なしで即返す高速パスを持つ(購入タップ時の体感コストをゼロにするため)。`logIn(_:)`は
  private化し、外部から直接呼べなくした。
- `StoreView.swift`: `.unbound`のときは押せない購入ボタンではなく専用notice(理由+再試行導線、
  P-H1/P-H4と同じ規約)に差し替え。加えて`packageCard`のdisabled条件と`purchase(_:)`冒頭に
  多層防御でバインドチェックを追加(タップ時は`syncIdentity()`の高速パスにより通常0ms)。
- `AccountView.swift`: Sign in with Apple直後の結果メッセージを束縛成否で出し分け、サインイン
  済みだが`.unbound`のときの警告行+再試行ボタンを追加。
- `CompanionViewModel.swift`: `bootstrap()`の`fetchMe`+`logIn`の3行を`syncIdentity()`の1行に置換。
- 新規テスト`Tests/StoreIdentityTests.swift`(`StoreIdentity.matches`の5ケース、Swift Testing)。
  `project.pbxproj`に4箇所手動登録(旧来形式プロジェクトの既知の作法、
  `xcode-pbxproj-manual-file-registration.md`参照)。
- `build_sim`(buildForTesting)→`test_sim`で29件全green(既存24件+新規5件)。

### worker側

- `index.ts`の`postRevenueCatWebhook`、`if (!user)`分岐(219-220行目)に`console.warn`+
  `recordDailyMetric("revenuecat_webhook_unbound", "anonymous" | "unknown_user")`を追加。
  **fail-closedの挙動(権利を付与しない)は一切変更していない** — 既存のREGRESSIONテストが
  守っている正しい設計。追加したのは観測層のみ。`app_user_id`が`$RCAnonymousID:`形式かどうかで
  「クライアント側の束縛バグが本番で発火している」(`anonymous`)と「削除済みアカウント宛など
  概ね良性」(`unknown_user`)を区別できるようにした。
- `revenuecat-webhook.routes.test.ts`: `daily_metrics`テーブルをbeforeEachのDDLに追加、既存の
  「unbound app_user_idは何も書き込まない」REGRESSIONテストを「かつ観測可能な計測が残る」まで
  拡張、`unknown_user`ディメンション用の新規テストを追加。
- worker側テスト81件(既存80+新規1)全green、typecheckクリーン。

## 副次的な発見: 本番workerが滞留していた

修正の実装に入る前、code-architectが本番workerに実際にHTTPリクエストを送って検証したところ、
最終デプロイ(`wrangler deployments list`で確認: 2026-07-28T04:50:22Z UTC = 13:50:22 JST)が
commit `29cb14c`(P-C1: Proサブスクにサーバ側クォータを実装)より前であることが判明した
(commit `29cb14c`は同日13:56:37 JST)。git commit時刻とデプロイ時刻を突き合わせて独立に確認済み。

つまり本番では、`368e476`以降の全コミット(P-C1のクォータ実装、P-C3/P-H1〜H6/P-M3/P-M4の
Paywall修正一式)が未反映のまま稼働していた。「Proに課金しても本番では何もアンロックされない」
という、過去にresolvedとされた問題(P-C1)が実は本番では再現し得る状態だった。

依頼者に確認したところ、**「コードは変更したその都度デプロイする」が既存の恒久ルール**
(`feedback-vmate-push-deploy-every-turn`メモリに記載済み、2026-06-20確立)であることが判明。
確認待ちで保留せず、このセッションの変更と合わせて本番デプロイまで実施する。

**ハマりどころ**: 上記メモリはR2バケット移行前の古い手順(`backend/static/models/realistic.vrm`の
退避が必要、という記述)を含んでいたが、現在の`wrangler.jsonc`ではモデルは`r2_buckets`
(`aikata-models`)経由になっており、この回避策はもう不要。デプロイは`npm run deploy`
(`build:frontend && wrangler deploy`)のみで完結する。

## 状態・today以降のフォローアップ

- [x] iOS実装・テスト・build_sim/test_sim確認
- [x] worker実装・テスト・typecheck確認
- [ ] commit → push → 本番デプロイ(このメモの直後に実施)
- [ ] デプロイ後、本番で`/api/entitlements`等の疎通確認

**今回スコープ外にした論点(次に着手する際の入口)**:
1. **既に被害に遭ったユーザーの救済経路が無い。** 束縛が事後的に成功しても、サーバ側の
   `entitlements`を遡って埋め直す仕組みが無い。RevenueCatのTRANSFER webhookがこの遅延バインドを
   カバーするかは未検証。確実な復旧路としては、認証済みuser_idで`fetchSubscriber`→
   `applyRevenueCatEntitlements`を合成イベントIDで実行する`POST /api/entitlements/sync`の新設が
   考えられるが、worker新規ルート+デプロイを伴う別案件として次回に持ち越す。
2. クライアント側ゲートの発火頻度を測る`purchase_blocked_unbound`計測イベントは、
   `ANALYTICS_EVENTS`許可リスト変更(worker側)を伴うため、次のworker変更時にまとめて検討する。
3. iOS側に`GET /api/entitlements`を叩く経路が無いため、「RevenueCatはPro・サーバは未付与」という
   乖離をクライアントから自動検出することは現状のAPI利用状況ではできない。1と併せて設計すべき。
