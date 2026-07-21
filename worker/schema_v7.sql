-- P4: App Store 通知を安定アカウントへ紐付けるトークン。v4-v6 適用後に実行する。
CREATE TABLE IF NOT EXISTS app_store_accounts (
  user_id           TEXT PRIMARY KEY,
  app_account_token TEXT NOT NULL UNIQUE,
  created_at        TEXT NOT NULL
);
