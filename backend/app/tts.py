"""音声合成 — Aivis Cloud API (AivisSpeech) を使用する。

ElevenLabs から移行済み(2026-06-19)。AIVIS_API_KEY が未設定、または合成に
失敗した場合は None を返し、フロントエンドは無音(テキストのみ)で処理を続行する。
返す音声は MP3(audio/mpeg)。
"""

from __future__ import annotations

import os

import httpx

AIVIS_API_KEY = os.environ.get("AIVIS_API_KEY", "")
# 既定は Claude Code 通知でも使っている動作確認済みモデル。環境変数で差し替え可能。
AIVIS_MODEL_UUID = os.environ.get("AIVIS_MODEL_UUID", "a59cb814-0083-4369-8542-f51a29e72af7")
AIVIS_SPEAKER_UUID = os.environ.get("AIVIS_SPEAKER_UUID", "")
AIVIS_STYLE_NAME = os.environ.get("AIVIS_STYLE_NAME", "")
AIVIS_BASE = "https://api.aivis-project.com/v1"
REQUEST_TIMEOUT = 30

# llm.py と同じ理由(毎ターンのTLSハンドシェイクを避ける)でクライアントを共有する。
# TTSはLLMと異なるタイムアウト(30s)を持つため、クライアントは別インスタンスにし、
# 各リクエストでも明示的に REQUEST_TIMEOUT を渡して挙動を変えない。
_client: httpx.AsyncClient | None = None
_fallback_client: httpx.AsyncClient | None = None


def set_client(client: httpx.AsyncClient | None) -> None:
    """アプリのlifespanから呼ぶ。注入したクライアントのクローズもlifespan側の責務。"""
    global _client
    _client = client


def _get_client() -> httpx.AsyncClient:
    global _fallback_client
    if _client is not None:
        return _client
    if _fallback_client is None:
        _fallback_client = httpx.AsyncClient(timeout=REQUEST_TIMEOUT)
    return _fallback_client

# 感情ごとの声の表情づけ。ElevenLabs版の stability/style と同じ目的で、
# speaking_rate(話速)・emotional_intensity(感情表現の強さ)・volume(音量)を
# 感情別に変える。全感情で同じ抑揚になり「人間味が薄い」と感じられる問題への対策。
_DEFAULT_SETTINGS = {"speaking_rate": 1.0, "emotional_intensity": 1.0, "volume": 1.0}
_EMOTION_VOICE_SETTINGS: dict[str, dict[str, float]] = {
    "happy": {"speaking_rate": 1.08, "emotional_intensity": 1.4, "volume": 1.1},
    "sad": {"speaking_rate": 0.92, "emotional_intensity": 0.7, "volume": 0.9},
    "angry": {"speaking_rate": 1.05, "emotional_intensity": 1.5, "volume": 1.15},
    "relaxed": {"speaking_rate": 0.95, "emotional_intensity": 0.9, "volume": 1.0},
    "shy": {"speaking_rate": 0.95, "emotional_intensity": 0.8, "volume": 0.9},
    "neutral": _DEFAULT_SETTINGS,
}


async def synthesize(text: str, emotion: str | None = None) -> bytes | None:
    """テキストを MP3 に合成する。キー未設定・失敗時は None。

    emotion: シロの感情タグ。指定があれば声の抑揚(speaking_rate/emotional_intensity/volume)
    をそれに合わせる。
    """
    if not AIVIS_API_KEY or not text.strip():
        return None
    url = f"{AIVIS_BASE}/tts/synthesize"
    voice_settings = _EMOTION_VOICE_SETTINGS.get(emotion or "neutral", _DEFAULT_SETTINGS)
    payload: dict[str, object] = {
        "model_uuid": AIVIS_MODEL_UUID,
        "text": text,
        "output_format": "mp3",
        # Aivisは先頭に既定で0.1秒の無音を付ける(leading_silence_seconds=0.1)。会話の
        # 即応性(没入感)を上げるため、応答の発話冒頭の無音をゼロにして体感レイテンシを削る。
        "leading_silence_seconds": 0.0,
        **voice_settings,
    }
    if AIVIS_SPEAKER_UUID:
        payload["speaker_uuid"] = AIVIS_SPEAKER_UUID
    if AIVIS_STYLE_NAME:
        payload["style_name"] = AIVIS_STYLE_NAME
    headers = {
        "Authorization": f"Bearer {AIVIS_API_KEY}",
        "Content-Type": "application/json",
    }
    try:
        client = _get_client()
        response = await client.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        return response.content
    except (httpx.HTTPError, OSError):
        return None
