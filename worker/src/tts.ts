/** 音声合成 — Aivis Cloud API (AivisSpeech)。backend/app/tts.py の移植。
 * キー未設定・失敗時は null を返し、フロントは無音(テキストのみ)で続行する。返す音声は MP3。 */

import type { Env } from "./env";

const AIVIS_BASE = "https://api.aivis-project.com/v1";
const DEFAULT_MODEL_UUID = "a59cb814-0083-4369-8542-f51a29e72af7";

// 感情ごとの声の表情づけ。固定パラメータだと全感情が同じ抑揚になり
// 「人間味が薄い」と感じられる原因になっていたため、speaking_rate(話速)・
// emotional_intensity(感情表現の強さ)・volume(音量)を感情別に変える。
const DEFAULT_SETTINGS = { speaking_rate: 1.0, emotional_intensity: 1.0, volume: 1.0 };
const EMOTION_VOICE_SETTINGS: Record<
  string,
  { speaking_rate: number; emotional_intensity: number; volume: number }
> = {
  happy: { speaking_rate: 1.08, emotional_intensity: 1.4, volume: 1.1 },
  sad: { speaking_rate: 0.92, emotional_intensity: 0.7, volume: 0.9 },
  angry: { speaking_rate: 1.05, emotional_intensity: 1.5, volume: 1.15 },
  relaxed: { speaking_rate: 0.95, emotional_intensity: 0.9, volume: 1.0 },
  shy: { speaking_rate: 0.95, emotional_intensity: 0.8, volume: 0.9 },
  neutral: DEFAULT_SETTINGS,
};

export async function synthesize(
  env: Env,
  text: string,
  emotion?: string | null,
): Promise<ArrayBuffer | null> {
  const key = env.AIVIS_API_KEY;
  if (!key || !text.trim()) return null;
  const modelUuid = env.AIVIS_MODEL_UUID || DEFAULT_MODEL_UUID;
  const voiceSettings = EMOTION_VOICE_SETTINGS[emotion ?? "neutral"] ?? DEFAULT_SETTINGS;
  const url = `${AIVIS_BASE}/tts/synthesize`;
  const payload: Record<string, unknown> = {
    model_uuid: modelUuid,
    text,
    output_format: "mp3",
    // Aivisは既定で先頭に0.1秒の無音を付ける(leading_silence_seconds=0.1)。会話の即応性
    // (没入感)を上げるため、発話冒頭の無音をゼロにして体感レイテンシを削る。
    leading_silence_seconds: 0.0,
    ...voiceSettings,
  };
  if (env.AIVIS_SPEAKER_UUID) payload.speaker_uuid = env.AIVIS_SPEAKER_UUID;
  if (env.AIVIS_STYLE_NAME) payload.style_name = env.AIVIS_STYLE_NAME;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}
