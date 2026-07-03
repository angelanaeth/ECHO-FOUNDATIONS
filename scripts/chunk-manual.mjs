#!/usr/bin/env node
/**
 * chunk-manual.mjs (Foundations edition)
 *
 * Parses public/index.html into retrieval-ready text chunks for the
 * Foundations chatbot.
 *
 * Foundations HTML structure is DIFFERENT from ECHO-MANUAL:
 *   ECHO-MANUAL:   <h2 id="sec-N">...</h2> starts a section
 *   Foundations:   <section id="sec-name" class="card">...</section>
 *
 * That's the same regex the admin editor uses in
 * functions/api/admin/sections.js, so we stay consistent with the
 * source of truth for what counts as an editable section.
 *
 * Strategy:
 *   1. Read every <section class="card" id="sec-*"> block.
 *   2. Within each section, walk headings (h2/h3/h4). Each heading
 *      starts a new chunk.
 *   3. If a chunk's plain text exceeds MAX_CHARS, split it further at
 *      paragraph boundaries.
 *   4. Each chunk carries the same shape that ECHO-MANUAL emits, so
 *      downstream build-embeddings.mjs / sync-vectorize.mjs is
 *      structurally identical.
 *
 * Output: content/foundations-chunks.json  (also symlinked concept:
 *          matches ECHO-MANUAL's content/all-chunks.json shape via
 *          `chunks[]`, `manual_chunk_count`, `notes_chunk_count`.)
 *
 * Pure local script. No network calls. Safe to run anytime:
 *   npm run build:chunks
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "public/index.html");
const OUTPUT = resolve(ROOT, "content/foundations-chunks.json");

const MAX_CHARS = 1500;
const MIN_CHARS = 60;

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function loadHtml() {
  return readFileSync(INPUT, "utf8");
}

/**
 * Extract every <section id="sec-*" class="card"> ... </section> block.
 * The `class="card"` token can appear in any order within the attribute
 * value — we match it as a word-boundaried token.
 * The same regex is used in functions/api/admin/sections.js.
 */
function extractSections(html) {
  const RE = /<section[^>]*\bclass="[^"]*\bcard\b[^"]*"[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g;
  // Also try the reverse attribute order (id first, then class)
  const RE_ALT = /<section[^>]*\bid="([^"]+)"[^>]*\bclass="[^"]*\bcard\b[^"]*"[^>]*>([\s\S]*?)<\/section>/g;

  const sections = [];
  const seen = new Set();
  for (const re of [RE, RE_ALT]) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      if (!id.startsWith("sec-")) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      sections.push({ id, inner: m[2] });
    }
  }
  return sections;
}

/** Best-effort plain-text conversion. Manual is well-formed enough. */
function htmlToText(html) {
  let s = html;
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Preserve paragraph/line boundaries
  s = s.replace(/<\/(p|li|h[1-6]|div|tr|br)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  // HTML entities (minimal set)
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–");
  // Collapse whitespace
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Extract the first heading text from an HTML fragment (h1/h2/h3/h4). */
function firstHeading(html) {
  const m = html.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
  if (!m) return null;
  return htmlToText(m[1]).slice(0, 200);
}

/**
 * Split a section's inner HTML on h3/h4 boundaries into sub-chunks.
 * Each sub-chunk keeps its own heading text.
 */
function splitOnSubheadings(sectionInner) {
  // Split at any <h3> or <h4> boundary, keeping the heading with the block
  const parts = [];
  const RE = /(<h[34][^>]*>[\s\S]*?<\/h[34]>)/gi;
  let lastIndex = 0;
  const matches = [];
  let m;
  while ((m = RE.exec(sectionInner)) !== null) {
    matches.push({ index: m.index, tag: m[0] });
  }
  if (matches.length === 0) {
    // No subheadings — return whole section as one part
    return [{ heading: null, subsection_id: null, html: sectionInner }];
  }

  // Preamble before first heading (if any)
  if (matches[0].index > 0) {
    const pre = sectionInner.slice(0, matches[0].index);
    if (htmlToText(pre).length >= MIN_CHARS) {
      parts.push({ heading: null, subsection_id: null, html: pre });
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : sectionInner.length;
    const block = sectionInner.slice(start, end);
    const headingMatch = block.match(/<h[34]([^>]*)>([\s\S]*?)<\/h[34]>/i);
    const attrs = headingMatch ? headingMatch[1] : "";
    const headingText = headingMatch ? htmlToText(headingMatch[2]) : null;
    const idMatch = attrs.match(/\bid="([^"]+)"/);
    parts.push({
      heading: headingText,
      subsection_id: idMatch ? idMatch[1] : null,
      html: block,
    });
  }
  return parts;
}

/** If a chunk's text is too long, split further at paragraph boundaries. */
function splitLong(text) {
  if (text.length <= MAX_CHARS) return [text];
  const paras = text.split(/\n{2,}/);
  const out = [];
  let buf = "";
  for (const p of paras) {
    if ((buf + "\n\n" + p).trim().length > MAX_CHARS && buf) {
      out.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? buf + "\n\n" + p : p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Nice human-readable section title for citation labels. */
function prettyTitle(sectionId, firstHead) {
  if (firstHead && firstHead.length > 0) return firstHead;
  // Fallback: sec-block-types → "Block Types"
  return sectionId
    .replace(/^sec-/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log(`→ Reading ${INPUT}`);
  const html = loadHtml();
  const sections = extractSections(html);
  console.log(`→ Found ${sections.length} <section class="card"> blocks`);

  if (sections.length === 0) {
    console.error("✖ No sections extracted — check the HTML structure.");
    process.exit(1);
  }

  const chunks = [];
  for (const section of sections) {
    const sectionId = section.id;
    const sectionFirstHeading = firstHeading(section.inner);
    const sectionTitle = prettyTitle(sectionId, sectionFirstHeading);
    const anchor = sectionId;
    const citeLabel = `§ ${sectionTitle} (Foundations)`;

    const parts = splitOnSubheadings(section.inner);
    let chunkIdx = 0;
    for (const part of parts) {
      const text = htmlToText(part.html);
      if (text.length < MIN_CHARS) continue;
      const pieces = splitLong(text);
      for (const piece of pieces) {
        const id = `foundations:${sectionId}:${chunkIdx}`;
        chunks.push({
          id,
          source: "foundations",
          section_id: sectionId,
          section_title: sectionTitle,
          subsection_id: part.subsection_id,
          heading: part.heading || sectionFirstHeading || sectionTitle,
          text: piece,
          char_count: piece.length,
          anchor: part.subsection_id || anchor,
          cite_label: citeLabel,
        });
        chunkIdx++;
      }
    }
  }

  // Content-hash suffix to make IDs stable-yet-invalidating on rewrites.
  // If a section's text changes, the ID changes → sync-vectorize.mjs
  // detects stale IDs and deletes them.
  for (const c of chunks) {
    const h = createHash("sha1").update(c.text).digest("hex").slice(0, 8);
    c.id = `${c.id}:${h}`;
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  const payload = {
    generated_at: new Date().toISOString(),
    source_file: "public/index.html",
    chunk_count: chunks.length,
    manual_chunk_count: chunks.length,
    notes_chunk_count: 0,
    section_count: sections.length,
    chunks,
  };
  writeFileSync(OUTPUT, JSON.stringify(payload, null, 2));

  console.log(`✓ Wrote ${chunks.length} chunks from ${sections.length} sections`);
  console.log(`✓ Output: ${OUTPUT}`);
  const bySection = {};
  for (const c of chunks) bySection[c.section_id] = (bySection[c.section_id] || 0) + 1;
  console.log(`  chunks per section:`);
  for (const [sid, n] of Object.entries(bySection)) {
    console.log(`    ${sid.padEnd(35)} ${n}`);
  }
}

main();
