/** 音声合成 — ElevenLabs API。backend/app/tts.py の移植。
 * キー未設定・失敗時は null を返し、フロントは無音(テキストのみ)で続行する。返す音声は MP3。 */

import type { Env } from "./env";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // 多言語対応の女声 "Sarah"
const DEFAULT_MODEL = "eleven_multilingual_v2";

// 感情ごとの声の表情づけ。固定の voice_settings だと全感情が同じ抑揚になり
// 「人間味が薄い」と感じられる原因になっていたため、stability(低いほど抑揚が動く)と
// style(高いほど誇張される、eleven_multilingual_v2 が対応)を感情別に変える。
const DEFAULT_SETTINGS = { stability: 0.4, similarity_boost: 0.8, style: 0.2 };
const EMOTION_VOICE_SETTINGS: Record<string, { stability: number; similarity_boost: number; style: number }> = {
  happy: { stability: 0.28, similarity_boost: 0.8, style: 0.55 },
  sad: { stability: 0.55, similarity_boost: 0.85, style: 0.1 },
  angry: { stability: 0.3, similarity_boost: 0.75, style: 0.5 },
  relaxed: { stability: 0.5, similarity_boost: 0.8, style: 0.15 },
  shy: { stability: 0.5, similarity_boost: 0.85, style: 0.1 },
  neutral: DEFAULT_SETTINGS,
};

export async function synthesize(
  env: Env,
  text: string,
  emotion?: string | null,
): Promise<ArrayBuffer | null> {
  const key = env.ELEVENLABS_API_KEY;
  if (!key || !text.trim()) return null;
  const voiceId = env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const model = env.ELEVENLABS_MODEL || DEFAULT_MODEL;
  const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`;
  const voiceSettings = EMOTION_VOICE_SETTINGS[emotion ?? "neutral"] ?? DEFAULT_SETTINGS;
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
        voice_settings: voiceSettings,
      }),
    });
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}
