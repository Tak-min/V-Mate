"""SSEストリームの感情タグ早期フラッシュ(_could_still_be_tag_prefix)のテスト。

応答冒頭の感情タグが確定するまでトークン送出を止めない設計に変えたため、
「まだタグの途中かもしれない」判定そのものが正しいかをここで保証する。
"""

import json

from fastapi.testclient import TestClient

from app import main
from app.main import _could_still_be_tag_prefix


def test_empty_buffer_could_be_tag_prefix():
    assert _could_still_be_tag_prefix("") is True


def test_partial_leading_bracket_could_be_tag_prefix():
    assert _could_still_be_tag_prefix("[ha") is True
    assert _could_still_be_tag_prefix("[") is True


def test_full_tag_still_counts_as_prefix_until_consumed():
    # search()で先にマッチするため呼び出し側のelse分岐には来ないが、
    # 関数自体は「[happy]」も自分自身の接頭辞として真を返す。
    assert _could_still_be_tag_prefix("[happy]") is True


def test_no_leading_bracket_is_not_a_tag_prefix():
    assert _could_still_be_tag_prefix("こんにちは") is False


def test_bracket_with_non_matching_content_is_not_a_tag_prefix():
    assert _could_still_be_tag_prefix("[笑]") is False


def test_leading_whitespace_before_tag_is_ignored():
    assert _could_still_be_tag_prefix("  [ha") is True
    assert _could_still_be_tag_prefix("   ") is True


def test_chat_preserves_text_that_precedes_the_emotion_tag(db, monkeypatch):
    """ペルソナ指示はタグを冒頭に置く前提だが、モデルがそれを守らずタグの前に
    テキストを出すことがある。早期フラッシュ化の際、タグ前のテキストを誤って
    切り捨てない(buffer[match.end():]ではなくタグだけを除去する)ことを保証する。
    """
    async def fake_stream(*args, **kwargs):
        yield "やほー[happy]元気?"

    monkeypatch.setattr(main.llm, "stream_chat", fake_stream)

    c = TestClient(main.app)
    r = c.post("/api/chat", json={"message": "こんにちは"})
    tokens = []
    for line in r.iter_lines():
        if not line.startswith("data: "):
            continue
        payload = json.loads(line[len("data: "):])
        if payload.get("type") == "token":
            tokens.append(payload["text"])

    full_text = "".join(tokens)
    assert "やほー" in full_text
    assert "元気" in full_text
    assert "[happy]" not in full_text
