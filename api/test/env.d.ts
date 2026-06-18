import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { Env } from "../src/lib/env";

// Augment cloudflare:test's ProvidedEnv with our Worker Env + the test-only
// migrations binding so tests get full typing for `env`.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
