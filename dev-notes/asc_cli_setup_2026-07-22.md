# asc CLI (App Store Connect CLI) セットアップ(2026-07-22)

## 背景

参考記事: https://x.com/_nogu66/status/2076257073030214139
「RevenueCat AI Toolkit(課金バックエンド側)+ asc CLI(ストア側、rorkai製OSS)を組み合わせて
サブスクリプションのリリースまわりをAIエージェントに任せる」という内容。

v-mateは`storekit_purchase_flow_completion_2026-07-21.md`で完了済みの通り**自前StoreKit2実装**
(RevenueCat不使用)。したがって適用対象は asc CLI(ASC側の自動化)のみ。RevenueCat AI Toolkit導入
(=課金バックエンドの移行)は今回のスコープ外・別途判断が必要な大きな決定。

## やったこと(ローカル環境セットアップのみ、ASC側への書き込みは一切なし)

1. `brew install asc` — asc CLI 3.1.1 をインストール。
2. `asc install-skills` — 22個のAgent Skillsを `~/.agents/skills/` にコピー。
   **注意**: Claude Codeのスキル探索パスは`~/.claude/skills/`のため、これらは現状Claude Codeの
   スキル一覧には出てこない(自動では拾われない)。使うなら明示的にファイルを読むか、
   `~/.claude/skills/`側にユーザーの判断でリンクする必要がある(既存のECC管理スキル体系との
   衝突を避けるため、今回は無断でシンボリックリンク等はしていない)。
3. `asc init` — リポジトリ直下に `ASC.md`(コマンドリファレンス、コミット候補)を生成。

## 構造的にブロックされている部分(エージェントには代行不可)

asc CLIの認証には App Store Connect の「Keys」ページ
(https://appstoreconnect.apple.com/access/integrations/api) で発行する
API Key(.p8秘密鍵 + Key ID + Issuer ID)が要る。これは **Account Holder/Admin権限を持つ
Apple Developerアカウント本人のログインでしか発行できない**。

さらに:
- 一度もIAPを販売していないアプリでは、Paid Apps Agreement(有償規約)への同意と
  税務・銀行口座情報の登録が前提として必要(App Store Connect > Agreements, Tax, and Banking)。
- `asc apps` (公開API)にはアプリ**作成**エンドポイントが無く、CLIの `asc web apps create` は
  Apple ID + パスワードを使うWebセッション経由の裏技的フロー
  (`ASC_WEB_*_PASSWORD`環境変数)。つまりアプリの新規登録自体もApple IDパスワードが要る。

これらは全て「エージェントが実行してはいけない操作」(金融・銀行情報の入力、パスワードでの
認証、規約への同意)に該当するため、ユーザー本人が行う前提。

## 次にユーザーがやること(これが終われば以降はaiエージェントに委任可能)

1. App Store Connectで `vmate.pro` (bundle id: `com.takmin.vmate`) のアプリが既に登録済みか確認。
   未登録ならASC Web UIから手動登録(または本人が `asc web apps create` を実行)。
2. Agreements, Tax, and Banking で Paid Apps Agreement 同意 + 銀行口座/税務情報を設定。
3. https://appstoreconnect.apple.com/access/integrations/api でAPI Key発行
   (ロール: 少なくとも App Manager。Admin推奨)。.p8は一度しかダウンロードできないので保存必須。
4. `asc auth login --name "vmate" --key-id "<KEY_ID>" --issuer-id "<ISSUER_ID>" --private-key "<path/to/AuthKey.p8>"`
   を**本人のターミナルで**実行(APIキーをチャットに貼り付けない)。

## 4番が終わった後にAIエージェント側でできること

- `vmate.pro` サブスクリプション商品の作成(`asc subscriptions` / `asc iap`) — 価格が絡むため
  実行前に必ず確認を取る。
- ビルドアーカイブ → `asc builds upload` → 内部TestFlight配布 → Sandbox実機でのend-to-end検証
  (`storekit_purchase_flow_completion_2026-07-21.md` の「次にやるべきこと 4.」)。
- メタデータ・スクリーンショット準備。
- 外部TestFlight配布・App Store審査提出(`asc publish appstore --submit`)は不可逆かつ公開に
  関わるため、実行前に必ずユーザー確認を取る。
