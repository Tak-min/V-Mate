"""会話の要約圧縮(ローリング要約バッファ)のテスト。

検証対象:
- memory.messages_to_summarize の窓・after_id 境界
- 要約ストアの往復
- persona.build_system_prompt への要約注入(有無)
- main._summarize_old_history の閾値スキップ / 畳み込み(LLM はモック)
"""

import pytest

from app import main, memory, persona


def _seed(n: int) -> None:
    for i in range(n):
        role = "user" if i % 2 == 0 else "assistant"
        memory.add_message(role, f"msg{i}")


# --- memory.messages_to_summarize ---

def test_excludes_recent_window(db):
    _seed(30)
    pending = memory.messages_to_summarize(0, keep_recent=24)
    assert len(pending) == 6  # 30 - 24
    ids = [m["id"] for m in pending]
    assert ids == sorted(ids)  # 古い順
    assert ids[0] == 1


def test_empty_when_below_window(db):
    _seed(10)
    assert memory.messages_to_summarize(0, keep_recent=24) == []


def test_empty_when_exactly_window(db):
    _seed(24)
    assert memory.messages_to_summarize(0, keep_recent=24) == []


def test_respects_after_id(db):
    _seed(30)
    pending = memory.messages_to_summarize(after_id=3, keep_recent=24)
    assert [m["id"] for m in pending] == [4, 5, 6]


# --- summary store ---

def test_summary_roundtrip(db):
    assert memory.get_summary() == ""
    assert memory.get_summary_through_id() == 0
    memory.set_summary("二人で旅行の話をした", 12)
    assert memory.get_summary() == "二人で旅行の話をした"
    assert memory.get_summary_through_id() == 12


# --- persona ---

def test_prompt_includes_summary(db):
    p = persona.build_system_prompt(None, 0, [], "now", summary="旅行の話をした")
    assert "これまでの会話の流れ" in p
    assert "旅行の話をした" in p


def test_prompt_omits_empty_summary(db):
    p = persona.build_system_prompt(None, 0, [], "now", summary="   ")
    assert "これまでの会話の流れ" not in p


# --- main._summarize_old_history (LLM をモック) ---

async def test_skips_below_threshold(db, monkeypatch):
    monkeypatch.setattr(main, "HISTORY_WINDOW", 2)
    monkeypatch.setattr(main, "SUMMARY_CHUNK", 4)
    _seed(4)  # window=2 → pending=2 < chunk=4 → スキップ

    called = False

    async def fake_complete(prompt: str) -> str:
        nonlocal called
        called = True
        return "x"

    monkeypatch.setattr(main.llm, "complete", fake_complete)
    await main._summarize_old_history()

    assert called is False  # LLM は呼ばれない
    assert memory.get_summary() == ""
    assert memory.get_summary_through_id() == 0


async def test_folds_when_threshold_met(db, monkeypatch):
    monkeypatch.setattr(main, "HISTORY_WINDOW", 2)
    monkeypatch.setattr(main, "SUMMARY_CHUNK", 4)
    _seed(8)  # window=2 → pending=ids1..6 (6件) ≥ chunk=4 → 畳み込み

    async def fake_complete(prompt: str) -> str:
        assert "msg0" in prompt  # 古い会話がプロンプトに渡る
        return "[happy] 二人は少しずつ仲良くなった"  # 感情タグが混ざる想定

    monkeypatch.setattr(main.llm, "complete", fake_complete)
    await main._summarize_old_history()

    summary = memory.get_summary()
    assert "二人は少しずつ仲良くなった" in summary
    assert "[happy]" not in summary  # _strip_emotion で除去される
    assert memory.get_summary_through_id() == 6  # pending 末尾の id まで前進


async def test_existing_summary_passed_into_prompt(db, monkeypatch):
    monkeypatch.setattr(main, "HISTORY_WINDOW", 2)
    monkeypatch.setattr(main, "SUMMARY_CHUNK", 4)
    memory.set_summary("以前: 試験勉強を頑張っていた", 0)
    _seed(8)

    seen = {}

    async def fake_complete(prompt: str) -> str:
        seen["prompt"] = prompt
        return "更新後の要約"

    monkeypatch.setattr(main.llm, "complete", fake_complete)
    await main._summarize_old_history()

    assert "試験勉強を頑張っていた" in seen["prompt"]  # 旧要約を統合に使う
    assert memory.get_summary() == "更新後の要約"


async def test_llm_failure_does_not_advance(db, monkeypatch):
    monkeypatch.setattr(main, "HISTORY_WINDOW", 2)
    monkeypatch.setattr(main, "SUMMARY_CHUNK", 4)
    _seed(8)

    async def boom(prompt: str) -> str:
        raise RuntimeError("LLM down")

    monkeypatch.setattr(main.llm, "complete", boom)
    await main._summarize_old_history()  # 例外は内部で握りつぶす

    assert memory.get_summary() == ""
    assert memory.get_summary_through_id() == 0  # 次回再試行できるよう据え置き
