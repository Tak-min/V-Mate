-- schema_v2.sql — OSS Phase B 追加テーブル
-- Lorebook (キーワード連動の世界設定注入) と messages FTS5 (RAG 全文検索) を追加。
-- schema.sql で基礎テーブルが作成済みであることを前提とする。
-- 冪等: IF NOT EXISTS。何度実行しても安全。

-- ─────────────────────────────────────────────────────────────
-- B. Lorebook — キーワードマッチで system prompt にコンテキストを注入
-- ─────────────────────────────────────────────────────────────
-- user_id = 'global' のエントリはシロ共通設定として全ユーザーに適用される。
-- user_id = <実際のUID> はそのユーザー専用設定。
CREATE TABLE IF NOT EXISTS lorebook (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_lorebook_user ON lorebook (user_id);
CREATE INDEX IF NOT EXISTS ix_lorebook_user_kw ON lorebook (user_id, keyword);

-- ─────────────────────────────────────────────────────────────
-- A. messages FTS5 — messages テーブルの全文検索インデックス
-- ─────────────────────────────────────────────────────────────
-- content=messages, content_rowid=id でコンテンツテーブルとして messages を参照。
-- content テーブルモードにすることでストレージ重複を避ける。
-- D1 (SQLite) で fts5 拡張が有効なことを前提とする。
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(content, content=messages, content_rowid=id);

-- 新規メッセージ追加時に FTS インデックスを自動更新するトリガー
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- メッセージ削除時に FTS インデックスからも削除(正規化)
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
