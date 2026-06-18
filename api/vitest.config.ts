import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

// Run tests inside the real Workers runtime (workerd) with the real bindings
// (incl. a real local D1). This is what makes the security tests meaningful: Web
// Crypto (PBKDF2/RS256), D1 prepared statements, cookies — the actual runtime.
//
// Migrations are read at config time (Node side) and handed to the test worker
// via a binding; test/setup.ts applies them to each isolated test DB.
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              TEST_MIGRATIONS: migrations,
              // wrangler.toml ships a <PLACEHOLDER> VAPID public key (self-hosters
              // fill in their own). Override it for the test runtime ONLY with a
              // valid, throwaway example P-256 public key (base64url, uncompressed
              // 0x04||x||y) so the push/public-key route returns a parseable key.
              // This is a NON-secret example key, not used in any deployment.
              VAPID_PUBLIC_KEY:
                "BEbolHiDgIp2vH7GSVjrkkzrA8m1qqba7V8zZsYtCpNEDk8jnHLbqxWsEU31d5-wP7Wj29LfDKBsLpbtwfGxEcE",
            },
          },
        },
      },
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
