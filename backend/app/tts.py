"""AivisSpeech Engine (VOICEVOX 互換 API) への TTS プロキシ。

エンジンが起動していなければ None を返し、フロントエンドは
Web Speech API (speechSynthesis) にフォールバックする。
"""

from __future__ import annotations

import os

import httpx

AIVIS_URL = os.environ.get("AIVIS_URL", "http://127.0.0.1:10101")
# AivisSpeech デフォルトキャラ (Anneli ノーマル)。環境変数で差し替え可能。
AIVIS_SPEAKER = int(os.environ.get("AIVIS_SPEAKER", "888753760"))


async def synthesize(text: str) -> bytes | None:
    """テキストを WAV に合成する。エンジン未起動なら None。"""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            query = await client.post(
                f"{AIVIS_URL}/audio_query",
                params={"text": text, "speaker": AIVIS_SPEAKER},
            )
            query.raise_for_status()
            audio = await client.post(
                f"{AIVIS_URL}/synthesis",
                params={"speaker": AIVIS_SPEAKER},
                json=query.json(),
            )
            audio.raise_for_status()
            return audio.content
    except (httpx.HTTPError, OSError):
        return None
