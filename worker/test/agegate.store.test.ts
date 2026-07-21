import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { assertPurchasable } from "../src/agegate";
import { Store } from "../src/db";

// D1バインディングは wrangler.jsonc の設定(binding: "DB")をそのまま使う。テスト用DBは
// マイグレーション未適用のため、このファイルで必要な user_age テーブルだけを都度作る。
beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS user_age");
  await env.DB.exec(
    "CREATE TABLE user_age (user_id TEXT PRIMARY KEY, birth_date TEXT NOT NULL, age_band TEXT NOT NULL, method TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
});

describe("Store.getUserAge / setUserAge", () => {
  it("returns null for a user with no recorded age", async () => {
    const store = new Store(env.DB);
    expect(await store.getUserAge("nobody")).toBeNull();
  });

  it("round-trips a stored age band", async () => {
    const store = new Store(env.DB);
    await store.setUserAge("u1", "1990-01-01", "adult", "self_declared");
    const row = await store.getUserAge("u1");
    expect(row?.age_band).toBe("adult");
    expect(row?.birth_date).toBe("1990-01-01");
    expect(row?.method).toBe("self_declared");
  });

  it("upserts on repeated writes for the same user", async () => {
    const store = new Store(env.DB);
    await store.setUserAge("u1", "2010-01-01", "minor", "self_declared");
    await store.setUserAge("u1", "1990-01-01", "adult", "self_declared");
    const row = await store.getUserAge("u1");
    expect(row?.age_band).toBe("adult");
  });
});

describe("assertPurchasable", () => {
  it("blocks purchases for a user with no age record (fail-safe)", async () => {
    const store = new Store(env.DB);
    const res = await assertPurchasable(store, "unknown-user");
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });

  it("blocks purchases for a minor", async () => {
    const store = new Store(env.DB);
    await store.setUserAge("minor-user", "2012-01-01", "minor", "self_declared");
    const res = await assertPurchasable(store, "minor-user");
    expect(res?.status).toBe(403);
  });

  it("allows purchases for an adult", async () => {
    const store = new Store(env.DB);
    await store.setUserAge("adult-user", "1990-01-01", "adult", "self_declared");
    const res = await assertPurchasable(store, "adult-user");
    expect(res).toBeNull();
  });
});
