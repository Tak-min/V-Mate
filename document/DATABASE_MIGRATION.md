# データベースマイグレーションガイド

## 問題: `no such column: avatar_url`

既存のデータベースがOAuth対応の新しいスキーマに更新されていない場合、このエラーが発生します。

## 解決方法

### オプション1: マイグレーションスクリプトを実行（推奨）

既存のデータを保持したまま、データベーススキーマを更新します。

```bash
cd src
python migrate_database.py
```

このスクリプトは以下を実行します:
- データベースの自動バックアップ (`.backup`拡張子)
- `avatar_url`カラムの追加
- `oauth_accounts`テーブルの作成
- 必要なインデックスの作成

### オプション2: データベースを削除して再作成

**警告**: この方法では既存のユーザーデータと会話履歴が削除されます。

```bash
# データベースファイルを削除
rm config/memory.db

# アプリケーションを起動（自動的に新しいスキーマで再作成されます）
cd src
python app.py
```

### オプション3: 手動マイグレーション

SQLiteコマンドラインで手動実行:

```bash
sqlite3 config/memory.db
```

```sql
-- avatar_urlカラムを追加
ALTER TABLE users ADD COLUMN avatar_url TEXT;

-- oauth_accountsテーブルを作成
CREATE TABLE IF NOT EXISTS oauth_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(provider, provider_user_id)
);

-- インデックスを作成
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_provider ON oauth_accounts (provider, provider_user_id);

-- 終了
.quit
```

## 確認

マイグレーション後、テーブル構造を確認:

```bash
sqlite3 config/memory.db "PRAGMA table_info(users);"
```

`avatar_url`カラムが表示されればOKです。

## アプリケーションの再起動

マイグレーション後は必ずアプリケーションを再起動してください:

```bash
cd src
python app.py
```

## トラブルシューティング

### マイグレーションスクリプトが見つからない

```bash
# プロジェクトルートから実行
cd AIWife-test/src
python migrate_database.py
```

### データベースファイルが見つからない

`.env`ファイルで`DATABASE_PATH`を確認:

```env
DATABASE_PATH=./config/memory.db
```

### 権限エラー

データベースファイルとディレクトリに書き込み権限があることを確認:

```bash
# Windows
icacls config\memory.db

# Linux/Mac
ls -la config/memory.db
chmod 644 config/memory.db
```

## バックアップの復元

マイグレーションに問題があった場合:

```bash
# バックアップから復元
cp config/memory.db.backup config/memory.db
```
