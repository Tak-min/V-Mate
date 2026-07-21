-- シロ(Aikata)D1 スキーマ — backend/app/memory.py の SQLAlchemy 定義を D1(SQLite)へ移植。
-- すべてのデータは user_id でスコープされる。created_at は JST の ISO 文字列を Worker が明示挿入する
-- (D1 既定の CURRENT_TIMESTAMP は UTC のため、日付境界をJSTに揃える目的で Worker 側で入れる)。
-- 冪等: IF NOT EXISTS。何度実行しても安全。

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  emotion    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_messages_user ON messages (user_id);
CREATE INDEX IF NOT EXISTS ix_messages_user_id_id ON messages (user_id, id);

CREATE TABLE IF NOT EXISTS facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, content)
);
CREATE INDEX IF NOT EXISTS ix_facts_user ON facts (user_id);

CREATE TABLE IF NOT EXISTS diary (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, entry_date)
);
CREATE INDEX IF NOT EXISTS ix_diary_user ON diary (user_id);

CREATE TABLE IF NOT EXISTS kv (
  user_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- レート制限カウンタ。scope 例: "user:<id>" / "global" / "login:<ip>"
CREATE TABLE IF NOT EXISTS usage (
  scope TEXT NOT NULL,
  day   TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, day)
);

-- 認証。user_id はこの users.id(uuid hex)を指す。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  password_hash TEXT,
  created_at    TEXT NOT NULL
);
