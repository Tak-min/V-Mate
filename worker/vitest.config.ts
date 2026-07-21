import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    // テスト用の固定鍵。実運用の secret を参照せず、JWT 契約テストだけを成立させる。
    miniflare: { bindings: { JWT_SECRET: "test-jwt-secret-that-is-longer-than-32-bytes" } },
  })],
});
