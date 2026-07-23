/** 音声駆動オンボーディング(初対面)専用ハンドラ。index.ts の肥大化を避けるため分離。
 * 名前の抽出+温かい返事の生成のみを行い、DB書き込みは行わない
 * (永続化は既存の /api/profile(setProfile) に一本化し、facts の二重書き込みを防ぐ)。 */

import type { Env } from "./env";
import { complete } from "./llm";
import { introNamePrompt } from "./persona";
import { stripEmotion } from "./util";

export interface IntroNameResult {
  name: string | null;
  text: string;
  emotion: string;
}

const FALLBACK: IntroNameResult = {
  name: null,
  text: "ごめんね、うまく聞き取れなかったみたい。もう一度、お名前を教えてくれる？",
  emotion: "shy",
};

/** LLM出力(1行目=名前 or 「なし」、2行目以降=[emotion]反応文)をパースする。 */
export function parseIntroNameResponse(raw: string): IntroNameResult {
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return FALLBACK;
  const [nameLine, ...rest] = lines;
  const [emotion, text] = stripEmotion(rest.join("\n"));
  if (!text) return FALLBACK;
  const name = nameLine === "なし" || !nameLine ? null : nameLine.slice(0, 40);
  return { name, text, emotion };
}

export async function generateIntroNameResponse(env: Env, transcript: string): Promise<IntroNameResult> {
  try {
    const raw = await complete(env, introNamePrompt(transcript));
    return parseIntroNameResponse(raw);
  } catch {
    return FALLBACK;
  }
}
