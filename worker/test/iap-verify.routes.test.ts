import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createToken } from "../src/auth";

const adultId = "iap-adult-account";
const minorId = "iap-minor-account";

// wrangler.jsonc の IAP_ENABLED: "false" から生成された worker-configuration.d.ts は
// リテラル型 "false" として推論するため、テストでの上書きには広い型へのアサーションが要る。
const mutableEnv = env as unknown as { IAP_ENABLED: string };

beforeEach(async () => {
  mutableEnv.IAP_ENABLED = "true";
  await env.DB.exec(`
    DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS user_age; DROP TABLE IF EXISTS entitlements; DROP TABLE IF EXISTS purchases; DROP TABLE IF EXISTS app_store_accounts;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE user_age (user_id TEXT PRIMARY KEY, birth_date TEXT NOT NULL, age_band TEXT NOT NULL, method TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE entitlements (user_id TEXT NOT NULL, entitlement_key TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, entitlement_key));
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, original_external_id TEXT, product_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, occurred_at TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, UNIQUE(provider, external_id));
    CREATE TABLE app_store_accounts (user_id TEXT PRIMARY KEY, app_account_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    INSERT INTO users VALUES ('${adultId}', NULL, NULL, 'now'), ('${minorId}', NULL, NULL, 'now');
    INSERT INTO user_age VALUES ('${adultId}', '1990-01-01', 'adult', 'self_declared', 'now'), ('${minorId}', '2015-01-01', 'minor', 'self_declared', 'now');
  `);
});

async function postVerify(body: unknown, userId: string | null = adultId) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userId) headers.Authorization = `Bearer ${await createToken(userId, env.JWT_SECRET)}`;
  return SELF.fetch("https://example.com/api/purchase/apple/verify", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/purchase/apple/verify", () => {
  it("returns 503 when IAP is disabled", async () => {
    mutableEnv.IAP_ENABLED = "false";
    const response = await postVerify({ signed_transaction: "whatever" });
    expect(response.status).toBe(503);
  });

  it("returns 403 for an unauthenticated (anonymous cookie) caller", async () => {
    const response = await postVerify({ signed_transaction: "whatever" }, null);
    expect(response.status).toBe(403);
  });

  it("returns 403 for a minor even with a valid account JWT (server-side age gate, not client-trusted)", async () => {
    const response = await postVerify({ signed_transaction: "whatever" }, minorId);
    expect(response.status).toBe(403);
  });

  it("returns 400 when signed_transaction is missing", async () => {
    const response = await postVerify({});
    expect(response.status).toBe(400);
  });

  it("returns 400 when signed_transaction is not a plausible JWS (fail-closed, no entitlement granted)", async () => {
    const response = await postVerify({ signed_transaction: "this-is-not-a-jws" });
    expect(response.status).toBe(400);
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM entitlements").first<{ n: number }>())!.n;
    expect(count).toBe(0);
  });

  it("returns 400 for an oversized signed_transaction (guards against abuse before touching crypto)", async () => {
    const response = await postVerify({ signed_transaction: "a".repeat(20_001) });
    expect(response.status).toBe(400);
  });
});
