// OPTIONAL manual smoke test — NOT run by the automated suite.
//
// Spawns the REAL codex CLI once against a real image to confirm the end-to-end
// CodexProvider path on this host. Tests never call the real CLI; this is for a
// human to eyeball latency + parsing on demand.
//
// Usage:  node server/smoke-codex.mjs /path/to/meal.jpg
//   (build first:  npm run build:server)

import { readFile } from "node:fs/promises";
import { CodexProvider } from "../dist/functions/_llm/codex.js";

const imgPath = process.argv[2];
if (!imgPath) {
  console.error("usage: node server/smoke-codex.mjs <image.jpg>");
  process.exit(2);
}

const t0 = Date.now();
try {
  const imageBase64 = (await readFile(imgPath)).toString("base64");
  const provider = new CodexProvider();
  const result = await provider.analyzeMeal({ imageBase64 });
  console.log("generatedBy:", result.generatedBy);
  console.log("dishes:", JSON.stringify(result.dishes, null, 2));
  console.log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (err) {
  console.error("codex smoke FAILED:", err instanceof Error ? err.message : err);
  console.error(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(1);
}
