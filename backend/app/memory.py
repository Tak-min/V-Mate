"""SQLite/Postgres 互換の長期記憶ストア(ユーザー分離対応)。

すべてのデータは user_id でスコープされる(マルチユーザー公開のため)。
messages: 会話履歴 / facts: 抽出事実 / diary: シロの日記 / kv: 親密度・名前等の単一値。

旧スキーマ(user_id なし)の既存DBは init_db 時に user_id='local' として自動移行する。
"""

from __future__ import annotations

import sqlite3
from datetime import date, datetime
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "aikata.db"

# Phase A はローカルSQLite。Phase B で DATABASE_URL(Postgres)対応を追加する。

_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    emotion TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE(user_id, content)
);
CREATE TABLE IF NOT EXISTS diary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE(user_id, entry_date)
);
CREATE TABLE IF NOT EXISTS kv (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);
"""

LEGACY_USER_ID = "local"  # 旧シングルユーザーDBの移行先


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def _is_legacy(conn: sqlite3.Connection) -> bool:
    """旧スキーマ(messages テーブルはあるが user_id 列が無い)か判定する。"""
    cols = _table_columns(conn, "messages")
    return bool(cols) and "user_id" not in cols


def _migrate_legacy(conn: sqlite3.Connection) -> None:
    """旧スキーマ(user_id なし)を user_id='local' で引き継ぐ。

    呼び出し前に必ず _is_legacy で確認すること(旧テーブルを rename してから
    新スキーマを作るため、先に _SCHEMA を流すと user_id インデックス作成で失敗する)。
    """
    conn.executescript(
        "ALTER TABLE messages RENAME TO messages_old;"
        "ALTER TABLE facts RENAME TO facts_old;"
        "ALTER TABLE diary RENAME TO diary_old;"
        "ALTER TABLE kv RENAME TO kv_old;"
    )
    conn.executescript(_SCHEMA)
    conn.executescript(
        f"INSERT INTO messages (id, user_id, role, content, emotion, created_at) "
        f"SELECT id, '{LEGACY_USER_ID}', role, content, emotion, created_at FROM messages_old;"
        f"INSERT INTO facts (id, user_id, content, created_at) "
        f"SELECT id, '{LEGACY_USER_ID}', content, created_at FROM facts_old;"
        f"INSERT INTO diary (id, user_id, entry_date, content, created_at) "
        f"SELECT id, '{LEGACY_USER_ID}', entry_date, content, created_at FROM diary_old;"
        f"INSERT INTO kv (user_id, key, value) "
        f"SELECT '{LEGACY_USER_ID}', key, value FROM kv_old;"
        "DROP TABLE messages_old; DROP TABLE facts_old;"
        "DROP TABLE diary_old; DROP TABLE kv_old;"
    )


def init_db() -> None:
    with _connect() as conn:
        if _is_legacy(conn):
            _migrate_legacy(conn)  # 旧テーブルを rename → 新スキーマ作成 → データ移行
        else:
            conn.executescript(_SCHEMA)  # 新規 or 移行済み(IF NOT EXISTS で冪等)


# --- kv ---

def get_kv(user_id: str, key: str, default: str | None = None) -> str | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT value FROM kv WHERE user_id = ? AND key = ?", (user_id, key)
        ).fetchone()
    return row["value"] if row else default


def set_kv(user_id: str, key: str, value: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO kv (user_id, key, value) VALUES (?, ?, ?) "
            "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
            (user_id, key, value),
        )


def get_affinity(user_id: str) -> int:
    return int(get_kv(user_id, "affinity", "0") or 0)


def add_affinity(user_id: str, delta: int) -> int:
    score = get_affinity(user_id) + delta
    set_kv(user_id, "affinity", str(score))
    return score


# --- messages ---

def add_message(
    user_id: str, role: str, content: str, emotion: str | None = None
) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO messages (user_id, role, content, emotion) VALUES (?, ?, ?, ?)",
            (user_id, role, content, emotion),
        )


def recent_messages(user_id: str, limit: int = 30) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT role, content, emotion, created_at FROM messages "
            "WHERE user_id = ? ORDER BY id DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def messages_on(user_id: str, day: date) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT role, content FROM messages "
            "WHERE user_id = ? AND date(created_at) = ? ORDER BY id",
            (user_id, day.isoformat()),
        ).fetchall()
    return [dict(r) for r in rows]


def user_message_count(user_id: str) -> int:
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND role = 'user'",
            (user_id,),
        ).fetchone()
    return int(row["n"])


def messages_to_summarize(
    user_id: str, after_id: int, keep_recent: int
) -> list[dict]:
    """要約対象メッセージ = 直近 keep_recent 件(逐語でLLMに渡す窓)より古く、
    かつ未要約(id > after_id)のもの。古い順(id 昇順)で返す。"""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, role, content FROM messages "
            "WHERE user_id = ? AND id > ? AND id < ("
            "  SELECT MIN(id) FROM ("
            "    SELECT id FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?"
            "  )"
            ") ORDER BY id ASC",
            (user_id, after_id, user_id, keep_recent),
        ).fetchall()
    return [dict(r) for r in rows]


# --- 会話要約(逐語の窓から溢れた古い会話の圧縮ストア) ---

def get_summary(user_id: str) -> str:
    return get_kv(user_id, "conversation_summary", "") or ""


def get_summary_through_id(user_id: str) -> int:
    return int(get_kv(user_id, "summary_through_id", "0") or 0)


def set_summary(user_id: str, summary: str, through_id: int) -> None:
    set_kv(user_id, "conversation_summary", summary)
    set_kv(user_id, "summary_through_id", str(through_id))


# --- facts ---

def add_fact(user_id: str, content: str) -> None:
    content = content.strip()
    if not content:
        return
    with _connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO facts (user_id, content) VALUES (?, ?)",
            (user_id, content),
        )


def list_facts(user_id: str, limit: int = 20) -> list[str]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT content FROM facts WHERE user_id = ? ORDER BY id DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return [r["content"] for r in rows]


# --- diary ---

def add_diary(user_id: str, entry_date: date, content: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO diary (user_id, entry_date, content) VALUES (?, ?, ?) "
            "ON CONFLICT(user_id, entry_date) DO UPDATE SET content = excluded.content",
            (user_id, entry_date.isoformat(), content),
        )


def list_diary(user_id: str, limit: int = 30) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT entry_date, content FROM diary "
            "WHERE user_id = ? ORDER BY entry_date DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def has_diary(user_id: str, entry_date: date) -> bool:
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM diary WHERE user_id = ? AND entry_date = ?",
            (user_id, entry_date.isoformat()),
        ).fetchone()
    return row is not None


def touch_last_seen(user_id: str) -> str | None:
    """前回の最終アクセス時刻を返しつつ、現在時刻で更新する。"""
    previous = get_kv(user_id, "last_seen")
    set_kv(user_id, "last_seen", datetime.now().isoformat(timespec="seconds"))
    return previous
