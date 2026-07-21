-- Sign in with Apple 用の一回限りマイグレーション。
-- 既存 D1 では schema.sql / schema_v3.sql 適用後に一度だけ実行すること。
-- `wrangler d1 execute aikata --remote --file=./schema_v4.sql` は本番データを変更するため、
-- バックアップとメンテナンス手順を確認してから明示的に実行する。

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

CREATE TABLE users_new (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  password_hash TEXT,
  created_at    TEXT NOT NULL
);
INSERT INTO users_new (id, email, password_hash, created_at)
  SELECT id, email, password_hash, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE TABLE identities (
  provider    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  email       TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (provider, external_id)
);
CREATE INDEX ix_identities_user ON identities (user_id);

COMMIT;
PRAGMA foreign_keys=ON;
