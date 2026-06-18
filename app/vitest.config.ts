import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the tsconfig "@/*" -> "./src/*" path mapping for tests.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Pure-logic unit tests (BMR/TDEE/PFC/burn + Phase 3 grounding) need no DOM.
    environment: "node",
    include: ["src/**/*.test.ts", "functions/**/*.test.ts", "server/**/*.test.mjs"],
    // The server test imports the Node backend, which imports the COMPILED
    // functions from ./dist. Build them once before the suite so the test runs
    // from a clean checkout without a manual prebuild step.
    globalSetup: ["./vitest.setup.server.mjs"],
  },
});
