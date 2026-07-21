-- P2: 個人を追跡しない日次プロダクト指標。
-- user_id、Cookie、IP、入力文、年齢、端末識別子は保存しない。
CREATE TABLE IF NOT EXISTS daily_metrics (
  day         TEXT NOT NULL,
  metric      TEXT NOT NULL,
  dimension   TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  total_ms    INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, dimension)
);
