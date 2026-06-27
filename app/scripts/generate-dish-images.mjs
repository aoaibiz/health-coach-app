#!/usr/bin/env node
// Auto-generate the meal dish-guide images with Codex's built-in image_gen
// (GPT Image 2) — the AUTOMATION CORE of the appetising dish illustrations
// (health-app AIプランナー 第3陣D2). The meal-side twin of
// scripts/generate-exercise-images.mjs.
//
// For each dish in scripts/dish-image-prompts.mjs it:
//   1. builds  `${STYLE_PREFIX} ${prompt}`  (appetising, accurate description),
//   2. asks `codex exec ... --enable image_generation` to call image_gen RIGHT NOW
//      and copy the returned PNG to a temp staging path (we read SAVED: <path>),
//   3. optimizes that PNG to ~512px and writes it to
//      public/dish-guides/<slug>.png.
// Runs SEQUENTIALLY (one codex call at a time) — parallel image_gen cross-assigns
// generated files between runs (known Codex footgun). Re-runnable + idempotent.
//
// THESE ARE IMAGE FIGURES, NOT DATA: the picture is an「イメージ図」for display only
// and never touches any recorded nutrition.
//
// USAGE
//   node scripts/generate-dish-images.mjs                 # (re)generate ALL
//   node scripts/generate-dish-images.mjs ramen oyakodon  # only these slugs
//   node scripts/generate-dish-images.mjs --missing       # only slugs with no PNG yet
//
// REQUIREMENTS: `codex` CLI on PATH (OAuth logged-in), ImageMagick `convert`
// (used for the 512px optimize; falls back to a raw copy if absent).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, copyFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISH_PROMPTS, PROMPTS_BY_SLUG, STYLE_PREFIX } from "./dish-image-prompts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const OUT_DIR = join(REPO, "public", "dish-guides");
const TARGET_PX = 512; // EXACT square canvas — see optimizeInto.
// The meal card shows the dish in a SQUARE object-contain box, so a non-square source
// letterboxes (uneven top/bottom margins → the "framing is uneven" bug Ao flagged).
// We force every output to an EXACT 512×512 square, padding (never stretching) with
// the same pale background so the dish keeps its proportions and every illustration
// frames identically. #f8fafc must match STYLE_PREFIX's background.
const PAD_BG = "#f8fafc";
const EDGE_TRANSPARENCY_PY = String.raw`
from collections import deque
from pathlib import Path
from sys import argv
from PIL import Image

path = Path(argv[1])
img = Image.open(path).convert("RGBA")
w, h = img.size
px = img.load()
corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
target = tuple(round(sum(c[i] for c in corners) / 4) for i in range(3))
threshold = 18
queue = deque([(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)])
seen = set(queue)
while queue:
    x, y = queue.popleft()
    r, g, b, a = px[x, y]
    if max(abs(r - target[0]), abs(g - target[1]), abs(b - target[2])) > threshold:
        continue
    if a != 0:
        px[x, y] = (r, g, b, 0)
    for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
        if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen:
            seen.add((nx, ny))
            queue.append((nx, ny))
img.save(path)
`;

// ---- which slugs to (re)generate -------------------------------------------
function selectEntries(argv) {
  const args = argv.slice(2);
  if (args.includes("--missing")) {
    return DISH_PROMPTS.filter((e) => !existsSync(join(OUT_DIR, `${e.slug}.png`)));
  }
  if (args.length === 0) return DISH_PROMPTS;
  const picked = [];
  for (const slug of args) {
    const e = PROMPTS_BY_SLUG[slug];
    if (!e) {
      console.error(`✗ unknown slug "${slug}" — not in dish-image-prompts.mjs`);
      process.exit(2);
    }
    picked.push(e);
  }
  return picked;
}

// ---- one codex image_gen call → staged PNG path ----------------------------
// Uses the proven "Use your built-in image_gen tool RIGHT NOW / don't read docs /
// copy the returned file / print SAVED:" incantation (the "save to path" form
// silently fails in 2026-06 Codex). We have codex copy to a temp file we own, then
// read the SAVED: line to find it.
function generateOne(entry) {
  const fullPrompt = `${STYLE_PREFIX} ${entry.prompt}`;
  const stageDir = mkdtempSync(join(tmpdir(), `dishgen-${entry.slug}-`));
  const stagePng = join(stageDir, `${entry.slug}.png`);

  const codexInstruction =
    `Use your built-in image_gen tool RIGHT NOW to generate ONE image. ` +
    `Do NOT read any skill documentation files, do NOT ask questions — just call ` +
    `the image_gen tool immediately. Tool prompt: '${fullPrompt}'. ` +
    `After the image_gen tool returns a saved file path, copy THAT exact generated ` +
    `PNG to the absolute path ${stagePng} and then print a line: SAVED: ${stagePng}`;

  console.log(`\n▶ ${entry.slug} (${entry.label}) — calling codex image_gen…`);
  const res = spawnSync(
    "codex",
    [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "danger-full-access",
      "--enable",
      "image_generation",
      codexInstruction,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 1000 * 60 * 8 },
  );

  const out = `${res.stdout || ""}\n${res.stderr || ""}`;
  // Prefer the file codex was told to write; else recover the SAVED: path it printed.
  let produced = existsSync(stagePng) ? stagePng : null;
  if (!produced) {
    const m = out.match(/SAVED:\s*(\S+\.png)/i);
    if (m && existsSync(m[1])) produced = m[1];
  }
  if (!produced) {
    console.error(`  ✗ no image produced for ${entry.slug}`);
    console.error(`  codex tail: ${out.trim().split("\n").slice(-6).join("\n  ")}`);
    rmSync(stageDir, { recursive: true, force: true });
    return null;
  }
  return { stagePng: produced, stageDir };
}

// ---- optimize to ~512px PNG into the public dir ----------------------------
function optimizeInto(srcPng, slug) {
  const dest = join(OUT_DIR, `${slug}.png`);
  // Fit inside 512×512 (preserve aspect, no upscale beyond the box), then pad to an
  // EXACT 512×512 square centred on the pale background — guarantees uniform framing
  // regardless of the aspect ratio image_gen returns. Idempotent (re-running on an
  // already-square PNG is a no-op resize + identity extent).
  const conv = spawnSync(
    "convert",
    [
      srcPng,
      "-resize", `${TARGET_PX}x${TARGET_PX}`,
      "-background", PAD_BG,
      "-gravity", "center",
      "-extent", `${TARGET_PX}x${TARGET_PX}`,
      "-strip",
      dest,
    ],
    { encoding: "utf8" },
  );
  if (conv.status !== 0 || !existsSync(dest)) {
    // ImageMagick missing/failed → keep the full-size image rather than nothing.
    copyFileSync(srcPng, dest);
    console.warn(`  ⚠ convert unavailable/failed — copied full-size for ${slug}`);
  }
  transparentizeEdgeBackground(dest, slug);
  const kb = Math.round(statSync(dest).size / 1024);
  console.log(`  ✓ ${slug}.png written (${kb} KB)`);
  return dest;
}

function transparentizeEdgeBackground(dest, slug) {
  const py = spawnSync("python3", ["-c", EDGE_TRANSPARENCY_PY, dest], { encoding: "utf8" });
  if (py.status !== 0) {
    console.warn(`  ⚠ edge background transparency skipped for ${slug}: ${(py.stderr || "").trim()}`);
  }
}

function main() {
  // Create the output dir if missing (first run) so the script is self-contained.
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
    console.log(`created output dir ${OUT_DIR}`);
  }
  // sanity: codex on PATH
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("✗ `codex` CLI not found on PATH — cannot generate images.");
    process.exit(1);
  }

  const entries = selectEntries(process.argv);
  console.log(`Generating ${entries.length} dish illustration(s) → ${OUT_DIR}`);

  const ok = [];
  const failed = [];
  for (const entry of entries) {
    const gen = generateOne(entry); // SEQUENTIAL — never parallelize image_gen.
    if (!gen) {
      failed.push(entry.slug);
      continue;
    }
    try {
      optimizeInto(gen.stagePng, entry.slug);
      ok.push(entry.slug);
    } finally {
      rmSync(gen.stageDir, { recursive: true, force: true });
    }
  }

  console.log(`\n=== done: ${ok.length} ok, ${failed.length} failed ===`);
  if (ok.length) console.log(`ok:     ${ok.join(", ")}`);
  if (failed.length) {
    console.log(`FAILED: ${failed.join(", ")}  (re-run: node scripts/generate-dish-images.mjs ${failed.join(" ")})`);
    process.exit(1);
  }
}

main();
