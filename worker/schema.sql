-- シロ(Aikata)D1 スキーマ — backend/app/memory.py の SQLAlchemy 定義を D1(SQLite)へ移植。
-- すべてのデータは user_id でスコープされる。created_at は JST の ISO 文字列を Worker が明示挿入する
-- (D1 既定の CURRENT_TIMESTAMP は UTC のため、日付境界をJSTに揃える目的で Worker 側で入れる)。
-- 冪等: IF NOT EXISTS。何度実行しても安全。
--
-- 2026-07-21: schema_v2〜v7.sql を本ファイルに統合し、単一の冪等な正本にした。
-- 理由(実測): package.json に db:migrate-v3 以降のnpmスクリプトが無く、schema_v2/v4〜v7 は
-- ローカルdev D1・本番remote D1ともに未適用のまま取り残されていた(sqlite3/`wrangler d1 execute`で確認)。
-- 本番remoteは2026-07-05T12:26以降デプロイされておらず(`wrangler deployments list`で確認)、
-- 年齢ゲート以降の機能はまだ本番に出ていないため、保全すべきデータの心配なくここに集約できる。
-- schema_v4.sql の users 再構築ステップは実施不要(このファイルの users は既に NULL 許容)。
-- schema_v2〜v7.sql は変更履歴のドキュメントとして残すが、以後の適用は本ファイル(schema.sql)のみでよい。
-- 適用: `npm run db:init:local` / `db:init:remote`(冪等なので既存テーブルには影響しない)。

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
-- email/password_hash は Apple ID 連携(private relay でメール非公開、パスワード無し)を許容するため NULL 許容。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  password_hash TEXT,
  created_at    TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- schema_v2.sql — Lorebook(世界観注入)と messages の全文検索(RAG)。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lorebook (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_lorebook_user ON lorebook (user_id);
CREATE INDEX IF NOT EXISTS ix_lorebook_user_kw ON lorebook (user_id, keyword);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(content, content=messages, content_rowid=id);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- ─────────────────────────────────────────────────────────────
-- schema_v3.sql — 年齢ゲートと通報(Apple 1.2 UGC対応)。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_age (
  user_id     TEXT PRIMARY KEY,
  birth_date  TEXT NOT NULL,          -- 'YYYY-MM-DD'
  age_band    TEXT NOT NULL,          -- 'under13' | 'minor' | 'adult'
  method      TEXT NOT NULL,          -- 'self_declared' | 将来 'apple_declared_range'
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  message_id INTEGER,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL,           -- 'open' | 'reviewed'
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reports_status ON reports (status);

-- ─────────────────────────────────────────────────────────────
-- schema_v4.sql — Sign in with Apple のフェデレーション ID。
-- users は既に NULL 許容(上記)のため、旧マイグレーションの users 再構築ステップは不要。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS identities (
  provider    TEXT NOT NULL,          -- 'apple' | 将来 'google' 等
  external_id TEXT NOT NULL,          -- Apple の sub(アプリ+開発者チーム内で安定)
  user_id     TEXT NOT NULL,          -- users.id を指す(= JWT sub = スコープ鍵)
  email       TEXT,                   -- Apple から取れた場合のみ(relay 可)
  created_at  TEXT NOT NULL,
  PRIMARY KEY (provider, external_id)
);
CREATE INDEX IF NOT EXISTS ix_identities_user ON identities (user_id);

-- ─────────────────────────────────────────────────────────────
-- schema_v5.sql — 個人を追跡しない日次プロダクト指標。
-- user_id、Cookie、IP、入力文、年齢、端末識別子は保存しない。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_metrics (
  day         TEXT NOT NULL,
  metric      TEXT NOT NULL,
  dimension   TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  total_ms    INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, dimension)
);

-- ─────────────────────────────────────────────────────────────
-- schema_v6.sql — 権利基盤(エンタイトルメントが唯一の真実の源、purchasesは不変の台帳)。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entitlements (
  user_id         TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  status          TEXT NOT NULL,
  source          TEXT NOT NULL,
  expires_at      TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, entitlement_key)
);
CREATE INDEX IF NOT EXISTS ix_entitlements_active ON entitlements (user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS purchases (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              TEXT NOT NULL,
  provider             TEXT NOT NULL,
  external_id          TEXT NOT NULL,
  original_external_id TEXT,
  product_id           TEXT NOT NULL,
  kind                 TEXT NOT NULL,
  status               TEXT NOT NULL,
  occurred_at          TEXT NOT NULL,
  expires_at           TEXT,
  created_at           TEXT NOT NULL,
  UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS ix_purchases_user ON purchases (user_id, occurred_at DESC);

-- schema_v7.sql(app_store_accounts、自前StoreKit2のappAccountToken束縛用テーブル)は
-- 2026-07-22のRevenueCat SDK移行で廃止。RevenueCatのapp_user_id(=users.idを直接使う)が
-- 同じ役目を果たすため、別テーブルでの束縛が不要になった。本番remoteにこのテーブルは
-- 一度も作成されていない(未デプロイのため、既存データへの影響なし)。
