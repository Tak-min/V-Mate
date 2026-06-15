"""SQLite による長期記憶ストア。

messages: 会話履歴(全文)
facts:    ユーザーについて抽出した事実(システムプロンプトに注入)
diary:    シロが書く日記(Replika の Diary 相当)
kv:       親密度スコア・ユーザー名などの単一値
"""

from __future__ import annotations

import sqlite3
from datetime import date, datetime
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "aikata.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    emotion TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS diary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(_SCHEMA)


# --- kv ---

def get_kv(key: str, default: str | None = None) -> str | None:
    with _connect() as conn:
        row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_kv(key: str, value: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO kv (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def get_affinity() -> int:
    return int(get_kv("affinity", "0") or 0)


def add_affinity(delta: int) -> int:
    score = get_affinity() + delta
    set_kv("affinity", str(score))
    return score


# --- messages ---

def add_message(role: str, content: str, emotion: str | None = None) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO messages (role, content, emotion) VALUES (?, ?, ?)",
            (role, content, emotion),
        )


def recent_messages(limit: int = 30) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT role, content, emotion, created_at FROM messages "
            "ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def messages_on(day: date) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT role, content FROM messages "
            "WHERE date(created_at) = ? ORDER BY id",
            (day.isoformat(),),
        ).fetchall()
    return [dict(r) for r in rows]


def user_message_count() -> int:
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM messages WHERE role = 'user'"
        ).fetchone()
    return int(row["n"])


def messages_to_summarize(after_id: int, keep_recent: int) -> list[dict]:
    """要約対象メッセージ = 直近 keep_recent 件(逐語でLLMに渡す窓)より古く、
    かつ未要約(id > after_id)のもの。古い順(id 昇順)で返す。"""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, role, content FROM messages "
            "WHERE id > ? AND id < ("
            "  SELECT MIN(id) FROM (SELECT id FROM messages ORDER BY id DESC LIMIT ?)"
            ") ORDER BY id ASC",
            (after_id, keep_recent),
        ).fetchall()
    return [dict(r) for r in rows]


# --- 会話要約(逐語の窓から溢れた古い会話の圧縮ストア) ---

def get_summary() -> str:
    return get_kv("conversation_summary", "") or ""


def get_summary_through_id() -> int:
    return int(get_kv("summary_through_id", "0") or 0)


def set_summary(summary: str, through_id: int) -> None:
    set_kv("conversation_summary", summary)
    set_kv("summary_through_id", str(through_id))


# --- facts ---

def add_fact(content: str) -> None:
    content = content.strip()
    if not content:
        return
    with _connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO facts (content) VALUES (?)", (content,)
        )


def list_facts(limit: int = 20) -> list[str]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT content FROM facts ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [r["content"] for r in rows]


# --- diary ---

def add_diary(entry_date: date, content: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO diary (entry_date, content) VALUES (?, ?) "
            "ON CONFLICT(entry_date) DO UPDATE SET content = excluded.content",
            (entry_date.isoformat(), content),
        )


def list_diary(limit: int = 30) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT entry_date, content FROM diary ORDER BY entry_date DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def has_diary(entry_date: date) -> bool:
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM diary WHERE entry_date = ?", (entry_date.isoformat(),)
        ).fetchone()
    return row is not None


def touch_last_seen() -> str | None:
    """前回の最終アクセス時刻を返しつつ、現在時刻で更新する。"""
    previous = get_kv("last_seen")
    set_kv("last_seen", datetime.now().isoformat(timespec="seconds"))
    return previous
