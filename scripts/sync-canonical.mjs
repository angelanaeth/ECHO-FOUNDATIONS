#!/usr/bin/env node
/**
 * sync-canonical.mjs
 *
 * Pull the canonical.json file from the ECHO-MANUAL repo and write it
 * to content/canonical.from-echo.json in this repo. Run before build.
 *
 * Auth: needs a GITHUB_TOKEN env var with `repo` read access to
 * angelanaeth/ECHO-MANUAL (since both repos are private).
 *
 * Exit codes:
 *   0  - synced successfully (file may or may not have changed)
 *   1  - failed (network, auth, or parse error)
 *   2  - file changed since last sync (so CI can detect drift)
 */

import fs from "node:fs";
import path from "node:path";

const ECHO_REPO    = "angelanaeth/ECHO-MANUAL";
const ECHO_BRANCH  = "main";
const ECHO_PATH    = "shared/canonical.json";
const LOCAL_TARGET = "content/canonical.from-echo.json";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("ERROR: GITHUB_TOKEN env var is required (repo:read on angelanaeth/ECHO-MANUAL).");
  process.exit(1);
}

const url = `https://api.github.com/repos/${ECHO_REPO}/contents/${ECHO_PATH}?ref=${ECHO_BRANCH}`;
console.log(`Fetching canonical.json from ${ECHO_REPO}@${ECHO_BRANCH}/${ECHO_PATH}…`);

const res = await fetch(url, {
  headers: {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github.raw+json",
    "User-Agent": "echo-foundations-sync",
    "X-GitHub-Api-Version": "2022-11-28",
  },
});

if (!res.ok) {
  console.error(`ERROR: GitHub API returned ${res.status}: ${await res.text().catch(()=>'')}`);
  process.exit(1);
}

const raw = await res.text();

// Validate JSON
let parsed;
try { parsed = JSON.parse(raw); } catch (e) {
  console.error("ERROR: ECHO canonical.json is not valid JSON:", e.message);
  process.exit(1);
}
if (!parsed?._meta?.schema_version) {
  console.error("ERROR: ECHO canonical.json is missing _meta.schema_version — refusing to sync.");
  process.exit(1);
}

// Compare to existing
const targetPath = path.resolve(LOCAL_TARGET);
fs.mkdirSync(path.dirname(targetPath), { recursive: true });

let previous = null;
if (fs.existsSync(targetPath)) {
  try { previous = fs.readFileSync(targetPath, "utf8"); } catch {}
}

// Pretty-print so diffs are line-by-line readable
const normalized = JSON.stringify(parsed, null, 2) + "\n";
const changed = previous !== normalized;

fs.writeFileSync(targetPath, normalized);
console.log(`Wrote ${LOCAL_TARGET} (${normalized.length} bytes, schema v${parsed._meta.schema_version}).`);

if (changed) {
  console.log("DRIFT_DETECTED: canonical.json has changed since last sync.");
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, "drift_detected=true\n");
  }
  process.exit(2);
}

console.log("No changes — Foundations canonical is in sync with ECHO.");
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, "drift_detected=false\n");
}
process.exit(0);
