"""main.py の純粋ユーティリティ関数(_strip_emotion / _sanitize_fourth_wall / _message_metrics)のテスト。"""

import pytest

from app.main import _message_metrics, _sanitize_fourth_wall, _strip_emotion


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


# --- _message_metrics ---

def test_message_metrics_basic_counts():
    m = _message_metrics("こんにちは! 今日はどう? 元気?")
    assert m["char_count"] > 0
    assert m["question_count"] == 2  # "?" が2つ


def test_message_metrics_counts_fullwidth_question():
    m = _message_metrics("どうしたの？ 大丈夫？")
    assert m["question_count"] == 2


def test_message_metrics_detects_self_disclosure():
    m = _message_metrics("最近すごく不安で…")
    assert m["contains_sensitive_self_disclosure"] is True


def test_message_metrics_no_self_disclosure_in_neutral_text():
    m = _message_metrics("今日は晴れですね。")
    assert m["contains_sensitive_self_disclosure"] is False


def test_message_metrics_empty_text():
    m = _message_metrics("   ")
    assert m["char_count"] == 0
    assert m["line_count"] == 0
    assert m["question_count"] == 0
    assert m["contains_sensitive_self_disclosure"] is False


def test_message_metrics_multiline():
    m = _message_metrics("1行目\n2行目\n3行目")
    assert m["line_count"] == 3
