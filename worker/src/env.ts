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
  APPLE_BUNDLE_ID?: string;
  REVENUECAT_ENVIRONMENT?: string;

  // secrets(wrangler secret put)。未設定なら undefined。
  LLM_API_KEY?: string;
  JWT_SECRET?: string;
  AIVIS_API_KEY?: string;
  AIVIS_MODEL_UUID?: string;
  AIVIS_SPEAKER_UUID?: string;
  AIVIS_STYLE_NAME?: string;
  // RevenueCat webhook(POST /api/webhooks/revenuecat)の Authorization ヘッダ照合用 shared secret。
  REVENUECAT_WEBHOOK_AUTH?: string;
  // RevenueCat REST API(GET /v1/subscribers/{app_user_id})呼び出し用の Secret API Key。
  REVENUECAT_SECRET_API_KEY?: string;
}
