import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await env.DB.exec(`
    DROP TABLE IF EXISTS daily_metrics; DROP TABLE IF EXISTS usage;
    CREATE TABLE daily_metrics (day TEXT NOT NULL, metric TEXT NOT NULL, dimension TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, total_ms INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, metric, dimension));
    CREATE TABLE usage (scope TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope, day));
  `);
});

describe("anonymous product metrics", () => {
  it("accepts only the allowlisted event and stores a daily aggregate", async () => {
    const response = await SELF.fetch("https://example.com/api/analytics/event", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.1" },
      body: JSON.stringify({ event: "onboarding_completed" }),
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const row = await env.DB.prepare("SELECT metric, dimension, count FROM daily_metrics").first<{ metric: string; dimension: string; count: number }>();
    expect(row).toEqual({ metric: "onboarding_completed", dimension: "web", count: 1 });
  });

  it("rejects arbitrary event names instead of accepting properties or personal data", async () => {
    const response = await SELF.fetch("https://example.com/api/analytics/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "free_form", properties: { name: "private" } }),
    });
    expect(response.status).toBe(400);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_metrics").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
