"""LLM クライアント — OpenAI 互換 Chat Completions エンドポイントを使用する。

既定は Groq(無料枠・高速・OpenAI互換)。`LLM_BASE_URL` を差し替えるだけで
Cerebras / OpenRouter / ローカル互換サーバ等へ移行できる(ベンダーロックイン回避)。
返答生成はすべてクラウドのストリーミングに委ねる。`LLM_API_KEY` は必須。
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator

import httpx

# 既定 = Groq(https://console.groq.com で無料キー取得)。
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
# 日本語雑談向けは Qwen 系が強い。安定して存在する Llama 3.3 70B を既定に。
# 日本語重視なら .env で LLM_MODEL=qwen/qwen3-32b 等に変更可。
LLM_MODEL = os.environ.get("LLM_MODEL", "llama-3.3-70b-versatile")
# 後方互換: LLM_API_KEY が無ければ GROQ_API_KEY を見る。
LLM_API_KEY = os.environ.get("LLM_API_KEY") or os.environ.get("GROQ_API_KEY", "")
TEMPERATURE = 0.85
REQUEST_TIMEOUT = 120


def provider() -> str:
    """状態表示用。使用中のモデル名を返す。"""
    return LLM_MODEL


def _require_api_key() -> str:
    if not LLM_API_KEY:
        raise RuntimeError(
            "LLM_API_KEY が未設定です。backend/.env に LLM のAPIキー(既定はGroq)を設定してください。"
        )
    return LLM_API_KEY


async def stream_chat(
    system: str, messages: list[dict]
) -> AsyncIterator[str]:
    """messages: [{"role": "user"|"assistant", "content": str}, ...] をクラウドへ流す。"""
    api_key = _require_api_key()
    payload_messages = (
        [{"role": "system", "content": system}] if system else []
    ) + messages
    payload = {
        "model": LLM_MODEL,
        "messages": payload_messages,
        "temperature": TEMPERATURE,
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = f"{LLM_BASE_URL}/chat/completions"
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[len("data: "):].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                for choice in chunk.get("choices", []):
                    text = choice.get("delta", {}).get("content")
                    if text:
                        yield text


async def complete(prompt: str) -> str:
    """非ストリーミングの単発補完(事実抽出・日記・要約・声かけ用)。"""
    parts: list[str] = []
    async for chunk in stream_chat("", [{"role": "user", "content": prompt}]):
        parts.append(chunk)
    return "".join(parts).strip()
