/** Worker のバインディングと環境変数。wrangler.jsonc の定義と対応する。 */
export interface Env {
  // バインディング
  DB: D1Database;
  ASSETS: Fetcher;

  // vars(wrangler.jsonc)
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  ENABLE_TTS: string;
  RATE_PER_USER_PER_DAY: string;
  RATE_GLOBAL_PER_DAY: string;
  RATE_LOGIN_PER_IP_PER_DAY: string;
  RESEARCH_ALLOW_CONDITION_OVERRIDE?: string;

  // secrets(wrangler secret put)。未設定なら undefined。
  LLM_API_KEY?: string;
  JWT_SECRET?: string;
  RESEARCH_EXPORT_TOKEN?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  ELEVENLABS_MODEL?: string;
}
