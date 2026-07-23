import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { applyRevenueCatEntitlements, type RevenueCatEntitlementState } from "../src/revenuecat";
import { Store } from "../src/db";

const USER_ID = "purchaser-1";

function proEntitlement(overrides: Partial<RevenueCatEntitlementState> = {}): RevenueCatEntitlementState {
  const now = Date.parse("2026-07-21T00:00:00Z");
  return {
    entitlementId: "pro",
    productId: "vmate.pro",
    isActive: true,
    expiresAtMs: now + 30 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

beforeEach(async () => {
  await env.DB.exec(`
    DROP TABLE IF EXISTS entitlements; DROP TABLE IF EXISTS purchases;
    CREATE TABLE entitlements (user_id TEXT NOT NULL, entitlement_key TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, entitlement_key));
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, original_external_id TEXT, product_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, occurred_at TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, UNIQUE(provider, external_id));
  `);
});

describe("applyRevenueCatEntitlements", () => {
  it("grants an entitlement and records the purchase for a known RevenueCat entitlement id", async () => {
    const store = new Store(env.DB);
    const eventTime = Date.parse("2026-07-21T00:00:00Z");
    const result = await applyRevenueCatEntitlements(store, USER_ID, "evt-1", eventTime, [proEntitlement()]);
    expect(result).toEqual({ ok: true });

    const entitlements = await store.getActiveEntitlements(USER_ID);
    expect(entitlements).toEqual([{ entitlement_key: "subscription:pro", expires_at: expect.any(String) }]);

    const purchases = await env.DB.prepare("SELECT * FROM purchases WHERE user_id = ?").bind(USER_ID).all();
    expect(purchases.results).toHaveLength(1);
    expect(purchases.results[0].external_id).toBe("evt-1:pro");
    expect(purchases.results[0].provider).toBe("revenuecat");
  });

  it("rejects an unknown RevenueCat entitlement id without writing anything (catalog allowlist)", async () => {
    const store = new Store(env.DB);
    const result = await applyRevenueCatEntitlements(store, USER_ID, "evt-1", Date.parse("2026-07-21T00:00:00Z"), [
      proEntitlement({ entitlementId: "not-a-real-entitlement" }),
    ]);
    expect(result).toEqual({ ok: false, reason: "unknown_entitlement" });
    expect((await store.getActiveEntitlements(USER_ID)).length).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases").first<{ n: number }>())!.n).toBe(0);
  });

  it("is idempotent: replaying the same event id does not duplicate the purchase row", async () => {
    const store = new Store(env.DB);
    const eventTime = Date.parse("2026-07-21T00:00:00Z");
    await applyRevenueCatEntitlements(store, USER_ID, "evt-1", eventTime, [proEntitlement()]);
    await applyRevenueCatEntitlements(store, USER_ID, "evt-1", eventTime, [proEntitlement()]);
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases WHERE external_id = ?").bind("evt-1:pro").first<{ n: number }>())!.n;
    expect(count).toBe(1);
  });

  it("advances expires_at on a renewal (newer event)", async () => {
    const store = new Store(env.DB);
    await applyRevenueCatEntitlements(store, USER_ID, "evt-1", Date.parse("2026-07-21T00:00:00Z"), [proEntitlement()]);
    await applyRevenueCatEntitlements(
      store,
      USER_ID,
      "evt-2",
      Date.parse("2026-08-20T00:00:00Z"),
      [proEntitlement({ expiresAtMs: Date.parse("2026-09-20T00:00:00Z") })],
    );
    const [entitlement] = await store.getActiveEntitlements(USER_ID);
    expect(entitlement.expires_at?.startsWith("2026-09-20")).toBe(true);
  });

  it("does not let a stale/replayed older webhook roll back a newer entitlement (monotonic guard)", async () => {
    const store = new Store(env.DB);
    await applyRevenueCatEntitlements(
      store,
      USER_ID,
      "evt-newer",
      Date.parse("2026-08-20T00:00:00Z"),
      [proEntitlement({ expiresAtMs: Date.parse("2026-09-20T00:00:00Z") })],
    );
    await applyRevenueCatEntitlements(
      store,
      USER_ID,
      "evt-older",
      Date.parse("2026-07-01T00:00:00Z"),
      [proEntitlement({ expiresAtMs: Date.parse("2026-07-15T00:00:00Z") })],
    );
    const [entitlement] = await store.getActiveEntitlements(USER_ID);
    expect(entitlement.expires_at?.startsWith("2026-09-20")).toBe(true);
  });

  it("REGRESSION: EXPIRATION/CANCELLATION (isActive=false) revokes access immediately regardless of expires_at", async () => {
    // RevenueCat の subscriber API は失効・返金確定後、is_active=false を即座に返す。旧実装(自前StoreKit2)
    // は返金を expires_at の残り期間だけ露出させ続ける既知の限界があった(storekit_purchase_flow_completion
    // _2026-07-21.md参照)。RevenueCat移行後は isActive=false を status: "revoked" として即座に反映することで
    // この限界を解消する ―― 露出ゼロであることをここで保証する。
    const store = new Store(env.DB);
    await applyRevenueCatEntitlements(store, USER_ID, "evt-1", Date.parse("2026-07-21T00:00:00Z"), [proEntitlement()]);
    expect((await store.getActiveEntitlements(USER_ID)).length).toBe(1);

    await applyRevenueCatEntitlements(
      store,
      USER_ID,
      "evt-2",
      Date.parse("2026-07-22T00:00:00Z"),
      [proEntitlement({ isActive: false, expiresAtMs: Date.parse("2026-09-20T00:00:00Z") })],
    );
    expect((await store.getActiveEntitlements(USER_ID)).length).toBe(0);
  });

  it("stores expires_at as null for a non-expiring entitlement", async () => {
    const store = new Store(env.DB);
    await applyRevenueCatEntitlements(store, USER_ID, "evt-1", Date.parse("2026-07-21T00:00:00Z"), [
      proEntitlement({ expiresAtMs: null }),
    ]);
    const [entitlement] = await store.getActiveEntitlements(USER_ID);
    expect(entitlement.expires_at).toBeNull();
  });
});
