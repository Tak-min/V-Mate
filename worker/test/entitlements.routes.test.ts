import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createToken } from "../src/auth";

const adultId = "adult-account";
const otherId = "other-account";

beforeEach(async () => {
  await env.DB.exec(`
    DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS user_age; DROP TABLE IF EXISTS entitlements; DROP TABLE IF EXISTS purchases;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE user_age (user_id TEXT PRIMARY KEY, birth_date TEXT NOT NULL, age_band TEXT NOT NULL, method TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE entitlements (user_id TEXT NOT NULL, entitlement_key TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, entitlement_key));
    CREATE TABLE purchases (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, original_external_id TEXT, product_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, occurred_at TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, UNIQUE(provider, external_id));
    INSERT INTO users VALUES ('adult-account', NULL, NULL, 'now'), ('other-account', NULL, NULL, 'now');
    INSERT INTO user_age VALUES ('adult-account', '1990-01-01', 'adult', 'self_declared', 'now'), ('other-account', '1990-01-01', 'adult', 'self_declared', 'now');
    INSERT INTO entitlements VALUES ('adult-account', 'subscription:pro', 'active', 'test', NULL, '2026-07-21T00:00:00');
    INSERT INTO entitlements VALUES ('other-account', 'voice:other', 'active', 'test', NULL, '2026-07-21T00:00:00');
    INSERT INTO entitlements VALUES ('adult-account', 'costume:expired', 'active', 'test', '2000-01-01T00:00:00', '2026-07-21T00:00:00');
  `);
});

async function authorized(path: string, userId = adultId) {
  const token = await createToken(userId, env.JWT_SECRET);
  return SELF.fetch(`https://example.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

describe("P3 read-only entitlement contracts", () => {
  it("returns catalog only for an adult authenticated account", async () => {
    const response = await authorized("/api/catalog");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: "vmate.pro", entitlement_key: "subscription:pro" }] });
    expect((await SELF.fetch("https://example.com/api/catalog")).status).toBe(403);
  });

  it("returns only active entitlements belonging to the authenticated account", async () => {
    const response = await authorized("/api/entitlements");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entitlements: [{ entitlement_key: "subscription:pro", expires_at: null }] });
  });

  it("rejects a minor even with a valid account JWT", async () => {
    await env.DB.prepare("UPDATE user_age SET age_band = 'minor' WHERE user_id = ?").bind(adultId).run();
    expect((await authorized("/api/entitlements")).status).toBe(403);
  });
});
