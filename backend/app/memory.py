"""記憶ストア — SQLAlchemy Core によるユーザー分離データ層。

`DATABASE_URL`(Postgres / Neon 等)があればそれを、無ければローカル SQLite を使う。
すべてのデータは user_id でスコープされる。Phase A の旧シングルユーザー SQLite は
init_db 時に user_id='local' へ自動移行する(SQLite のみ)。

テーブル: messages / facts / diary / kv / users(認証=Phase C)
"""

from __future__ import annotations

import os
import sqlite3
from datetime import date, datetime
from pathlib import Path

from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    and_,
    create_engine,
    func,
    insert,
    select,
    update,
)
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "aikata.db"
LEGACY_USER_ID = "local"

metadata = MetaData()

messages = Table(
    "messages", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("user_id", String(64), nullable=False, index=True),
    Column("role", String(16), nullable=False),
    Column("content", Text, nullable=False),
    Column("emotion", String(16)),
    Column("created_at", DateTime(timezone=True), server_default=func.now()),
)

facts = Table(
    "facts", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("user_id", String(64), nullable=False, index=True),
    Column("content", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), server_default=func.now()),
    UniqueConstraint("user_id", "content", name="uq_facts_user_content"),
)

diary = Table(
    "diary", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("user_id", String(64), nullable=False, index=True),
    Column("entry_date", String(10), nullable=False),
    Column("content", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), server_default=func.now()),
    UniqueConstraint("user_id", "entry_date", name="uq_diary_user_date"),
)

kv = Table(
    "kv", metadata,
    Column("user_id", String(64), primary_key=True),
    Column("key", String(64), primary_key=True),
    Column("value", Text, nullable=False),
)

# レート制限カウンタ(Phase D)。scope 例: "user:<id>" / "global" / "login:<ip>"
usage = Table(
    "usage", metadata,
    Column("scope", String(128), primary_key=True),
    Column("day", String(10), primary_key=True),
    Column("count", Integer, nullable=False),
)

# 認証(Phase C)。user_id はこの users.id(文字列)を指す。
users = Table(
    "users", metadata,
    Column("id", String(64), primary_key=True),
    Column("email", String(255), nullable=False, unique=True),
    Column("password_hash", String(255), nullable=False),
    Column("created_at", DateTime(timezone=True), server_default=func.now()),
)

_engine: Engine | None = None


def _url() -> str:
    raw = os.environ.get("DATABASE_URL", "").strip()
    if raw:
        # Neon/Heroku 形式を SQLAlchemy + psycopg(v3) ドライバに正規化
        if raw.startswith("postgres://"):
            raw = "postgresql+psycopg://" + raw[len("postgres://"):]
        elif raw.startswith("postgresql://"):
            raw = "postgresql+psycopg://" + raw[len("postgresql://"):]
        return raw
    return f"sqlite:///{DB_PATH}"


def _is_sqlite() -> bool:
    return _url().startswith("sqlite")


def _get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = create_engine(_url(), future=True, pool_pre_ping=True)
    return _engine


def _reset_engine() -> None:
    global _engine
    if _engine is not None:
        _engine.dispose()
    _engine = None


# --- 旧シングルユーザー SQLite の移行(SQLite のみ) ---

def _legacy_rename() -> bool:
    """旧スキーマ(user_id 無し)を検出したら *_old へ退避し True を返す。"""
    if not _is_sqlite() or not DB_PATH.exists():
        return False
    conn = sqlite3.connect(DB_PATH)
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(messages)").fetchall()]
        if not cols or "user_id" in cols:
            return False
        conn.executescript(
            "ALTER TABLE messages RENAME TO messages_old;"
            "ALTER TABLE facts RENAME TO facts_old;"
            "ALTER TABLE diary RENAME TO diary_old;"
            "ALTER TABLE kv RENAME TO kv_old;"
        )
        conn.commit()
        return True
    finally:
        conn.close()


def _legacy_copy() -> None:
    """退避した *_old から新テーブルへ user_id='local' で移送し、*_old を削除。"""
    conn = sqlite3.connect(DB_PATH)
    try:
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
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    _reset_engine()
    if _is_sqlite():
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    renamed = _legacy_rename()
    metadata.create_all(_get_engine())
    if renamed:
        _legacy_copy()


# --- kv ---

def get_kv(user_id: str, key: str, default: str | None = None) -> str | None:
    with _get_engine().connect() as c:
        row = c.execute(
            select(kv.c.value).where(and_(kv.c.user_id == user_id, kv.c.key == key))
        ).first()
    return row[0] if row else default


def set_kv(user_id: str, key: str, value: str) -> None:
    with _get_engine().begin() as c:
        res = c.execute(
            update(kv).where(and_(kv.c.user_id == user_id, kv.c.key == key)).values(value=value)
        )
        if res.rowcount == 0:
            c.execute(insert(kv).values(user_id=user_id, key=key, value=value))


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
    with _get_engine().begin() as c:
        c.execute(
            insert(messages).values(
                user_id=user_id, role=role, content=content, emotion=emotion
            )
        )


def recent_messages(user_id: str, limit: int = 30) -> list[dict]:
    with _get_engine().connect() as c:
        rows = c.execute(
            select(messages.c.role, messages.c.content, messages.c.emotion, messages.c.created_at)
            .where(messages.c.user_id == user_id)
            .order_by(messages.c.id.desc())
            .limit(limit)
        ).mappings().all()
    return [dict(r) for r in reversed(rows)]


def messages_on(user_id: str, day: date) -> list[dict]:
    # SQLite の CAST(datetime AS DATE) は年整数を返すため func.date() を使う。
    # PostgreSQL でも date(timestamp) は正しく動作する(両ドライバ共通の安全策)。
    with _get_engine().connect() as c:
        rows = c.execute(
            select(messages.c.role, messages.c.content)
            .where(and_(messages.c.user_id == user_id, func.date(messages.c.created_at) == day))
            .order_by(messages.c.id)
        ).mappings().all()
    return [dict(r) for r in rows]


def user_message_count(user_id: str) -> int:
    with _get_engine().connect() as c:
        n = c.execute(
            select(func.count())
            .select_from(messages)
            .where(and_(messages.c.user_id == user_id, messages.c.role == "user"))
        ).scalar_one()
    return int(n)


def messages_to_summarize(
    user_id: str, after_id: int, keep_recent: int
) -> list[dict]:
    """要約対象 = 直近 keep_recent 件(逐語の窓)より古く、かつ未要約(id > after_id)のもの。"""
    recent = (
        select(messages.c.id)
        .where(messages.c.user_id == user_id)
        .order_by(messages.c.id.desc())
        .limit(keep_recent)
        .subquery()
    )
    min_recent = select(func.min(recent.c.id)).scalar_subquery()
    with _get_engine().connect() as c:
        rows = c.execute(
            select(messages.c.id, messages.c.role, messages.c.content)
            .where(
                and_(
                    messages.c.user_id == user_id,
                    messages.c.id > after_id,
                    messages.c.id < min_recent,
                )
            )
            .order_by(messages.c.id.asc())
        ).mappings().all()
    return [dict(r) for r in rows]


# --- 会話要約 ---

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
    try:
        with _get_engine().begin() as c:
            c.execute(insert(facts).values(user_id=user_id, content=content))
    except IntegrityError:
        pass  # (user_id, content) 重複は無視


def list_facts(user_id: str, limit: int = 20) -> list[str]:
    with _get_engine().connect() as c:
        rows = c.execute(
            select(facts.c.content)
            .where(facts.c.user_id == user_id)
            .order_by(facts.c.id.desc())
            .limit(limit)
        ).all()
    return [r[0] for r in rows]


# --- diary ---

def add_diary(user_id: str, entry_date: date, content: str) -> None:
    iso = entry_date.isoformat()
    with _get_engine().begin() as c:
        res = c.execute(
            update(diary)
            .where(and_(diary.c.user_id == user_id, diary.c.entry_date == iso))
            .values(content=content)
        )
        if res.rowcount == 0:
            c.execute(insert(diary).values(user_id=user_id, entry_date=iso, content=content))


def list_diary(user_id: str, limit: int = 30) -> list[dict]:
    with _get_engine().connect() as c:
        rows = c.execute(
            select(diary.c.entry_date, diary.c.content)
            .where(diary.c.user_id == user_id)
            .order_by(diary.c.entry_date.desc())
            .limit(limit)
        ).mappings().all()
    return [dict(r) for r in rows]


def has_diary(user_id: str, entry_date: date) -> bool:
    with _get_engine().connect() as c:
        row = c.execute(
            select(diary.c.id).where(
                and_(diary.c.user_id == user_id, diary.c.entry_date == entry_date.isoformat())
            )
        ).first()
    return row is not None


def touch_last_seen(user_id: str) -> str | None:
    previous = get_kv(user_id, "last_seen")
    set_kv(user_id, "last_seen", datetime.now().isoformat(timespec="seconds"))
    return previous


# --- users(認証=Phase C) ---

def create_user(user_id: str, email: str, password_hash: str) -> None:
    with _get_engine().begin() as c:
        c.execute(
            insert(users).values(id=user_id, email=email, password_hash=password_hash)
        )


def get_user_by_email(email: str) -> dict | None:
    with _get_engine().connect() as c:
        row = c.execute(select(users).where(users.c.email == email)).mappings().first()
    return dict(row) if row else None


def get_user_by_id(user_id: str) -> dict | None:
    with _get_engine().connect() as c:
        row = c.execute(select(users).where(users.c.id == user_id)).mappings().first()
    return dict(row) if row else None


def bump_usage(scope: str, day: str) -> int:
    """(scope, day) のカウンタを +1 して新しい値を返す(レート制限用)。

    H6: 旧実装は「UPDATE→rowcount==0 なら INSERT→IntegrityError で再UPDATE」で、
    Postgres 複本並行で INSERT 同士がぶつかると 1 目盛取りこぼす競合窓があった。
    SQLite/Postgres 共通の INSERT ... ON CONFLICT (scope, day) DO UPDATE でアトミックに
    インクリメントし RETURNING で結果を取る。
    """
    url = _url()
    stmt = (
        sqlite.insert(usage)
        if url.startswith("sqlite")
        else postgresql.insert(usage)
    )
    stmt = stmt.values(scope=scope, day=day, count=1)
    stmt = stmt.on_conflict_do_update(
        index_elements=[usage.c.scope, usage.c.day],
        set_={"count": usage.c.count + 1},
    )
    # SQLAlchemy 2.x の Insert.on_conflict_do_update は RETURNING を生やす。
    # RETURNING は SQLite 3.35+/Postgres 両対応なので採用する。
    stmt = stmt.returning(usage.c.count)
    with _get_engine().begin() as c:
        row = c.execute(stmt).first()
    # 初回 INSERT なら 1、衝突 UPDATE なら count+1 が RETURNING で返る
    # (SQLite 3.35+ / Postgres 共に対応)。
    return int(row[0])


def reassign_user_data(from_user_id: str, to_user_id: str) -> None:
    """匿名Cookieユーザーのデータをログイン後アカウントへ引き継ぐ(Phase C)。

    Worker側 db.ts と対象テーブル集合を揃える(研究コード撤去で research_events は除外済み)。
    """
    with _get_engine().begin() as c:
        for tbl in (messages, facts, diary, kv):
            c.execute(
                update(tbl)
                .where(tbl.c.user_id == from_user_id)
                .values(user_id=to_user_id)
            )
