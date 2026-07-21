# 認証(Sign in with Apple)と安全性(年齢ゲート・モデレーション)設計 (2026-07-20)

`monetization_architecture_2026-07-19.md` で設計済みの収益化5メカニズムに対し、着手前に埋める必要が
特定された2つの設計欠落を補完する。architect(opus)による設計、実装は未着手。

- **(1) Sign in with Apple** — 課金(エンタイトルメント)の鍵となる安定 user_id を確立する。既存の
  email+password 認証(`worker/src/auth.ts`)の上に最小限で乗せる。ゼロから認証系は作らない。
- **(2) 年齢ゲート / モデレーション** — App Store 1.1.4 / 1.2(UGC)・Replika の EU/伊 Garante 事例を
  踏まえた課金前提の安全要件。設計・コードは現状ゼロ(grep ヒット無し)。

この2つは**エンタイトルメント基盤(既存優先順位1位)着手前に完了させる**(理由は §5)。

## 0. 前提(コードベース実測)

- `resolveUid()`(`index.ts` 41–48)は `Authorization: Bearer <JWT>` があればその `sub`、無ければ
  匿名 Cookie `aikata_uid`(`c.uid`)を返す。全データは `user_id` でスコープ。**この関数は無改修で SIWA に使える**
  ―― SIWA が発行するのは同じ HS256 JWT だから。
- `auth.signup()`(`auth.ts` 147–164)は新規 `users` 行を作り、匿名で貯めたデータを
  `reassignUserData(anonUid, userId)` でアカウントへ引き継ぐ。**SIWA の新規アカウント作成はこの流れを再利用する。**
- `users` テーブル: `id / email NOT NULL UNIQUE / password_hash NOT NULL / created_at`。Apple ID は
  メール非公開(private relay)もあり、`sub` を突っ込めない → §1.1 でスキーマ判断。
- iOS(`ios/VMate/Sources/`)に認証コードは皆無。`APIClient` は `HTTPCookieStorage.shared` の匿名 Cookie のみ、
  `Authorization` ヘッダも Keychain も無い。認証 UI/フローはゼロから作る。
- LLM は Groq(`llm.ts`、OpenAI 互換 `fetch`)。Workers 無料枠 **1リクエスト CPU 10ms**(`auth.ts` 冒頭)。
  LLM/外部 API 待ちは I/O で CPU 予算外だが、**毎メッセージ同期で重い分類 API を叩くとレイテンシとコストと依存が増える**。
- 匿名→アカウント引き継ぎ `reassignUserData`(`db.ts` 232–238)が移すのは `messages/facts/diary/kv` のみ。
  **本設計で追加する `user_age`・`entitlements`・`purchases` もこの配列に足す必要がある(重要・後述)。**

### 0.1 観測された不整合(本設計の前提に影響。本タスクでの修正対象ではないが要認識)

- `frontend/src/features/chat/api.ts` 冒頭コメント「C4」は **JWT を httpOnly Cookie でサーバ保持・
  `Authorization` ヘッダ廃止・`/api/auth/logout` 使用**と記載。しかし実測した `worker/src/index.ts` には
  ①JWT 用 Cookie の Set-Cookie が無い(Set-Cookie は匿名 uid のみ)、②`/api/auth/logout` ルートが無い、
  ③`resolveUid` は Authorization しか読まない、④`signup/login` は `{ token }` を**body で返す**。
  → **Web の認証は現状デプロイ版と source が乖離している疑い**(事実: source 不整合。推測: Web ログインが
  現 source では機能しない)。
- **本設計の判断**: iOS の SIWA は既存 `signup/login` と同じく `{ token }` を**body で返し**、iOS は Keychain 保存 +
  `Authorization: Bearer` で送る(`resolveUid` の Bearer 経路にそのまま乗る、最もクリーン)。Web の Cookie 化
  リファクタは別イシューとして分離し、iOS 経路とは独立に扱う。

---

## 1. Sign in with Apple

### 1.1 スキーマ判断 —『identities 新設 + users を NULL 許容化』を推奨

Apple ユーザーは「メール非公開・パスワード無し」がありうるため、`users` の `email/password_hash` NOT NULL と衝突する。
検討した2案:

| 案 | 内容 | Pros | Cons |
|---|---|---|---|
| A(推奨) | `identities` 新設 + `users.email`/`password_hash` を NULL 許容化 | フェデレーション ID を正しくモデル化。Google 等の追加が identities 1行で済む。`users` が唯一の「アカウント表」のまま(authMe/reassign 無改修) | SQLite は NOT NULL を ALTER で外せない → `users` 再構築マイグレーション必要(pre-launch なら安価) |
| B | Apple 用に合成 email(`apple:<sub>@vmate.invalid`)+ 検証不能な sentinel password_hash | `users` スキーマ無改修 | email 列が合成値で汚れる。将来の provider 追加で破綻。band-aid 的 |

**決定: 案 A。** 実装 0%・未リリース(メモリ確認済み)＝スキーマを正す最後の安価なタイミング。合成 email(案B)は
症状回避の band-aid で、根本(フェデレーション ID の欠如)を先送りするため採らない。

```sql
-- schema_v3.sql に追記(冪等・IF NOT EXISTS)
-- フェデレーション ID(Apple / 将来 Google 等)。email+password は users 側、外部 ID はここ。
CREATE TABLE IF NOT EXISTS identities (
  provider    TEXT NOT NULL,          -- 'apple' | 将来 'google' 等
  external_id TEXT NOT NULL,          -- Apple の sub(アプリ+開発者チーム内で安定)
  user_id     TEXT NOT NULL,          -- users.id を指す(= JWT sub = スコープ鍵)
  email       TEXT,                   -- Apple から取れた場合のみ(relay 可)。取れなければ NULL
  created_at  TEXT NOT NULL,
  PRIMARY KEY (provider, external_id)
);
CREATE INDEX IF NOT EXISTS ix_identities_user ON identities (user_id);
```

`users` の NULL 許容化 —— **一度きり**のマイグレーション(冪等ではない。schema_v3 の他テーブルとは別枠で扱う):

```sql
-- one-time（再実行不可）。SQLite は列の NOT NULL を ALTER で外せないため表を作り直す。
PRAGMA foreign_keys=OFF;
CREATE TABLE users_new (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,          -- NULL 許容(private relay / Apple 非公開時)。SQLite は複数 NULL を許す
  password_hash TEXT,                 -- NULL 許容(SIWA ユーザーはパスワード無し)
  created_at    TEXT NOT NULL
);
INSERT INTO users_new SELECT id, email, password_hash, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
PRAGMA foreign_keys=ON;
```

> **pre-launch ショートカット**: 本番 D1 に保全すべきデータが無いなら、上記再構築の代わりに `schema.sql` の
> `users` 定義を直接 NULL 許容へ書き換えて `db:init` し直すのが最短。保全データがあるなら上記マイグレーションを使う。

### 1.2 検証フローと新規エンドポイント

**`POST /api/auth/apple`**(`worker/src/apple_auth.ts` 新規、`index.ts route()` の POST 群に登録)

入力(JSON): `{ identityToken: string(JWS), rawNonce: string, fullName?: string }`
出力: `{ token: string }`(既存 signup/login と同形。iOS は Keychain 保存)/ 失敗は 401 `{ detail }`。

サーバ処理:
1. **identityToken(Apple の JWT)を検証** ―― `apple_auth.ts` に実装:
   - `https://appleid.apple.com/auth/keys`(JWKS)を取得。**module 級キャッシュ**(`let jwks; TTL 数時間`)。取得は I/O。
   - token header の `kid`/`alg`(RS256)で対応鍵を選び、`crypto.subtle.importKey('jwk', …, {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'})`
     + `crypto.subtle.verify` で署名検証。**`alg:none`/HS256 等の混同攻撃を拒否**(`auth.ts` の decodeToken H12 と同じ深度防御)。
   - claims 検証: `iss === 'https://appleid.apple.com'`、`aud === env.APPLE_BUNDLE_ID`(native SIWA は Bundle ID が aud)、
     `exp > now`、`nonce === base64url(SHA-256(rawNonce))`(リプレイ防止)。
   - 取り出す: `sub`(Apple 安定 ID)、`email?`、`email_verified?`、`is_private_email?`。
   - **client secret / authorization_code 交換 / refresh token は使わない**(サインイン=身元確立のみが目的なので identity token 検証で十分。実装量最小)。
2. **identities で `(provider='apple', external_id=sub)` を検索**:
   - **既存** → `user_id` を取り、`createToken(user_id, JWT_SECRET)` を返す(**reassign しない** ―― 復帰ログインで
     アカウントの既存データを空の匿名セッションで上書きさせない)。
   - **未登録(新規 Apple アカウント)** → `userId = crypto.randomUUID().replace(/-/g,'')` を採番 →
     `users`(email=Apple email or NULL / password_hash=NULL)+ `identities` 行を挿入 →
     `c.uid`(匿名)が別人でまだアカウント化されていなければ `reassignUserData(c.uid, userId)`(**signup と同じガード条件を再利用**)。
   - **email によるアカウント自動リンクはしない**(検証済みメール一致でも既存 email/password アカウントへ勝手に接続すると
     乗っ取りリスク)。新規 sub は常に新規アカウント。将来リンクするなら本人操作(ログイン中に追加)で明示的に。
3. iOS の匿名 Cookie(`aikata_uid`)は `APIClient` が共有 Cookie で自動送信 → サーバは `c.uid` で reassign 可能。

**`POST /api/auth/delete`**(App Store 5.1.1(v): アカウント作成を提供するならアプリ内削除も必須)
- `resolveUid` のアカウントに対し `users` / `identities` / `messages` / `facts` / `diary` / `kv` / `user_age` /
  (将来)`entitlements` / `purchases` を削除。iOS は Keychain の JWT も破棄。**サブスク解約は別**である旨を UI に明記
  (Apple のサブスクは App Store の管理画面から解約、データ削除≠課金停止)。

### 1.3 Store(`db.ts`)追加メソッド

- `getIdentity(provider, externalId): {user_id, email} | null`
- `createFederatedUser(userId, email|null, provider, externalId, appleEmail|null)` —— `users` + `identities` を
  `db.batch([...])` で原子的に挿入(片方だけ入る中途半端状態を防ぐ)。
- `deleteAccount(userId)` —— 全テーブルから該当 user_id を batch 削除。
- `reassignUserData` の tables 配列に **`user_age` を追加**(SIWA より先に年齢を入れた匿名ユーザーの引き継ぎ漏れ防止)。
  エンタイトルメント実装時に `entitlements`/`purchases` も追加すること。

### 1.4 iOS 実装

- **`ios/VMate/Sources/Networking/KeychainStore.swift`(新規)** —— JWT を Keychain(`kSecClassGenericPassword`,
  `kSecAttrAccessibleAfterFirstUnlock`)に保存/取得/削除。UserDefaults は不可(security.md 準拠)。Cookie は
  引き続き匿名フォールバックとして残すが、権威は Keychain の JWT。
- **`APIClient.swift`(改修)** —— `get`/`post`/`streamChat`/`fetchTTS` に、Keychain に JWT があれば
  `Authorization: Bearer <jwt>` を付与する共通処理を追加。付与時は `resolveUid` の Bearer 経路が優先され、匿名 Cookie は無視される。
  `authApple(identityToken:rawNonce:fullName:)` / `deleteAccount()` を追加。
- **`ios/VMate/Sources/Auth/SignInWithApple.swift`(新規)** —— `import AuthenticationServices`。
  SwiftUI の `SignInWithAppleButton`(`.signIn`)を使い、`ASAuthorizationAppleIDRequest` に `requestedScopes=[.fullName,.email]`、
  `request.nonce = sha256(rawNonce)` を設定。成功時 `ASAuthorizationAppleIDCredential.identityToken`(Data→UTF8 JWT)+
  `rawNonce` を `APIClient.authApple` へ。nonce 生成(`SecRandomCopyBytes`)+ SHA-256(`CryptoKit`)ユーティリティを同ファイルに。
- **`ios/VMate/Sources/Views/AccountView.swift`(新規、シート)** —— SIWA ボタン + 「購入を復元」+「アカウント削除」を集約。
  ヘッダ(`RootView.swift` の `HeaderControlButton` 行)に歯車アイコンを1つ足して開く。IAP 実装時の購入管理もここが自然な置き場。
- **`OnboardingView.swift`(改修)** —— **年齢ステップ(§2 で必須・ブロッキング)を追加**し、SIWA は「記録をずっと残す(任意)」の
  スキップ可能な一言 + AccountView への導線に留める(サインインを強制しない ―― アプリは匿名で動く既存前提を壊さない)。
- **`Models.swift`(改修)** —— `AuthResponse { token: String }`、`CompanionState` に将来の `entitlements` 拡張余地。

### 1.5 課金(StoreKit2)・復元導線との接続

- SIWA が確立する `user_id`(JWT sub)が、後続 IAP の `entitlements.user_id` の鍵になる。**匿名 Cookie は再インストール/
  機種変で消えるため、これが無いと購入復元が成立しない**(monetization doc §0 の課題そのもの)。
- 「購入を復元」= ①SIWA でサインイン(同一 Apple ID)→ ②StoreKit2 `AppStore.sync()` / `Transaction.currentEntitlements`
  を列挙 → ③各 `signedTransaction`(JWS)を monetization doc §2 の `POST /api/purchase/apple/verify` へ送信 →
  サーバが `resolveUid`(= Apple アカウント)を鍵に `entitlements` を upsert。SIWA はこの復元がデバイス跨ぎで成立する前提条件。

---

## 2. 年齢ゲート / コンテンツモデレーション

### 2.1 年齢ゲート

**方式**: **自己申告の生年月日(DOB)入力**を全プラットフォーム共通の最低ラインとする(オンボーディングで必須・ブロッキング)。
iOS では将来 **Apple Declared Age Range API**(iOS 18.4+ / 2026、正確な DOB を保存せず年齢レンジ+ペアレンタルコントロール連携)で
補強しうるが、v1 は自己申告で十分(Web と共通化でき、Apple/Google も課金アプリの一次防御としては自己申告 DOB を許容)。**band は
クライアント送信値を信頼せず、サーバが DOB から計算**する。

**年齢バンドと分岐**:

| バンド | 判定 | 挙動 |
|---|---|---|
| `<13` | DOB から <13歳 | **ブロック**。アカウント作成・チャット・購入すべて不可。丁寧な「この年齢では利用できません」画面のみ。これ以上データを集めない(COPPA / Apple 1.3) |
| `13-17`(minor) | 13歳以上18歳未満 | チャット可(**厳格モデレーション + minor 用システムプロンプト制約**)。**購入は全て不可**(サブスク/投げ銭/衣装を UI から隠す + サーバで拒否)。親密度メカニクスは動くが有料アンロックの CTA を出さない |
| `18+`(adult) | 18歳以上 | 全機能。購入可。ただし推し活/相棒ポジショニングの語彙は維持 |
| `unknown` | 年齢レコード無し | **最も制限的に fail-safe**(minor 相当 + 購入不可)。クライアントは年齢ステップへ誘導 |

> 注: App Store の年齢レーティング(おそらく 17+)は DL をペアレンタルコントロールでゲートするが、**アプリ内 DOB ゲートは
> 多層防御 + 購入分岐の権威**として独立に持つ。両者は別レイヤ。

**保存(スキーマ、`schema_v3.sql` に追記・冪等)**: kv 流用でなく専用表 ―― 課金を左右するコンプライアンス属性を
明示的・監査可能にするため。

```sql
CREATE TABLE IF NOT EXISTS user_age (
  user_id     TEXT PRIMARY KEY,       -- 匿名 uid でもアカウント id でも可(スコープ鍵)
  birth_date  TEXT NOT NULL,          -- 'YYYY-MM-DD'
  age_band    TEXT NOT NULL,          -- 'under13' | 'minor' | 'adult'。書き込み時にサーバが計算
  method      TEXT NOT NULL,          -- 'self_declared' | 将来 'apple_declared_range'
  updated_at  TEXT NOT NULL
);
```

**API / ミドルウェア**:
- **`POST /api/profile/age`**(`index.ts` 新規ハンドラ)—— `{ birth_date }` を受け、サーバが JST 基準で band を計算し
  `user_age` に upsert(`under13` なら別途フラグを返しクライアントはブロック画面へ)。band は**サーバ計算のみ**。
- **`assertPurchasable(store, uid): Response | null`**(`worker/src/agegate.ts` 新規)—— band を読み、`adult` 以外は
  403 `{ detail: 'age_restricted' }`。monetization doc §2 の `/api/purchase/apple/verify`・`/api/checkout/stripe`・
  有料 `/api/select` の各入口で**必ず**呼ぶ(クライアント UI を信頼しないサーバ権威ゲート)。
- **チャット**: `postChat`/`handleChat` で band を読み、`minor` フラグを `buildSystemPrompt` と `moderation` へ渡す。
- **fail-safe**: `user_age` 未登録は `unknown`=最制限。チャットは許可しつつ購入不可・minor モデレーションを適用し、
  クライアントは年齢ステップを強制。

**iOS**: `OnboardingView` に DOB ステップ(name の前)。`<13` はブロック画面(`AgeBlockedView.swift` 新規)へ遷移し
以降の UI に入れない。DOB は `POST /api/profile/age` 済みなら再入力させない。

### 2.2 コンテンツモデレーション ―― 二層(pre + post)、外部 API は同期経路で使わない

Workers 10ms CPU 制約下で毎メッセージに重い分類モデルは不可。現実解は**キーワード/正規表現の一次防御 +
システムプロンプト制約(出力の主制御)**、外部 API は必要時に**バックグラウンド(`ctx.waitUntil`)でのフラグ付けに限定**。

**`worker/src/moderation.ts`(新規)**:
- `screenUserInput(text, {minor}): { action: 'allow'|'refuse'|'crisis', category? }`
  - 2000字への正規表現は 10ms CPU に余裕で収まる(一次防御はここが常時稼働の要)。
  - **crisis(自傷/自殺)**: 冷たくブロックせず、**キャラのまま寄り添う応答 + 相談窓口(いのちの電話等)を提示**する
    特別扱い(安全 UX。moderation の「拒否」ではない)。
  - **refuse(性的/CSAM 近接/違法・危険)**: LLM に送らずキャラのまま穏当に断る + ログ。**minor はしきい値をより厳格に**。
  - **allow**: 通常フロー。
- フック位置: `index.ts postChat`(151–160)で長さ検証・レート制限の後、`handleChat` 呼び出しの**直前**。refuse/crisis は
  LLM を呼ばず即応答(SSE 1本 or JSON)。
- **出力ポストフィルタ**: 主制御はシステムプロンプト(§2.4)。加えて `chat.ts` 177–182 の既存チャンク整形フック
  (`sanitizeFourthWall(stripTags(buffer))`)の隣に `redactDisallowed(clean, {minor})` を差し込み、禁止語を検出したら
  ストリームを中断し安全なフォールバック文へ差し替える。**既存フックに相乗り**するので改修最小・CPU 予算内。
- **外部モデレーション API(任意・v1 は見送り)**: OpenAI/Google 等の moderation は I/O だが毎メッセージ同期はレイテンシ/
  コスト/依存増。**必要になったら `ctx.waitUntil` の背景ジョブ(fact 抽出と同じ場所)でアカウントをフラグ付け/レビュー**に回す。
- **Apple 1.2(UGC)対応**: AI チャットも「不適切コンテンツのフィルタ + 通報手段 + 連絡先」が要求される。1:1 AI なので
  ブロック対象の他ユーザーは居ないが、**メッセージ通報の導線**(`POST /api/report`、該当メッセージを運営レビューキューへ)を
  軽量に用意して 1.2 を満たす。iOS はメッセージ長押し等で通報。

### 2.3 課金フロー(entitlement/purchase)との接続点

- サーバ権威ゲートは §2.1 の `assertPurchasable`。minor/unknown は購入系エンドポイントで 403。
- クライアント `/api/catalog`(monetization doc §2)は band が adult でなければ有料項目を返さない/隠す(ただし**クライアントは
  信頼せず**、最終防御は必ずサーバ)。
- コピー: minor には「親友/相棒はサブスクで解放」の**購入 CTA を一切出さない**(買えない購入を煽らない)。プラトニックな
  段階progression自体は見せてよい。

### 2.4 未成年ペルソナ / コピー(推し活語彙で統一)

- `persona.ts buildSystemPrompt` に `minor?: boolean`(または `safetyLevel`)を追加し、minor 時に**ハード制約**を追記:
  恋愛/性的表現の禁止、依存助長の禁止、深刻な悩みは信頼できる大人/専門窓口へ促す、「相棒/推し」フレーム限定。
- **既存の親密度ステージ名(はじめまして→顔なじみ→友達→親友→相棒)は既にプラトニック**で恋愛語彙が無い ―― 依頼者の
  推し活転換方針とほぼ整合済み。本設計では**「恋人になる」等の恋愛的コピーを新たに増やさない**ことと、有料アンロックの
  文言を「絆を深める/相棒として認められる」に統一することを制約として固定する(親密度=課金の経済インセンティブ構造自体は不変)。

---

## 3. スキーマ変更まとめ(`worker/schema_v3.sql` に集約)

monetization doc §1 が `schema_v3.sql` を entitlements 用に予約済み。**同一 v3 マイグレーションバッチに本設計分も相乗り**させる:
- 冪等(IF NOT EXISTS): `identities`、`user_age`(+ monetization doc の `entitlements`/`purchases`/`voice_packs`/`costumes`/`sponsor_slots`)。
- **一度きり(別枠・非冪等)**: `users` NULL 許容化の表再構築(§1.1)。pre-launch なら `schema.sql` 直接書き換えで代替可。
- `reassignUserData` の tables に `user_age`(+ 実装時 `entitlements`/`purchases`)を追加。

---

## 4. 新規/改修ファイル一覧

### worker 側
- **新規**: `worker/src/apple_auth.ts`(identity token 検証 + JWKS キャッシュ)、`worker/src/agegate.ts`
  (band 計算 + `assertPurchasable`)、`worker/src/moderation.ts`(pre/post スクリーン)。
- **改修**: `worker/schema_v3.sql`(identities / user_age)、`worker/src/db.ts`(`getIdentity`/`createFederatedUser`/
  `deleteAccount`/`setUserAge`/`getUserAge`、`reassignUserData` の tables 追加)、`worker/src/index.ts`
  (`route()` に `/api/auth/apple`・`/api/auth/delete`・`/api/profile/age`・`/api/report`、`postChat` にモデレーション+age フック)、
  `worker/src/persona.ts`(`buildSystemPrompt` に `minor` 制約)、`worker/src/chat.ts`(出力ポストフィルタ相乗り、
  `statePayload`/`handleChat` へ band 伝搬)、`worker/src/env.ts`(`APPLE_BUNDLE_ID` 追加)、`worker/wrangler.jsonc`
  (`vars` に `APPLE_BUNDLE_ID`。Apple 検証は client secret 不要なので secret 追加は無し)。

### iOS 側
- **新規**: `ios/VMate/Sources/Networking/KeychainStore.swift`、`ios/VMate/Sources/Auth/SignInWithApple.swift`
  (SIWA ボタン + nonce/SHA-256)、`ios/VMate/Sources/Views/AccountView.swift`(SIWA/復元/削除)、
  `ios/VMate/Sources/Views/AgeBlockedView.swift`(<13 ブロック)。
- **改修**: `ios/VMate/Sources/Networking/APIClient.swift`(Bearer 付与 + `authApple`/`deleteAccount`/`setAge`/`reportMessage`)、
  `ios/VMate/Sources/Models/Models.swift`(`AuthResponse` 等)、`ios/VMate/Sources/Views/OnboardingView.swift`
  (DOB 必須ステップ + SIWA 任意導線)、`ios/VMate/Sources/Views/RootView.swift`(ヘッダに Account 導線)、
  `ios/VMate/Sources/ViewModels/CompanionViewModel.swift`(age/認証状態、通報)。
- **プロジェクト設定**: Xcode の Signing & Capabilities に **Sign in with Apple** capability を追加(App ID 設定も)。

---

## 5. 実装順序(推奨)

**年齢ゲート/モデレーション → SIWA → エンタイトルメント基盤**の順。

1. **フェーズ0: 安全基盤(年齢ゲート + モデレーション + 通報)** ―― 最優先。理由: **無料アプリ単体でも App Store 審査
   (1.1.4 / 1.2 / 1.3)を通すのに必須**で、課金にも SIWA にも依存しない(匿名 uid で完結)。ユーザー保護を即時に効かせられ、
   収益化以前のビルドで先行リリースも可能。`schema_v3.sql`(user_age)+ `agegate.ts` + `moderation.ts` + DOB オンボーディング。
2. **フェーズ1: SIWA アカウント連携** ―― 安定 `user_id` を確立。`identities` + `users` NULL 化 + `/api/auth/apple` +
   iOS Keychain/Bearer + AccountView + `/api/auth/delete`。email によるリンクはしない。
3. **フェーズ2以降(= monetization doc の優先順位1位「エンタイトルメント基盤」)へ進む**。

**エンタイトルメント基盤着手前に完了しておくべき最低ライン**:
- `identities` + `user_age` スキーマ適用済み、`users` NULL 化済み。
- `/api/auth/apple` が JWT を発行(iOS Bearer/Keychain 疎通)。
- `assertPurchasable`(agegate.ts)が存在し、purchase 系で呼べる状態。
- `reassignUserData` が新テーブルを移すよう更新済み。

この4点が揃って初めて、entitlements は「安定アカウント鍵 × 未成年ブロック」の両方を満たせる。

---

## 6. テスト戦略 / security-reviewer 観点

決済・認証コードのため TDD(RED→GREEN)必須、security-reviewer を必ず通す。

- **SIWA サーバ(`apple_auth.ts`)** —— 固定テスト鍵ペアで identity token フィクスチャを署名しユニットテスト:
  有効 / 期限切れ / aud 不一致 / iss 不一致 / 署名改竄 / `alg:none`・HS256 混同攻撃拒否 / nonce 不一致 / private relay で email 欠落 /
  既存 identity ログイン(reassign しない)/ 新規作成(reassign 1回)。**security 観点: RS256 署名検証の正しさ、kid 一致、
  alg 混同拒否、aud/iss ピン留め、nonce リプレイ防止、email 自動リンクしない(乗っ取り防止)。**
- **年齢ゲート(`agegate.ts`)** —— band 境界(12/13・17/18)、閏日 DOB、未来日拒否、JST 基準、未登録=最制限 fail-safe、
  purchase 系が minor/unknown で 403。
- **モデレーション(`moderation.ts`)** —— カテゴリ別テーブル駆動(allow/refuse/crisis)、minor/adult のしきい値差、
  refuse 入力が LLM に到達しない、出力ポストフィルタがストリームを中断、良性メッセージの誤検知(false positive)を通す。
- **iOS(Swift Testing)** —— KeychainStore の保存/取得/削除、`APIClient` が JWT あり時のみ Bearer を付与、nonce 生成 +
  SHA-256、アカウント削除で Keychain クリア。シミュレータ起動は避け `build_sim`/`test_sim` で検証(feedback 準拠)。
- **security-reviewer トリガ**: 認証・ユーザー入力・DB・外部 API・暗号操作すべてに該当 ―― `apple_auth.ts` / `agegate.ts` /
  `moderation.ts` / `APIClient.swift` / `KeychainStore.swift` は必ずレビュー対象。

---

## 7. 未検証事項・リスク

- **frontend/worker の JWT 経路不整合(§0.1)** ―― Web SIWA/ログインを詰める前に、Cookie 化(C4)を本当に採るのか
  `{ token }` body + Authorization に戻すのかを決める必要。iOS スコープには影響しないが Web の認証は現 source では要検証。
- **Apple Declared Age Range API** の要件詳細(iOS 18.4+ の可用性、審査での自己申告との併用可否)は本設計で一次情報未精読。
  v1 は自己申告 DOB で進め、レンジ API は補強として後追い。
- **`users` 再構築マイグレーション**を本番 D1 で流す場合の停止時間/ロールバックは未検証(pre-launch 想定のため軽量と判断)。
- **モデレーションの禁止語辞書**(特に日本語の性的/自傷表現・回避表記)の具体リストは実装時に別途整備。過剰ブロック
  (体験破壊)と見逃しのバランスは実データで調整前提。
- **iOS `VRMAvatarView.swift` 等 UI 差し替え**は本設計スコープ外(monetization doc §未検証に既出。2026-07-20のスパイク調査で
  ネイティブ実装不要と判明済み、`dev-notes/costume_swap_ios_spike_2026-07-20.md` 参照)。
