/** 音声合成 — ElevenLabs API。backend/app/tts.py の移植。
 * キー未設定・失敗時は null を返し、フロントは無音(テキストのみ)で続行する。返す音声は MP3。 */

import type { Env } from "./env";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // 多言語対応の女声 "Sarah"
const DEFAULT_MODEL = "eleven_multilingual_v2";

export async function synthesize(env: Env, text: string): Promise<ArrayBuffer | null> {
  const key = env.ELEVENLABS_API_KEY;
  if (!key || !text.trim()) return null;
  const voiceId = env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const model = env.ELEVENLABS_MODEL || DEFAULT_MODEL;
  const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        accept: "audio/mpeg",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
    });
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}
