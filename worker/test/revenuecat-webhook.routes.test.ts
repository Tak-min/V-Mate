import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundUserId = "rc-webhook-user";
const WEBHOOK_SECRET = "test-webhook-shared-secret";

// wrangler.jsonc の REVENUECAT_ENVIRONMENT: "Production" から生成された worker-configuration.d.ts は
// リテラル型 "Production" として推論するため、テストでの上書きには広い型へのアサーションが要る
// (iap-verify.routes.test.ts の IAP_ENABLED と同じ事情)。
const mutableEnv = env as unknown as {
  REVENUECAT_ENVIRONMENT: string;
  REVENUECAT_WEBHOOK_AUTH: string | undefined;
  REVENUECAT_SECRET_API_KEY: string | undefined;
};

beforeEach(async () => {
  mutableEnv.REVENUECAT_ENVIRONMENT = "Production";
  mutableEnv.REVENUECAT_WEBHOOK_AUTH = WEBHOOK_SECRET;
  mutableEnv.REVENUECAT_SECRET_API_KEY = "test-rc-secret-api-key";
  await env.DB.exec(`
    DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS entitlements; DROP TABLE IF EXISTS purchases; DROP TABLE IF EXISTS usage;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE entitlements (user_id TEXT NOT NULL, entitlement_key TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, entitlement_key));
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, original_external_id TEXT, product_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, occurred_at TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, UNIQUE(provider, external_id));
    CREATE TABLE usage (scope TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(scope, day));
    INSERT INTO users VALUES ('${boundUserId}', NULL, NULL, 'now');
  `);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** GET /v1/subscribers/{app_user_id} のレスポンスを模したスタブ。 */
function stubSubscriberFetch(entitlements: Record<string, { product_identifier: string; is_active: boolean; expires_date: string | null }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ subscriber: { entitlements } }), { status: 200 })),
  );
}

function webhookEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      type: "INITIAL_PURCHASE",
      id: "evt-1",
      app_user_id: boundUserId,
      environment: "Production",
      event_timestamp_ms: Date.parse("2026-07-22T00:00:00Z"),
      ...overrides,
    },
  };
}

async function postWebhook(body: unknown, authHeader = `Bearer ${WEBHOOK_SECRET}`) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader) headers.Authorization = authHeader;
  return SELF.fetch("https://example.com/api/webhooks/revenuecat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/webhooks/revenuecat", () => {
  it("REGRESSION: rejects a request with no/wrong shared secret and grants nothing", async () => {
    stubSubscriberFetch({ pro: { product_identifier: "vmate.pro", is_active: true, expires_date: "2026-08-21T00:00:00Z" } });
    const response = await postWebhook(webhookEvent(), "Bearer wrong-secret");
    expect(response.status).toBe(401);
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM entitlements").first<{ n: number }>())!.n;
    expect(count).toBe(0);
  });

  it("rejects a request with no Authorization header at all", async () => {
    stubSubscriberFetch({ pro: { product_identifier: "vmate.pro", is_active: true, expires_date: "2026-08-21T00:00:00Z" } });
    const response = await postWebhook(webhookEvent(), "");
    expect(response.status).toBe(401);
  });

  it("REGRESSION: a SANDBOX webhook grants nothing on a PRODUCTION worker (environment must match exactly)", async () => {
    stubSubscriberFetch({ pro: { product_identifier: "vmate.pro", is_active: true, expires_date: "2026-08-21T00:00:00Z" } });
    const response = await postWebhook(webhookEvent({ environment: "SANDBOX" }));
    expect(response.status).toBe(200); // ackはするがgrantしない(RevenueCatのリトライを止めるため)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM entitlements").first<{ n: number }>())!.n).toBe(0);
  });

  it("REGRESSION: a webhook for an unknown app_user_id (not bound to any account) writes no entitlement/purchase", async () => {
    stubSubscriberFetch({ pro: { product_identifier: "vmate.pro", is_active: true, expires_date: "2026-08-21T00:00:00Z" } });
    const response = await postWebhook(webhookEvent({ app_user_id: "$RCAnonymousID:unbound-nobody-owns-this" }));
    expect(response.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM entitlements").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases").first<{ n: number }>())!.n).toBe(0);
  });

  it("grants an entitlement for a valid, bound, Production webhook", async () => {
    stubSubscriberFetch({ pro: { product_identifier: "vmate.pro", is_active: true, expires_date: "2026-08-21T00:00:00Z" } });
    const response = await postWebhook(webhookEvent());
    expect(response.status).toBe(200);
    const entitlements = await env.DB.prepare("SELECT * FROM entitlements WHERE user_id = ?").bind(boundUserId).all();
    expect(entitlements.results).toHaveLength(1);
    expect(entitlements.results[0].entitlement_key).toBe("subscription:pro");
    expect(entitlements.results[0].status).toBe("active");
  });

  it("is idempotent: replaying the same event id does not duplicate the purchase row", async () => {
    stubSubscriberFetch({ pro: { product_identifier: "vmate.pro", is_active: true, expires_date: "2026-08-21T00:00:00Z" } });
    await postWebhook(webhookEvent());
    await postWebhook(webhookEvent());
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases WHERE external_id = ?").bind("evt-1:pro").first<{ n: number }>())!.n;
    expect(count).toBe(1);
  });

  it("EXPIRATION/CANCELLATION webhook (subscriber now inactive) revokes the entitlement", async () => {
    stubSubscriberFetch({ pro: { product_identifier: "vmate.pro", is_active: true, expires_date: "2026-08-21T00:00:00Z" } });
    await postWebhook(webhookEvent());
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM entitlements WHERE status = 'active'").first<{ n: number }>())!.n).toBe(1);

    stubSubscriberFetch({ pro: { product_identifier: "vmate.pro", is_active: false, expires_date: "2026-08-21T00:00:00Z" } });
    const response = await postWebhook(webhookEvent({ type: "EXPIRATION", id: "evt-2", event_timestamp_ms: Date.parse("2026-08-22T00:00:00Z") }));
    expect(response.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM entitlements WHERE status = 'active'").first<{ n: number }>())!.n).toBe(0);
  });

  it("returns 400 for a malformed event body (missing required fields) and grants nothing", async () => {
    const response = await postWebhook({ event: { type: "INITIAL_PURCHASE" } });
    expect(response.status).toBe(400);
  });
});
