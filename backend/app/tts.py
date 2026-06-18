"""音声合成 — クラウドの ElevenLabs API を使用する。

ローカルの AivisSpeech / ブラウザ読み上げは撤去済み。
ELEVENLABS_API_KEY が未設定、または合成に失敗した場合は None を返し、
フロントエンドは無音(テキストのみ)で処理を続行する。
返す音声は MP3(audio/mpeg)。
"""

from __future__ import annotations

import os

import httpx

ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
# 既定は多言語対応の女声 "Sarah"。環境変数で差し替え可能。
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_multilingual_v2")
ELEVENLABS_BASE = "https://api.elevenlabs.io/v1"
REQUEST_TIMEOUT = 30

# 感情ごとの声の表情づけ。固定の voice_settings だと全感情が同じ抑揚になり
# 「人間味が薄い」と感じられる原因になっていたため、stability(低いほど抑揚が動く)と
# style(高いほど誇張される、eleven_multilingual_v2 が対応)を感情別に変える。
_DEFAULT_SETTINGS = {"stability": 0.4, "similarity_boost": 0.8, "style": 0.2}
_EMOTION_VOICE_SETTINGS: dict[str, dict[str, float]] = {
    "happy": {"stability": 0.28, "similarity_boost": 0.8, "style": 0.55},
    "sad": {"stability": 0.55, "similarity_boost": 0.85, "style": 0.1},
    "angry": {"stability": 0.3, "similarity_boost": 0.75, "style": 0.5},
    "relaxed": {"stability": 0.5, "similarity_boost": 0.8, "style": 0.15},
    "shy": {"stability": 0.5, "similarity_boost": 0.85, "style": 0.1},
    "neutral": _DEFAULT_SETTINGS,
}


async def synthesize(text: str, emotion: str | None = None) -> bytes | None:
    """テキストを MP3 に合成する。キー未設定・失敗時は None。

    emotion: シロの感情タグ。指定があれば声の抑揚(stability/style)をそれに合わせる。
    """
    if not ELEVENLABS_API_KEY or not text.strip():
        return None
    url = f"{ELEVENLABS_BASE}/text-to-speech/{ELEVENLABS_VOICE_ID}"
    voice_settings = _EMOTION_VOICE_SETTINGS.get(emotion or "neutral", _DEFAULT_SETTINGS)
    payload = {
        "text": text,
        "model_id": ELEVENLABS_MODEL,
        "voice_settings": voice_settings,
    }
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "accept": "audio/mpeg",
        "content-type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            return response.content
    except (httpx.HTTPError, OSError):
        return None
