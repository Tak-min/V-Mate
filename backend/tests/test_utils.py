"""main.py の純粋ユーティリティ関数(_strip_emotion / _sanitize_fourth_wall)のテスト。

_message_metrics は研究コード(C2)撤去で main.py から削除されたため、対応するテストも除去済み。
"""

import pytest

from app.main import _sanitize_fourth_wall, _strip_emotion


# --- _strip_emotion ---

def test_strip_emotion_extracts_known_emotion():
    emotion, text = _strip_emotion("[happy] 元気だよ!")
    assert emotion == "happy"
    assert text == "元気だよ!"


def test_strip_emotion_defaults_to_neutral_when_no_tag():
    emotion, text = _strip_emotion("こんにちは")
    assert emotion == "neutral"
    assert text == "こんにちは"


def test_strip_emotion_removes_all_tags_in_text():
    """タグが複数あっても全部除去する。"""
    emotion, text = _strip_emotion("[sad] つらいな[happy]でも大丈夫")
    assert emotion == "sad"
    assert "[" not in text


def test_strip_emotion_with_empty_string():
    emotion, text = _strip_emotion("")
    assert emotion == "neutral"
    assert text == ""


def test_strip_emotion_trims_whitespace():
    emotion, text = _strip_emotion("[relaxed]  ゆっくりしてね  ")
    assert emotion == "relaxed"
    assert text == "ゆっくりしてね"


# --- _sanitize_fourth_wall ---

def test_sanitize_removes_user_reference():
    result = _sanitize_fourth_wall("ユーザーさんは元気ですか?")
    assert "ユーザー" not in result
    assert "元気ですか" in result


def test_sanitize_removes_user_with_particle():
    result = _sanitize_fourth_wall("ユーザーの気持ちが大切。")
    assert "ユーザー" not in result
    assert "気持ちが大切" in result


def test_sanitize_leaves_clean_text_unchanged():
    text = "今日も頑張ってるね。"
    assert _sanitize_fourth_wall(text) == text


def test_sanitize_user_without_san():
    result = _sanitize_fourth_wall("ユーザーはどう思う?")
    assert "ユーザー" not in result