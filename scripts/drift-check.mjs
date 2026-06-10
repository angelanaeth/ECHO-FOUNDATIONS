#!/usr/bin/env node
/**
 * drift-check.mjs
 *
 * Scan public/index.html and public/chat/*.{html,js,css} for any
 * literal values that exist in canonical.from-echo.json. Anything that
 * matches a canonical KEY but uses a different VALUE is reported as a
 * drift.
 *
 * Two checks:
 *
 *   1. PRESENCE — files contain a {{canonical.X.Y}} placeholder that
 *      doesn't resolve to a key in canonical.from-echo.json → ERROR.
 *
 *   2. LITERAL DRIFT — files contain a literal canonical VALUE
 *      (e.g. "81-89%") that should be a placeholder instead → WARN.
 *      (We warn-but-pass on this one because some literals are
 *      intentional in narrative text, e.g. "Zone 2 (81-89% of LTHR)".)
 *
 * Exit codes:
 *   0  - no drift
 *   1  - drift detected (CI should fail)
 */

import fs from "node:fs";
import path from "node:path";

const CANONICAL_PATH = "content/canonical.from-echo.json";
const SCAN_DIRS = ["public"];
const SCAN_EXTS = new Set([".html", ".js", ".css", ".md"]);

if (!fs.existsSync(CANONICAL_PATH)) {
  console.error(`ERROR: ${CANONICAL_PATH} does not exist. Run \`npm run sync-canonical\` first.`);
  process.exit(1);
}
const canonical = JSON.parse(fs.readFileSync(CANONICAL_PATH, "utf8"));

// Flatten canonical into a {dot.path: value} map.
const flat = {};
(function walk(obj, prefix) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith("_")) continue;     // skip meta keys
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) walk(v, key);
    else flat[key] = v;
  }
})(canonical, "");

// Walk source files.
function walkDir(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDir(p));
    else if (SCAN_EXTS.has(path.extname(entry.name))) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap(walkDir);
console.log(`Scanning ${files.length} files for canonical drift…`);

const errors = [];
const warnings = [];

// Check 1: placeholders resolve
const PLACEHOLDER_RE = /\{\{\s*canonical\.([a-zA-Z0-9_.]+)\s*\}\}/g;
for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(content)) !== null) {
    const key = m[1];
    if (!(key in flat)) {
      errors.push(`${file}: placeholder {{canonical.${key}}} does not resolve (key missing in canonical.from-echo.json)`);
    }
  }
}

// Check 2: literal drift heuristic (warn only)
// For each canonical string value, check if any file uses that string
// outside of a {{canonical.X}} placeholder context. This is informational —
// some intentional repeats in narrative prose are fine.
for (const [key, val] of Object.entries(flat)) {
  if (typeof val !== "string" || val.length < 4) continue;
  // Skip values that contain only generic words.
  if (/^[a-z ]{0,30}$/i.test(val) && val.split(/\s+/).length <= 2) continue;
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    if (content.includes(val) && !content.includes(`canonical.${key}`)) {
      warnings.push(`${file}: contains literal canonical value "${val}" (key: canonical.${key}). Consider using {{canonical.${key}}} placeholder instead.`);
    }
  }
}

if (warnings.length) {
  console.log("\n⚠️  Warnings (literal canonical values used directly):");
  for (const w of warnings.slice(0, 20)) console.log("  - " + w);
  if (warnings.length > 20) console.log(`  …and ${warnings.length - 20} more`);
}

if (errors.length) {
  console.log("\n❌ Drift errors:");
  for (const e of errors) console.log("  - " + e);
  process.exit(1);
}

console.log(`\n✅ No drift errors. (${warnings.length} informational warnings.)`);
process.exit(0);
