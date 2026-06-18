/** LLM クライアント — OpenAI 互換 Chat Completions(既定 Groq)。backend/app/llm.py の移植。
 *
 * fetch のストリーミング応答(ReadableStream)を SSE 行としてパースし、delta.content を順次返す。
 * LLM 待ちは I/O であり Workers の CPU 時間(無料10ms)には計上されない。 */

import type { Env } from "./env";

const TEMPERATURE = 0.85;

export interface ChatMessage {
  role: string;
  content: string;
}

function apiKey(env: Env): string {
  const key = env.LLM_API_KEY;
  if (!key) {
    throw new Error("LLM_API_KEY が未設定です。`wrangler secret put LLM_API_KEY` で設定してください。");
  }
  return key;
}

export function provider(env: Env): string {
  return env.LLM_MODEL;
}

/** system + messages をクラウドへ流し、テキスト片を yield する非同期ジェネレータ。
 *
 * maxTokens: 未指定なら無制限。ペルソナ指示(「1〜3文」等)はモデルが無視することがあるため、
 * 会話のテンポを守る必要がある呼び出し元では明示的に上限を渡すこと。 */
export async function* streamChat(
  env: Env,
  system: string,
  messages: ChatMessage[],
  maxTokens?: number,
): AsyncGenerator<string> {
  const payloadMessages = (system ? [{ role: "system", content: system }] : []).concat(messages);
  const body = JSON.stringify({
    model: env.LLM_MODEL,
    messages: payloadMessages,
    temperature: TEMPERATURE,
    stream: true,
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
  });
  const url = `${env.LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey(env)}`,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM 応答エラー (${response.status}): ${text.slice(0, 200)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(trimmed.indexOf(":") + 1).trim();
      if (data === "[DONE]") return;
      try {
        const chunk = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
        };
        for (const choice of chunk.choices ?? []) {
          const text = choice.delta?.content;
          if (text) yield text;
        }
      } catch {
        // 不完全な JSON 断片は無視(次チャンクで補完される)
      }
    }
  }
}

/** 非ストリーミングの単発補完(事実抽出・日記・要約・声かけ用)。 */
export async function complete(env: Env, prompt: string): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of streamChat(env, "", [{ role: "user", content: prompt }])) {
    parts.push(chunk);
  }
  return parts.join("").trim();
}
