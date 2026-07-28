import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { loginWithProvider } from "../src/auth";
import { Store } from "../src/db";

const secret = "this-is-a-test-secret-with-at-least-32-bytes";
const store = new Store(env.DB);

beforeEach(async () => {
  await env.DB.exec(`
    DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS identities;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE identities (provider TEXT NOT NULL, external_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL, PRIMARY KEY(provider, external_id));
  `);
});

describe("federated account creation across providers", () => {
  it("does not collide when two different providers report the same email", async () => {
    // users.email が NULL 固定でない実装だと、2件目の INSERT が UNIQUE 制約違反になる
    // (同一メールの2人目のフェデレーションユーザーが恒久的に登録不能になるバグの回帰テスト)。
    await loginWithProvider(store, secret, { provider: "apple", subject: "apple-sub", email: "same@example.com" }, null);
    await loginWithProvider(store, secret, { provider: "google", subject: "google-sub", email: "same@example.com" }, null);

    const appleIdentity = await store.getIdentity("apple", "apple-sub");
    const googleIdentity = await store.getIdentity("google", "google-sub");
    expect(appleIdentity?.user_id).toBeTruthy();
    expect(googleIdentity?.user_id).toBeTruthy();
    expect(appleIdentity?.user_id).not.toBe(googleIdentity?.user_id);
  });

  it("stores the federated email on identities, not on users", async () => {
    await loginWithProvider(store, secret, { provider: "google", subject: "google-sub-2", email: "person@example.com" }, null);
    const identity = await store.getIdentity("google", "google-sub-2");
    const user = await store.getUserById(identity!.user_id);
    expect(user?.email).toBeNull();
    expect(await store.listIdentityProviders(identity!.user_id)).toEqual([{ provider: "google", email: "person@example.com" }]);
  });

  it("lists multiple linked providers for the same user in creation order", async () => {
    await loginWithProvider(store, secret, { provider: "apple", subject: "multi-apple", email: null }, null);
    const userId = (await store.getIdentity("apple", "multi-apple"))!.user_id;
    // 同一 user への手動リンク導線は v1 では未実装なので、identities への直接挿入でシミュレートする。
    await env.DB.prepare("INSERT INTO identities (provider, external_id, user_id, email, created_at) VALUES ('line', 'multi-line', ?, NULL, '2099-01-01T00:00:01')").bind(userId).run();

    expect(await store.listIdentityProviders(userId)).toEqual([
      { provider: "apple", email: null },
      { provider: "line", email: null },
    ]);
  });
});
