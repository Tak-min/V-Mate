-- [統合済み・2026-07-21] このファイルは schema.sql に統合された。以後の適用は schema.sql のみでよい。
-- 履歴ドキュメントとして残置(内容は変更しない)。

-- P3: 読み取り専用の権利基盤。schema_v4.sql / schema_v5.sql 適用後に実行する。
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
