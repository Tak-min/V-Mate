import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { loginWithProvider } from "../src/auth";
import { Store } from "../src/db";

const secret = "this-is-a-test-secret-with-at-least-32-bytes";
const store = new Store(env.DB);

beforeEach(async () => {
  await env.DB.exec(`
    DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS facts; DROP TABLE IF EXISTS diary; DROP TABLE IF EXISTS kv;
    DROP TABLE IF EXISTS user_age; DROP TABLE IF EXISTS reports; DROP TABLE IF EXISTS entitlements; DROP TABLE IF EXISTS purchases; DROP TABLE IF EXISTS identities; DROP TABLE IF EXISTS users;
    CREATE TABLE messages (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, emotion TEXT, created_at TEXT NOT NULL);
    CREATE TABLE facts (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE diary (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, entry_date TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE kv (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id, key));
    CREATE TABLE user_age (user_id TEXT PRIMARY KEY, birth_date TEXT NOT NULL, age_band TEXT NOT NULL, method TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE reports (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, message_id INTEGER, reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE entitlements (user_id TEXT NOT NULL, entitlement_key TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, entitlement_key));
    CREATE TABLE purchases (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, original_external_id TEXT, product_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, occurred_at TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, UNIQUE(provider, external_id));
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE identities (provider TEXT NOT NULL, external_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL, PRIMARY KEY(provider, external_id));
  `);
});

describe("Apple identity account lifecycle", () => {
  it("creates a new Apple user and moves anonymous data once", async () => {
    const anon = "anon-user";
    await env.DB.prepare("INSERT INTO messages (user_id, role, content, created_at) VALUES (?, 'user', 'hello', 'now')").bind(anon).run();
    await env.DB.prepare("INSERT INTO facts (user_id, content, created_at) VALUES (?, 'fact', 'now')").bind(anon).run();
    await env.DB.prepare("INSERT INTO diary (user_id, entry_date, content, created_at) VALUES (?, '2026-07-21', 'diary', 'now')").bind(anon).run();
    await env.DB.prepare("INSERT INTO kv (user_id, key, value) VALUES (?, 'affinity', '1')").bind(anon).run();
    await env.DB.prepare("INSERT INTO user_age VALUES (?, '2000-01-01', 'adult', 'self_declared', 'now')").bind(anon).run();

    await loginWithProvider(store, secret, { provider: "apple", subject: "apple-subject", email: null }, anon);
    const identity = await store.getIdentity("apple", "apple-subject");
    expect(identity?.user_id).toBeTruthy();
    for (const table of ["messages", "facts", "diary", "kv", "user_age"]) {
      const moved = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(identity!.user_id).first<{ n: number }>();
      expect(moved?.n).toBe(1);
    }
  });

  it("does not reassign a later anonymous user when the Apple identity already exists", async () => {
    await loginWithProvider(store, secret, { provider: "apple", subject: "apple-subject", email: null }, "first-anon");
    const existing = (await store.getIdentity("apple", "apple-subject"))!.user_id;
    await env.DB.prepare("INSERT INTO kv (user_id, key, value) VALUES ('later-anon', 'affinity', '99')").run();

    await loginWithProvider(store, secret, { provider: "apple", subject: "apple-subject", email: null }, "later-anon");
    expect((await store.getIdentity("apple", "apple-subject"))?.user_id).toBe(existing);
    expect(await store.getKv("later-anon", "affinity")).toBe("99");
  });

  it("deletes all account-scoped records", async () => {
    await loginWithProvider(store, secret, { provider: "apple", subject: "apple-subject", email: null }, null);
    const userId = (await store.getIdentity("apple", "apple-subject"))!.user_id;
    await env.DB.prepare("INSERT INTO reports (user_id, reason, status, created_at) VALUES (?, 'test', 'open', 'now')").bind(userId).run();
    await store.deleteAccount(userId);
    for (const [table, column] of [["users", "id"], ["identities", "user_id"], ["reports", "user_id"]]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(userId).first<{ n: number }>();
      expect(row?.n).toBe(0);
    }
  });
});
