// Vitest global setup: compile the backend functions to ./dist before the suite
// so server/index.mjs (which imports the COMPILED handler + providers) loads.
// This keeps the TS sources the single source of truth and lets the server test
// run from a clean checkout. It does NOT touch the network or the real codex CLI.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export default function setup() {
  const root = dirname(fileURLToPath(import.meta.url));
  const handler = join(root, "dist", "functions", "api", "analyze-meal.js");
  // Always rebuild if missing; cheap and guarantees freshness.
  if (!existsSync(handler)) {
    execFileSync("npx", ["tsc", "-p", "tsconfig.server.json"], {
      cwd: root,
      stdio: "inherit",
    });
  }
}
