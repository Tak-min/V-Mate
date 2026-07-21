import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { applyAppleTransaction, type AppleTransaction } from "../src/apple_store";
import { Store } from "../src/db";

const USER_ID = "purchaser-1";
// appAccountToken は必須になったため、baseTx はこのアカウントに束縛済みの正規トークンを持つ。
// beforeEach で app_store_accounts にこの値を seed し、getOrCreateAppAccountToken が同じ値を返すように
// する(これにより既存の冪等性/巻き戻しテストは「正しく束縛された取引」の replay-safety を検証し続ける)。
const BOUND_TOKEN = "22222222-2222-2222-2222-222222222222";

function baseTx(overrides: Partial<AppleTransaction> = {}): AppleTransaction {
  const now = Date.parse("2026-07-21T00:00:00Z");
  return {
    transactionId: "2000000000000001",
    originalTransactionId: "2000000000000001",
    productId: "vmate.pro",
    bundleId: "com.takmin.vmate",
    purchaseDate: now,
    expiresDate: now + 30 * 24 * 60 * 60 * 1000,
    signedDate: now,
    type: "Auto-Renewable Subscription",
    environment: "Sandbox",
    appAccountToken: BOUND_TOKEN,
    ...overrides,
  };
}

beforeEach(async () => {
  await env.DB.exec(`
    DROP TABLE IF EXISTS entitlements; DROP TABLE IF EXISTS purchases; DROP TABLE IF EXISTS app_store_accounts;
    CREATE TABLE entitlements (user_id TEXT NOT NULL, entitlement_key TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, entitlement_key));
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, original_external_id TEXT, product_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, occurred_at TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, UNIQUE(provider, external_id));
    CREATE TABLE app_store_accounts (user_id TEXT PRIMARY KEY, app_account_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    INSERT INTO app_store_accounts VALUES ('${USER_ID}', '${BOUND_TOKEN}', 'now');
  `);
});

describe("applyAppleTransaction", () => {
  it("grants an entitlement and records the purchase for a known product", async () => {
    const store = new Store(env.DB);
    const result = await applyAppleTransaction(store, USER_ID, baseTx());
    expect(result).toEqual({ ok: true });

    const entitlements = await store.getActiveEntitlements(USER_ID);
    expect(entitlements).toEqual([{ entitlement_key: "subscription:pro", expires_at: expect.any(String) }]);

    const purchases = await env.DB.prepare("SELECT * FROM purchases WHERE user_id = ?").bind(USER_ID).all();
    expect(purchases.results).toHaveLength(1);
    expect(purchases.results[0].external_id).toBe("2000000000000001");
  });

  it("rejects an unknown productId without writing anything (catalog allowlist)", async () => {
    const store = new Store(env.DB);
    const result = await applyAppleTransaction(store, USER_ID, baseTx({ productId: "vmate.not-a-real-product" }));
    expect(result).toEqual({ ok: false, reason: "unknown_product" });
    expect((await store.getActiveEntitlements(USER_ID)).length).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases").first<{ n: number }>())!.n).toBe(0);
  });

  it("is idempotent: replaying the same transactionId does not duplicate the purchase row", async () => {
    const store = new Store(env.DB);
    await applyAppleTransaction(store, USER_ID, baseTx());
    await applyAppleTransaction(store, USER_ID, baseTx());
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases WHERE external_id = ?").bind("2000000000000001").first<{ n: number }>())!.n;
    expect(count).toBe(1);
  });

  it("advances expires_at on a renewal (newer signedDate, new transactionId under the same original)", async () => {
    const store = new Store(env.DB);
    await applyAppleTransaction(store, USER_ID, baseTx());
    const renewed = baseTx({
      transactionId: "2000000000000002",
      signedDate: Date.parse("2026-08-20T00:00:00Z"),
      purchaseDate: Date.parse("2026-08-20T00:00:00Z"),
      expiresDate: Date.parse("2026-09-20T00:00:00Z"),
    });
    await applyAppleTransaction(store, USER_ID, renewed);
    const [entitlement] = await store.getActiveEntitlements(USER_ID);
    expect(entitlement.expires_at?.startsWith("2026-09-20")).toBe(true);
  });

  it("does not let a stale/replayed older notification roll back a newer entitlement (monotonic guard)", async () => {
    const store = new Store(env.DB);
    const newer = baseTx({ signedDate: Date.parse("2026-08-20T00:00:00Z"), expiresDate: Date.parse("2026-09-20T00:00:00Z") });
    await applyAppleTransaction(store, USER_ID, newer);
    const older = baseTx({
      transactionId: "2000000000000003",
      signedDate: Date.parse("2026-07-01T00:00:00Z"),
      expiresDate: Date.parse("2026-07-15T00:00:00Z"),
    });
    await applyAppleTransaction(store, USER_ID, older);
    const [entitlement] = await store.getActiveEntitlements(USER_ID);
    expect(entitlement.expires_at?.startsWith("2026-09-20")).toBe(true);
  });

  it("rejects when appAccountToken does not match the token bound to this account", async () => {
    const store = new Store(env.DB);
    await store.getOrCreateAppAccountToken(USER_ID); // このアカウント用のトークンを先に発行
    const result = await applyAppleTransaction(store, USER_ID, baseTx({ appAccountToken: "not-the-real-token" }));
    expect(result).toEqual({ ok: false, reason: "account_mismatch" });
    expect((await store.getActiveEntitlements(USER_ID)).length).toBe(0);
  });

  it("accepts when appAccountToken matches the token bound to this account", async () => {
    const store = new Store(env.DB);
    const token = await store.getOrCreateAppAccountToken(USER_ID);
    const result = await applyAppleTransaction(store, USER_ID, baseTx({ appAccountToken: token }));
    expect(result).toEqual({ ok: true });
  });

  it("REGRESSION: rejects a transaction with no appAccountToken and writes no entitlement/purchase (unbound replay)", async () => {
    // トークン無しの取引は「どのアカウントの購入か」を Apple 署名で束縛できない。1つの取引 JWS を
    // 無数の別アカウントへ横流しして各々が無料で権利を得られてしまうため、必ず拒否し、entitlement も
    // purchase も一切書かないこと。
    const store = new Store(env.DB);
    const result = await applyAppleTransaction(store, USER_ID, baseTx({ appAccountToken: null }));
    expect(result).toEqual({ ok: false, reason: "missing_account_token" });
    expect((await store.getActiveEntitlements(USER_ID)).length).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM entitlements").first<{ n: number }>())!.n).toBe(0);
  });

  it("matches appAccountToken case-insensitively (a legit purchase is not 403'd by a case difference)", async () => {
    // crypto.randomUUID() と Apple 返却トークンは現状どちらも小文字だが、大小文字の差だけで正規購入を
    // 誤って拒否しないことを保証する(Finding 6)。
    const store = new Store(env.DB);
    const result = await applyAppleTransaction(store, USER_ID, baseTx({ appAccountToken: BOUND_TOKEN.toUpperCase() }));
    expect(result).toEqual({ ok: true });
    expect((await store.getActiveEntitlements(USER_ID)).length).toBe(1);
  });

  it("stores expires_at as null for a non-subscription (no expiresDate)", async () => {
    const store = new Store(env.DB);
    await applyAppleTransaction(store, USER_ID, baseTx({ expiresDate: null, type: "Non-Consumable" }));
    const [entitlement] = await store.getActiveEntitlements(USER_ID);
    expect(entitlement.expires_at).toBeNull();
  });
});
