/** Worker のバインディングと環境変数。wrangler.jsonc の定義と対応する。 */
export interface Env {
  // バインディング
  DB: D1Database;
  ASSETS: Fetcher;
  MODELS: R2Bucket;

  // vars(wrangler.jsonc)
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  ENABLE_TTS: string;
  RATE_PER_USER_PER_DAY: string;
  RATE_GLOBAL_PER_DAY: string;
  RATE_LOGIN_PER_IP_PER_DAY: string;

  // secrets(wrangler secret put)。未設定なら undefined。
  LLM_API_KEY?: string;
  JWT_SECRET?: string;
  AIVIS_API_KEY?: string;
  AIVIS_MODEL_UUID?: string;
  AIVIS_SPEAKER_UUID?: string;
  AIVIS_STYLE_NAME?: string;
}
