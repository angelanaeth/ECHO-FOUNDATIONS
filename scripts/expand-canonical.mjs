#!/usr/bin/env node
/**
 * expand-canonical.mjs
 *
 * Expand {{canonical.X.Y.Z}} placeholders in public/index.html (and any
 * .html under public/) using values from content/canonical.from-echo.json.
 *
 * Runs AFTER sync-canonical.mjs and BEFORE the Pages deploy in deploy.yml.
 *
 * Exit code 1 if any placeholder cannot be resolved (drift fail-fast).
 */

import fs from "node:fs";
import path from "node:path";

const CANONICAL_PATH = "content/canonical.from-echo.json";
const SCAN_DIR = "public";
const PLACEHOLDER_RE = /\{\{\s*canonical\.([a-zA-Z0-9_.]+)\s*\}\}/g;

if (!fs.existsSync(CANONICAL_PATH)) {
  console.error(`ERROR: ${CANONICAL_PATH} missing. Run npm run sync-canonical first.`);
  process.exit(1);
}
const canonical = JSON.parse(fs.readFileSync(CANONICAL_PATH, "utf8"));

// Flatten canonical into dot-path map.
const flat = {};
(function walk(obj, prefix) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith("_")) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) walk(v, key);
    else flat[key] = v;
  }
})(canonical, "");

function walkDir(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDir(p));
    else if (p.endsWith(".html")) out.push(p);
  }
  return out;
}

const files = walkDir(SCAN_DIR);
let errors = 0;
let total = 0;

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  let count = 0;
  const out = src.replace(PLACEHOLDER_RE, (m, key) => {
    if (!(key in flat)) {
      console.error(`❌ ${file}: unresolved placeholder {{canonical.${key}}}`);
      errors++;
      return m;
    }
    count++;
    return String(flat[key]);
  });
  if (count > 0) {
    fs.writeFileSync(file, out);
    console.log(`✓ ${file}: expanded ${count} placeholders`);
    total += count;
  }
}

if (errors > 0) {
  console.error(`\n${errors} unresolved placeholders — failing build.`);
  process.exit(1);
}
console.log(`\n✅ Expanded ${total} canonical placeholders across ${files.length} files.`);
