"""diary エンドポイント(/api/diary, /api/diary/generate)のテスト。"""

from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import main, memory


def _client() -> TestClient:
    return TestClient(main.app)


def test_diary_list_empty_on_first_visit(db):
    c = _client()
    r = c.get("/api/diary")
    assert r.status_code == 200
    data = r.json()
    assert data["entries"] == []
    assert data["can_generate_today"] is False  # 会話が少ない


def test_diary_cannot_generate_without_enough_messages(db, monkeypatch):
    uid = "test-diary-uid"
    monkeypatch.setattr(main, "_resolve_uid", lambda _req: uid)
    # 3件だけ(4件未満)→ 生成不可
    for i in range(3):
        memory.add_message(uid, "user" if i % 2 == 0 else "assistant", f"msg{i}")
    c = _client()
    r = c.post("/api/diary/generate")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert "reason" in data


def test_diary_generate_with_enough_messages(db, monkeypatch):
    uid = "test-diary-gen-uid"
    monkeypatch.setattr(main, "_resolve_uid", lambda _req: uid)

    async def fake_complete(prompt: str) -> str:
        return "今日は楽しかった。またあしたも話したい。"

    monkeypatch.setattr(main.llm, "complete", fake_complete)

    for i in range(4):
        memory.add_message(uid, "user" if i % 2 == 0 else "assistant", f"msg{i}")

    c = _client()
    r = c.post("/api/diary/generate")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "今日は楽しかった" in data["entry"]["content"]


def test_diary_generate_twice_in_one_day_is_idempotent(db, monkeypatch):
    """同日に2回 generate しても2件目は上書きされる(uq_diary_user_date 制約)。"""
    uid = "test-diary-dup-uid"
    monkeypatch.setattr(main, "_resolve_uid", lambda _req: uid)

    call_count = [0]

    async def fake_complete(prompt: str) -> str:
        call_count[0] += 1
        return f"日記エントリ{call_count[0]}"

    monkeypatch.setattr(main.llm, "complete", fake_complete)

    for i in range(4):
        memory.add_message(uid, "user" if i % 2 == 0 else "assistant", f"msg{i}")

    c = _client()
    c.post("/api/diary/generate")
    c.post("/api/diary/generate")

    entries = memory.list_diary(uid)
    assert len(entries) == 1  # 重複なし


def test_diary_list_shows_generated_entry(db, monkeypatch):
    uid = "test-diary-list-uid"
    monkeypatch.setattr(main, "_resolve_uid", lambda _req: uid)

    async def fake_complete(prompt: str) -> str:
        return "今日は充実していた。"

    monkeypatch.setattr(main.llm, "complete", fake_complete)
    for i in range(4):
        memory.add_message(uid, "user" if i % 2 == 0 else "assistant", f"msg{i}")

    c = _client()
    c.post("/api/diary/generate")
    r = c.get("/api/diary")
    assert r.status_code == 200
    data = r.json()
    assert len(data["entries"]) == 1
    assert "今日は充実していた" in data["entries"][0]["content"]
    assert data["can_generate_today"] is False  # 生成済み
