-- 収益化・認証・安全性の追加スキーマ(2026-07-19/20設計)。
-- 冪等: IF NOT EXISTS。schema.sql / schema_v2.sql 適用後に実行する。
-- 参照: dev-notes/monetization_architecture_2026-07-19.md, dev-notes/monetization_auth_and_safety_2026-07-20.md

-- --- 年齢ゲート ---
-- クライアント送信値は信頼せず、band は常にサーバがbirth_dateから計算する(agegate.ts)。
CREATE TABLE IF NOT EXISTS user_age (
  user_id     TEXT PRIMARY KEY,
  birth_date  TEXT NOT NULL,          -- 'YYYY-MM-DD'
  age_band    TEXT NOT NULL,          -- 'under13' | 'minor' | 'adult'
  method      TEXT NOT NULL,          -- 'self_declared' | 将来 'apple_declared_range'
  updated_at  TEXT NOT NULL
);

-- --- 通報(Apple 1.2 UGC対応) ---
CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  message_id INTEGER,                 -- messages.id(緩やかな参照、FK制約は既存テーブル群と同様に付けない)
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL,           -- 'open' | 'reviewed'
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reports_status ON reports (status);
