import { applyD1Migrations, env } from "cloudflare:test";

// Apply the D1 schema to each isolated test database before the suite runs.
// vitest-pool-workers isolates storage per test file, so this runs per file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
