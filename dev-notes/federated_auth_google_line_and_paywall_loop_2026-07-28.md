# Google/LINEログイン拡張 + Paywall/アカウントUI自律改善ループ (2026-07-28)

依頼: (1) Apple専用のログインをGoogle/LINEにも拡張する、(2) TIG(→実際は「UIの設定」の
音声認識誤変換)の設定画面とPaywall機能を強化し、自律的な改善ループを回す。

architect(opus)による実装ブループリントを受けて着手。**Paywallループの生きたタスクリストは
`.loop/PAYWALL_VISION.md` + `.loop/PAYWALL_state.json` が正本**(`.loop/`はgitignore対象、
このマシン上でのみ persist する。セッションをまたいでも消えないが、fresh cloneでは失われる)。
本ドキュメントはgit管理下に置く要約+再開手順。

## 依頼1: Google/LINEログイン拡張

### 事実誤認の訂正(着手前に判明)
- 「iOS側に認証コードが無い」は誤り。`AccountView.swift`に`SignInWithAppleButton`が実装済みだった
  (過去のdev-noteが古い情報だった)。→ 実際は「動いているApple経路をGoogle/LINEに汎用化する」作業。
- `identities`テーブル(`worker/schema.sql`)は元々provider非依存の汎用設計(PK=(provider,external_id))
  だったが、コード側(`db.ts`のcreateAppleUser等)が`'apple'`をハードコードしていた。

### 完了(commit cf48469, 2026-07-28)
- `worker/src/federated.ts`(新規): `AuthProvider`/`FederatedIdentity`/`FederatedTokenError`の共通型。
- `worker/src/jwks.ts`(新規): Apple/Google共通のJWKS検証器(RS256/ES256対応、provider別キャッシュ)。
  `apple_auth.ts`はこれを使う薄いラッパに書き換え済み。
- `worker/src/db.ts`: `createAppleUser`→`createFederatedUser(userId, provider, externalId, email)`に一般化。
  **同時にusers.emailを常にNULLにする修正も実施**(同一メールの2人目のプロバイダユーザーが
  UNIQUE制約違反で登録不能になる構造的バグの回避。メールはidentities.emailにのみ保存)。
  `listIdentityProviders(userId)`を追加。
- `worker/src/auth.ts`: `loginWithApple`→`loginWithProvider(store, secret, identity: FederatedIdentity, anonUid)`。
- `worker/src/index.ts`: `authMe`のレスポンスに`providers`(連携済みプロバイダ配列)を追加。
- テスト: `worker/test/federated-account.test.ts`(新規、同一メール複数プロバイダの回帰テスト)。
  worker全体で80テストgreen。

### 未着手・要外部アカウント設定(次セッションで続ける場合はここから)
architectのブループリント全文はこのセッションの会話ログにあるため、**再開時はarchitectに
再度ブループリントを出させるより、まず以下の要点で直接実装を進めてよい**:

1. **依頼者側の準備が必要(私からは実施不可)**:
   - Google Cloud ConsoleでOAuthクライアントID発行(iOS用+Web用の2つ)
   - LINE DevelopersでLINE Loginチャネル作成、iOSのbundle ID(`com.takmin.vmate`)登録、
     `openid` scope有効化
   - **LINEの`POST https://api.line.me/oauth2/v2.1/verify`の正確なリクエスト/レスポンス仕様は
     未検証(私はオフラインで一次ドキュメントを確認できなかった)。実装前に必ずLINE Developers公式
     ドキュメントで確認すること。**
   - GoogleSignIn-iOS SDKの`signIn(withPresenting:hint:additionalScopes:nonce:)`が
     導入予定バージョン(7.1.0以降を想定)に存在するか確認。

2. **worker側の残作業**:
   - `worker/src/google_auth.ts`(新規): `verifyGoogleIdToken(token, allowedAudiences, expectedNonce)`。
     `jwks.ts`をそのまま使える。`iss`は`https://accounts.google.com`と`accounts.google.com`の
     **両方**を受理(Google仕様)。`aud`はiOS/Web両クライアントIDの許可リストにする。
   - `worker/src/line_auth.ts`(新規): `verifyLineIdToken(idToken, channelId, expectedNonce)`。
     `/v2/profile`ではなく`/oauth2/v2.1/verify`(ID token検証)を使う設計 —
     `/v2/profile`はトークンが自チャネル向けか検証しないためトークン置換攻撃に弱い。
   - `index.ts`に`authGoogle`/`authLine`ハンドラ+`route()`への登録(`authApple`と同型)。
   - `env.ts`に`GOOGLE_CLIENT_IDS?`/`LINE_CHANNEL_ID?`追加、`wrangler.jsonc`の`vars`に設定
     (**secretではなく公開値**。未設定時は503でfail-closedにすること。`APPLE_BUNDLE_ID`のような
     デフォルト値フォールバックは絶対にしない=aud検証が素通りする穴になる)。
   - アカウントリンクポリシー: **メールによる自動リンクはしない**(既存のApple方針を踏襲。
     Apple private relay・LINE/Googleのメール検証保証レベルの違いが理由)。手動の複数プロバイダ
     紐付け導線もv1では作らない(YAGNI、マージ処理が別プロジェクト規模になるため)。

3. **iOS側の残作業**:
   - SPM追加: `GoogleSignIn-iOS`(product: GoogleSignIn, GoogleSignInSwift)、`line-sdk-ios-swift`
     (product: LineSDK)。`project.pbxproj`手動編集が必要
     (このプロジェクトは`PBXFileSystemSynchronizedRootGroup`未使用の旧来形式 — 詳細は
     [[xcode-pbxproj-manual-file-registration]]、今回`AuthState.swift`追加時にも同じ手順を踏んだ)。
   - Info.plistにURL scheme(Google reversed client ID、LINEの`line3rdp.<bundle id>`)、
     `LSApplicationQueriesSchemes`に`lineauth2`、`GIDClientID`。
   - `Sources/Auth/AuthProvider.swift`(新規、`enum AuthProvider`)、
     `Sources/Auth/SocialSignInService.swift`(新規、各SDK呼出+`APIClient.signIn(provider:idToken:nonce:)`)。
   - `Sources/Auth/AuthState.swift`は**今回のPaywallループ側(P-H6)で先に作成済み**
     (`@Published isAuthenticated`)。Google/LINE実装時はここに`providers`も反映させる形で拡張する。
   - `AccountView.swift`の`accountSection`にGoogle/LINEボタンを追加。**Apple最上段、次いでGoogle→LINE
     の順、同じ高さ(48pt)。ブランド規約上、Google/LINEには`BrandPrimaryButtonStyle`(ピンクグラデ)を
     使わず各社公式スタイルに従うこと**(Apple 4.8対応、意図的にデザイン統一を諦める判断)。
   - Web(`frontend/`)は**スコープ外のまま**: `frontend/src/features/chat/api.ts`がJWTをbodyから
     読んでおらずWeb版ログイン自体が壊れている既知バグ(`dev-notes/web_auth_broken_finding_2026-07-20.md`)
     があるため、Web側のGoogle/LINE追加はこのバグ修正が先行タスクとして必要。

## 依頼2: Paywall/アカウントUI自律改善ループ

`.loop/PAYWALL_VISION.md`が正本。DoD・優先順位ルール・検証コマンド・TODOリスト(重大度別)を
定義済み。**再開時はまずこのファイルとPAYWALL_state.jsonを読むこと。**

### 解消済み(このセッション、2026-07-28)
| 項目 | 内容 | commit |
|---|---|---|
| P-C1 | Proサブスクが何もアンロックしない致命的バグ。サーバ側クォータ(チャット500/日・TTS300/日・日記毎日、無料はそれぞれ50/30/週2)を実装し、StoreViewの訴求コピーも実装値に一致させた | 29cb14c |
| P-C2 | 利用規約/プライバシーポリシーの実URLが存在しなかった。Worker内蔵の静的ページとして`/terms` `/privacy`を新規実装・本番デプロイ | 368e476 |
| P-C3 | 未サインインユーザーがPaywallに到達できなかった(購入導線がisAuthenticated内側にあった) | e3a5701 |
| P-H6 | `isAuthenticated`が非Observableで再描画に暗黙依存していた問題 | 48f07d0 |
| (付随) | 2026-07-23の別セッションで検証済みながら未コミットのままだったiOSデザインシステム統一(Theme.swift等)を発見・回収してコミット | ed57293 |

本番URL: `https://aikata.taku810616.workers.dev/terms` , `/privacy`(WebFetchで表示確認済み)。

### 未解消(優先順位順、`.loop/PAYWALL_VISION.md`にfile:line付きで詳細あり)
- P-H1: `StoreView.swift`の`try? fetchAge()`が失敗を握り潰し「年齢制限」と誤表示
- P-H2: 購入成功時にRevenueCatの反映待ちで無反応になりうる
- P-H3: 復元が対象ゼロでも常に成功表示
- P-H4: `RevenueCatManager`が`loadOfferings`/`refreshCustomerInfo`等のエラーを全て`try?`で握り潰す
- P-H5: サブスク中に「ご利用中」バッジがパッケージ数だけ重複描画されうる
- P-M3(DoD必須): Paywallの計測イベント(`paywall_viewed`等)がゼロ
- P-M4(DoD必須): AccountViewにサインアウトが無い(削除しかない)
- P-M1/P-M2/P-M5〜M8、P-L2/L3/L5: MEDIUM/LOW、DoD外だが余力があれば

### 再開方法
1. `.loop/PAYWALL_VISION.md`と`PAYWALL_state.json`を読み、`resolved`/`blocked`を確認。
2. `.loop/PAYWALL_PROMPT.md`の手順(優先順位に従い未resolvedの最上位を1つ選び、最小差分で実装→
   build_sim/test_sim or worker npm test→state.json更新→commit)に従って1イテレーションずつ進める。
3. Google/LINEの外部アカウント設定(上記「依頼1」節)が完了していれば、そちらも並行して着手可能。
