import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createToken } from "../src/auth";
import { jstToday, jstWeek } from "../src/util";

const FREE_UID = "quota-free-user";
const PRO_UID = "quota-pro-user";
const anonHeaders = { Cookie: `aikata_uid=${FREE_UID}` };

async function authHeaders(userId: string) {
  const token = await createToken(userId, env.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  await env.DB.exec(`
    DROP TABLE IF EXISTS usage; DROP TABLE IF EXISTS user_age; DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS entitlements; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS diary; DROP TABLE IF EXISTS kv;
    CREATE TABLE usage (scope TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope, day));
    CREATE TABLE kv (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
    CREATE TABLE user_age (user_id TEXT PRIMARY KEY, birth_date TEXT NOT NULL, age_band TEXT NOT NULL, method TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE entitlements (user_id TEXT NOT NULL, entitlement_key TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, entitlement_key));
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, emotion TEXT, created_at TEXT NOT NULL);
    CREATE TABLE diary (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, entry_date TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (user_id, entry_date));
    INSERT INTO user_age VALUES ('${FREE_UID}', '1990-01-01', 'adult', 'self_declared', 'now');
    INSERT INTO user_age VALUES ('${PRO_UID}', '1990-01-01', 'adult', 'self_declared', 'now');
    INSERT INTO users VALUES ('${PRO_UID}', NULL, NULL, 'now');
    INSERT INTO entitlements VALUES ('${PRO_UID}', 'subscription:pro', 'active', 'test', NULL, 'now');
  `);
});

describe("P-C1: Pro/free quota enforcement", () => {
  it("blocks TTS for a free (anonymous) user once the free daily quota is exhausted", async () => {
    await env.DB.prepare("INSERT INTO usage (scope, day, count) VALUES (?, ?, 30)").bind(`tts:${FREE_UID}`, jstToday()).run();
    const response = await SELF.fetch("https://example.com/api/tts?text=hi", { headers: anonHeaders });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ detail: expect.stringContaining("上限") });
  });

  it("does not block a Pro user at the free-tier threshold", async () => {
    await env.DB.prepare("INSERT INTO usage (scope, day, count) VALUES (?, ?, 30)").bind(`tts:${PRO_UID}`, jstToday()).run();
    const response = await SELF.fetch("https://example.com/api/tts?text=hi", { headers: await authHeaders(PRO_UID) });
    // 30 < RATE_TTS_PRO_PER_USER_PER_DAY(300) なので通過し、429にはならない
    // (実合成はAivis未設定/ネットワーク次第のため、ここでは「レート制限で弾かれていない」ことだけを確認する)。
    expect(response.status).not.toBe(429);
  });

  it("never queries entitlements for an unauthenticated (cookie-only) request", async () => {
    // Authorizationヘッダが無い匿名リクエストはPro判定のisEntitled呼び出しをスキップする実装。
    // 30回ちょうどの使用量でも無料枠(30)を超えたとして弾かれる(=Pro判定に迂回していないことの間接確認)。
    await env.DB.prepare("INSERT INTO usage (scope, day, count) VALUES (?, ?, 30)").bind(`tts:${FREE_UID}`, jstToday()).run();
    const response = await SELF.fetch("https://example.com/api/tts?text=hi", { headers: anonHeaders });
    expect(response.status).toBe(429);
  });

  it("blocks diary generation for a free user once the weekly quota is exhausted", async () => {
    const today = jstToday();
    for (let i = 0; i < 4; i++) {
      await env.DB.prepare("INSERT INTO messages (user_id, role, content, created_at) VALUES (?, 'user', 'hi', ?)").bind(FREE_UID, today).run();
    }
    await env.DB.prepare("INSERT INTO usage (scope, day, count) VALUES (?, ?, 2)").bind(`diary:${FREE_UID}`, jstWeek()).run();

    const response = await SELF.fetch("https://example.com/api/diary/generate", { method: "POST", headers: anonHeaders });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, reason: expect.stringContaining("今週の日記") });
  });

  it("does not apply the weekly diary quota to a Pro user", async () => {
    const today = jstToday();
    for (let i = 0; i < 4; i++) {
      await env.DB.prepare("INSERT INTO messages (user_id, role, content, created_at) VALUES (?, 'user', 'hi', ?)").bind(PRO_UID, today).run();
    }
    await env.DB.prepare("INSERT INTO usage (scope, day, count) VALUES (?, ?, 5)").bind(`diary:${PRO_UID}`, jstWeek()).run();

    const response = await SELF.fetch("https://example.com/api/diary/generate", { method: "POST", headers: await authHeaders(PRO_UID) });
    const body = (await response.json()) as { ok: boolean; reason?: string };
    // 週次クォータでは弾かれない(LLM呼び出し自体が失敗する可能性はあるが、reasonが
    // 週次クォータ文言でないことを確認すれば本テストの対象は検証できる)。
    expect(body.reason).not.toContain("今週の日記");
  });
});
