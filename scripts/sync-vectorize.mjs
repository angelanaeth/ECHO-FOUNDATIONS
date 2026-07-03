#!/usr/bin/env node
/**
 * sync-vectorize.mjs (Foundations edition)
 *
 * Safely synchronize the Cloudflare Vectorize index
 * `echo-foundations-corpus` with the current local embedding set:
 *
 *   1. Read all current chunk IDs from content/foundations-embeddings.ndjson
 *   2. Read prior known IDs from git history (chunks + committed NDJSON)
 *   3. Compute the diff:
 *         - IDs in prior history but NOT in local set → DELETE (stale)
 *         - IDs in local set                          → UPSERT
 *   4. Delete stale IDs via /delete_by_ids
 *   5. Upsert current via `wrangler vectorize upsert`
 *
 * Why this matters:
 *   Chunk IDs embed a content-hash suffix (see chunk-manual.mjs). If a
 *   section is rewritten, the ID for that chunk changes. Without an
 *   explicit delete step the old ID remains in Vectorize and can still
 *   surface stale content on chatbot queries.
 *
 * Required env:
 *   - CLOUDFLARE_API_TOKEN  (scopes: Vectorize:Edit)
 *   - CLOUDFLARE_ACCOUNT_ID
 *
 * Required file:
 *   - content/foundations-embeddings.ndjson  (run `npm run build:embeddings` first)
 *
 * Run:
 *   npm run sync:vectorize
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NDJSON = path.resolve(ROOT, "content/foundations-embeddings.ndjson");

const INDEX_NAME = process.env.VECTORIZE_INDEX || "echo-foundations-corpus";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

if (!CF_TOKEN) die("CLOUDFLARE_API_TOKEN not set.");
if (!CF_ACCT) die("CLOUDFLARE_ACCOUNT_ID not set.");
if (!fs.existsSync(NDJSON)) die(`Embeddings file not found: ${NDJSON}`);

const API_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCT}/vectorize/v2/indexes/${INDEX_NAME}`;

async function cfFetch(pathSuffix, init = {}) {
  const res = await fetch(`${API_BASE}${pathSuffix}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CF_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const json = await res.json();
  if (!json.success) {
    die(
      `Vectorize API call failed (${pathSuffix}): ${JSON.stringify(json.errors)}`
    );
  }
  return json.result;
}

console.log(`→ Sync Vectorize index "${INDEX_NAME}"`);

// ─── 1. Local IDs from NDJSON ─────────────────────────────────────────
const localIds = new Set();
const lines = fs.readFileSync(NDJSON, "utf8").split("\n").filter(Boolean);
for (const line of lines) {
  try {
    const row = JSON.parse(line);
    if (row.id) localIds.add(row.id);
  } catch (_) {
    /* skip */
  }
}
console.log(`  local embeddings:    ${localIds.size}`);

// ─── 2. Remote candidate IDs via git history ──────────────────────────
// Vectorize v2 has no list-all endpoint. We enumerate what USED to be
// indexed by reading recent commits' chunks files. Since chunk-manual.mjs
// emits deterministic content-hashed IDs, anything in prior commits that
// isn't in the current local set is a rename/rewrite → stale.
let remoteCandidates = new Set();

function loadIdsFromGit(refPath) {
  try {
    const r = spawnSync("git", ["show", refPath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) return;
    const data = JSON.parse(r.stdout);
    const arr = Array.isArray(data) ? data : data.chunks || [];
    for (const c of arr) {
      if (c && c.id) remoteCandidates.add(c.id);
    }
  } catch (_) {}
}

// Look at last 5 commits of chunks file — covers most recent renames.
for (let depth = 0; depth <= 5; depth++) {
  loadIdsFromGit(`HEAD~${depth}:content/foundations-chunks.json`);
}

// Also read committed NDJSON if any (unusual but possible)
try {
  const headNdjson = spawnSync(
    "git",
    ["show", "HEAD:content/foundations-embeddings.ndjson"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (headNdjson.status === 0 && headNdjson.stdout) {
    for (const line of headNdjson.stdout.split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        if (row.id) remoteCandidates.add(row.id);
      } catch (_) {}
    }
  }
} catch (_) {}

console.log(`  remote candidates:   ${remoteCandidates.size} (from git history)`);

// ─── 3. Compute stale IDs ─────────────────────────────────────────────
const ID_MAX_BYTES = 64;
const staleIds = [];
let skippedTooLong = 0;
for (const id of remoteCandidates) {
  if (localIds.has(id)) continue;
  if (id.length > ID_MAX_BYTES) { skippedTooLong++; continue; }
  staleIds.push(id);
}
console.log(`  stale to delete:     ${staleIds.length}`);
if (skippedTooLong > 0) {
  console.log(`  skipped (id > ${ID_MAX_BYTES} bytes): ${skippedTooLong}`);
}
if (staleIds.length > 0) {
  console.log("  sample stale IDs:");
  for (const id of staleIds.slice(0, 5)) console.log(`    - ${id}`);
}

// ─── 4. Delete stale IDs (batched) ────────────────────────────────────
if (staleIds.length > 0) {
  const BATCH = 100;
  for (let i = 0; i < staleIds.length; i += BATCH) {
    const batch = staleIds.slice(i, i + BATCH);
    const r = await cfFetch("/delete_by_ids", {
      method: "POST",
      body: JSON.stringify({ ids: batch }),
    });
    console.log(
      `  ✓ delete batch ${i / BATCH + 1}/${Math.ceil(
        staleIds.length / BATCH
      )}: mutation ${r.mutationId}`
    );
  }
}

// ─── 5. Upsert via wrangler ───────────────────────────────────────────
// `upsert` replaces existing IDs' embeddings + metadata. `insert` skips
// duplicates and would leave stale metadata in place.
console.log("→ Upserting current embeddings...");
const ndjsonSize = (fs.statSync(NDJSON).size / 1024 / 1024).toFixed(2);
const r = spawnSync(
  "npx",
  [
    "--yes",
    "wrangler@4",
    "vectorize",
    "upsert",
    INDEX_NAME,
    "--file",
    NDJSON,
    "--batch-size",
    "1000",
  ],
  {
    stdio: "inherit",
    env: process.env,
  }
);
if (r.status !== 0) die(`wrangler vectorize upsert failed (exit ${r.status})`);

console.log(`✓ Sync complete (${localIds.size} vectors current, ${staleIds.length} stale deleted, ${ndjsonSize} MB uploaded)`);
