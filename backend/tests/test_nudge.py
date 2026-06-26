"""nudge エンドポイント(/api/nudge)のテスト。

idle 声かけ・greeting 挨拶・短間隔スキップ・days_away 返却・LLM 失敗時の挙動を保証する。
"""

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import main, memory


def _client() -> TestClient:
    return TestClient(main.app)


# --- idle nudge ---

def test_idle_nudge_returns_text_and_emotion(db, monkeypatch):
    async def fake_complete(prompt: str) -> str:
        return "[happy] 元気にしてる?"

    monkeypatch.setattr(main.llm, "complete", fake_complete)
    c = _client()
    r = c.post("/api/nudge", json={"reason": "idle"})
    assert r.status_code == 200
    data = r.json()
    assert data["emotion"] == "happy"
    assert "元気にしてる" in data["text"]
    assert "[happy]" not in data["text"]


def test_idle_nudge_llm_failure_returns_empty(db, monkeypatch):
    async def fail(*_):
        raise RuntimeError("LLM unavailable")

    monkeypatch.setattr(main.llm, "complete", fail)
    c = _client()
    r = c.post("/api/nudge", json={"reason": "idle"})
    assert r.status_code == 200
    data = r.json()
    assert data["text"] == ""
    assert data["emotion"] == "neutral"


# --- greeting nudge ---

def test_greeting_first_time_returns_text(db, monkeypatch):
    async def fake_complete(prompt: str) -> str:
        return "[happy] はじめまして!"

    monkeypatch.setattr(main.llm, "complete", fake_complete)
    c = _client()
    r = c.post("/api/nudge", json={"reason": "greeting"})
    assert r.status_code == 200
    data = r.json()
    assert data["text"] != ""
    assert data["days_away"] is None  # 初回は last_seen なし


def test_greeting_skipped_when_too_recent(db, monkeypatch):
    """GREETING_MIN_GAP_SECONDS 未満なら LLM を叩かずに空返却する。"""
    uid = "test-skip-uid"
    memory.set_kv(uid, "last_seen", datetime.now().isoformat())

    called = []

    async def fake_complete(prompt: str) -> str:
        called.append(prompt)
        return "[happy] やあ"

    monkeypatch.setattr(main.llm, "complete", fake_complete)
    # uid を強制的にセット(Cookieを使わない簡易テスト)
    monkeypatch.setattr(main, "_resolve_uid", lambda _req: uid)

    c = _client()
    r = c.post("/api/nudge", json={"reason": "greeting"})
    assert r.status_code == 200
    data = r.json()
    assert data["text"] == ""
    assert not called  # LLM は呼ばれない


def test_greeting_returns_days_away_when_long_absence(db, monkeypatch):
    """2日以上ぶりの場合は days_away に日数が入る。"""
    uid = "test-days-uid"
    three_days_ago = (datetime.now() - timedelta(days=3)).isoformat()
    memory.set_kv(uid, "last_seen", three_days_ago)

    async def fake_complete(prompt: str) -> str:
        return "[relaxed] おかえり!"

    monkeypatch.setattr(main.llm, "complete", fake_complete)
    monkeypatch.setattr(main, "_resolve_uid", lambda _req: uid)

    c = _client()
    r = c.post("/api/nudge", json={"reason": "greeting"})
    assert r.status_code == 200
    data = r.json()
    assert data["days_away"] == 3


def test_greeting_does_not_return_days_away_when_same_day(db, monkeypatch):
    """同日のアクセスでは days_away は None。"""
    uid = "test-sameday-uid"
    recent = (datetime.now() - timedelta(hours=5)).isoformat()
    memory.set_kv(uid, "last_seen", recent)

    monkeypatch.setattr(main, "GREETING_MIN_GAP_SECONDS", 0)

    async def fake_complete(prompt: str) -> str:
        return "[neutral] やあ"

    monkeypatch.setattr(main.llm, "complete", fake_complete)
    monkeypatch.setattr(main, "_resolve_uid", lambda _req: uid)

    c = _client()
    r = c.post("/api/nudge", json={"reason": "greeting"})
    assert r.status_code == 200
    data = r.json()
    assert data["days_away"] is None


def test_nudge_stores_message_in_history(db, monkeypatch):
    """nudge の応答はメッセージ履歴に記録される。"""
    uid = "test-store-uid"

    async def fake_complete(prompt: str) -> str:
        return "[happy] 元気だよ!"

    monkeypatch.setattr(main.llm, "complete", fake_complete)
    monkeypatch.setattr(main, "_resolve_uid", lambda _req: uid)

    c = _client()
    c.post("/api/nudge", json={"reason": "idle"})
    msgs = memory.recent_messages(uid, 10)
    assert any(m["role"] == "assistant" and "元気だよ" in m["content"] for m in msgs)
