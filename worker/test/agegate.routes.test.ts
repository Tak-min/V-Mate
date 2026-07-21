import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const UID = "route-test-user";
const headers = { Cookie: `aikata_uid=${UID}` };

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS user_age; DROP TABLE IF EXISTS usage;");
  await env.DB.exec(
    "CREATE TABLE user_age (user_id TEXT PRIMARY KEY, birth_date TEXT NOT NULL, age_band TEXT NOT NULL, method TEXT NOT NULL, updated_at TEXT NOT NULL); " +
      "CREATE TABLE usage (scope TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope, day));",
  );
});

async function jsonRequest(path: string, init: RequestInit = {}) {
  const response = await SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe("server-authoritative age gate routes", () => {
  it("reports that age is required when no record exists", async () => {
    const { response, body } = await jsonRequest("/api/profile/age");
    expect(response.status).toBe(200);
    expect(body).toEqual({ age_band: null, required: true });
  });

  it("stores the server-computed band and returns it from GET", async () => {
    const created = await jsonRequest("/api/profile/age", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ birth_date: "1990-01-01" }),
    });
    expect(created.response.status).toBe(200);
    expect(created.body).toEqual({ age_band: "adult", required: false });

    const fetched = await jsonRequest("/api/profile/age");
    expect(fetched.body).toEqual({ age_band: "adult", required: false });
  });

  it.each([
    ["POST", "/api/chat", { message: "こんにちは" }],
    ["POST", "/api/nudge", { reason: "greeting" }],
    ["POST", "/api/diary/generate", {}],
    ["GET", "/api/tts?text=hello", undefined],
  ])("rejects unknown-age interaction before generation: %s %s", async (method, path, body) => {
    const result = await jsonRequest(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(result.response.status).toBe(403);
    expect(result.body.code).toBe("age_required");
  });

  it("rejects interaction for an under-13 user", async () => {
    await env.DB.prepare(
      "INSERT INTO user_age (user_id, birth_date, age_band, method, updated_at) VALUES (?, ?, 'under13', 'self_declared', ?)",
    )
      .bind(UID, "2020-01-01", "2026-07-21T00:00:00")
      .run();

    const result = await jsonRequest("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "こんにちは" }),
    });
    expect(result.response.status).toBe(403);
    expect(result.body.code).toBe("age_restricted");
  });
});
