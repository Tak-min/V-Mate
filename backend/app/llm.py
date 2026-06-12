"""LLM クライアント。Gemini(クラウド)と Ollama(ローカル)を切り替える。

優先順位: AIKATA_PROVIDER 環境変数 > GEMINI_API_KEY があれば gemini > ollama
ローカル(Ollama + qwen3)だけで完結できるため、APIキー無しでも動く。
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator

import httpx

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:8b")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
TEMPERATURE = 0.85


def provider() -> str:
    forced = os.environ.get("AIKATA_PROVIDER", "auto").lower()
    if forced in ("ollama", "gemini"):
        return forced
    return "gemini" if GEMINI_API_KEY else "ollama"


class ThinkFilter:
    """qwen3 等が出力する <think>...</think> ブロックをストリームから除去する。"""

    def __init__(self) -> None:
        self._buffer = ""
        self._in_think = False

    def feed(self, chunk: str) -> str:
        self._buffer += chunk
        out: list[str] = []
        while self._buffer:
            if self._in_think:
                end = self._buffer.find("</think>")
                if end == -1:
                    self._buffer = self._buffer[-8:]  # タグ跨ぎ分だけ保持
                    break
                self._buffer = self._buffer[end + len("</think>"):]
                self._in_think = False
            else:
                start = self._buffer.find("<think>")
                if start == -1:
                    # タグの先頭部分かもしれない末尾は持ち越す
                    safe = len(self._buffer) - 7
                    if safe > 0:
                        out.append(self._buffer[:safe])
                        self._buffer = self._buffer[safe:]
                    break
                out.append(self._buffer[:start])
                self._buffer = self._buffer[start + len("<think>"):]
                self._in_think = True
        return "".join(out)

    def flush(self) -> str:
        rest = "" if self._in_think else self._buffer
        self._buffer = ""
        return rest


async def stream_chat(
    system: str, messages: list[dict]
) -> AsyncIterator[str]:
    """messages: [{"role": "user"|"assistant", "content": str}, ...]"""
    if provider() == "gemini":
        async for chunk in _stream_gemini(system, messages):
            yield chunk
    else:
        async for chunk in _stream_ollama(system, messages):
            yield chunk


async def complete(prompt: str) -> str:
    """非ストリーミングの単発補完(事実抽出・日記・声かけ用)。"""
    parts: list[str] = []
    async for chunk in stream_chat("", [{"role": "user", "content": prompt}]):
        parts.append(chunk)
    return "".join(parts).strip()


async def _stream_ollama(
    system: str, messages: list[dict]
) -> AsyncIterator[str]:
    # qwen3 は think:false だけでは推論文が本文に混ざることがあるため、
    # ソフトスイッチ /no_think も併用する(他モデルには無害)
    system_with_switch = f"{system}\n/no_think" if "qwen3" in OLLAMA_MODEL else system
    payload = {
        "model": OLLAMA_MODEL,
        "stream": True,
        "think": False,
        "options": {"temperature": TEMPERATURE},
        "messages": (
            [{"role": "system", "content": system_with_switch}]
            if system_with_switch
            else []
        )
        + messages,
    }
    think_filter = ThinkFilter()
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream(
            "POST", f"{OLLAMA_URL}/api/chat", json=payload
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.strip():
                    continue
                data = json.loads(line)
                text = think_filter.feed(data.get("message", {}).get("content", ""))
                if text:
                    yield text
                if data.get("done"):
                    break
    tail = think_filter.flush()
    if tail:
        yield tail


async def _stream_gemini(
    system: str, messages: list[dict]
) -> AsyncIterator[str]:
    contents = [
        {
            "role": "model" if m["role"] == "assistant" else "user",
            "parts": [{"text": m["content"]}],
        }
        for m in messages
    ]
    payload: dict = {
        "contents": contents,
        "generationConfig": {"temperature": TEMPERATURE},
    }
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:streamGenerateContent?alt=sse"
    )
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream(
            "POST", url, json=payload, headers={"x-goog-api-key": GEMINI_API_KEY}
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = json.loads(line[len("data: "):])
                for candidate in data.get("candidates", []):
                    for part in candidate.get("content", {}).get("parts", []):
                        if part.get("text"):
                            yield part["text"]
