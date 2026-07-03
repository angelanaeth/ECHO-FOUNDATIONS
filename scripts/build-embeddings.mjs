#!/usr/bin/env node
/**
 * build-embeddings.mjs (Foundations edition)
 *
 * Reads content/foundations-chunks.json, calls OpenAI
 * text-embedding-3-small in batches, and writes
 * content/foundations-embeddings.ndjson — a Vectorize-shaped
 * NDJSON file:
 *
 *   {"id":"foundations:sec-zones:5:0e780780","values":[...1536 floats...],"metadata":{...}}
 *
 * Required env:
 *   OPENAI_API_KEY        — OpenAI API key with embeddings access + credit
 *
 * Optional env:
 *   OPENAI_BASE_URL       — defaults to https://api.openai.com/v1
 *   EMBEDDING_MODEL       — defaults to text-embedding-3-small
 *   EMBEDDING_BATCH       — defaults to 96
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npm run build:embeddings
 *
 * Outputs:
 *   content/foundations-embeddings.ndjson
 *   content/foundations-embeddings.meta.json
 */

import { readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "content/foundations-chunks.json");
const OUTPUT_NDJSON = resolve(ROOT, "content/foundations-embeddings.ndjson");
const OUTPUT_META = resolve(ROOT, "content/foundations-embeddings.meta.json");

const API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const BATCH_SIZE = Number(process.env.EMBEDDING_BATCH || 96);

const EXPECTED_DIMS = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

function die(msg, code = 1) {
  console.error(`✖ ${msg}`);
  process.exit(code);
}

if (!API_KEY) {
  die(
    "OPENAI_API_KEY is not set.\n" +
      "  Set it before running:\n" +
      "    export OPENAI_API_KEY=sk-...\n" +
      "    npm run build:embeddings",
  );
}

async function embedBatch(texts) {
  const resp = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });

  if (!resp.ok) {
    let body = "";
    try {
      body = await resp.text();
    } catch {
      /* ignore */
    }
    throw new Error(`OpenAI HTTP ${resp.status}: ${body.slice(0, 500)}`);
  }

  const json = await resp.json();
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error(`Unexpected OpenAI response shape: ${JSON.stringify(json).slice(0, 400)}`);
  }
  if (json.data.length !== texts.length) {
    throw new Error(
      `OpenAI returned ${json.data.length} embeddings for ${texts.length} inputs`,
    );
  }
  return {
    embeddings: json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding),
    usage: json.usage,
  };
}

/**
 * Metadata carried on each vector. Kept small — Vectorize has a
 * per-vector metadata cap. We include `text` so the chat function
 * can render answers without a second store.
 *
 * `source` is set to "foundations" here so functions/api/chat.js can
 * differentiate Foundations-native content from any "echo-canonical"
 * chunks that may be indexed alongside (matches its existing preference
 * logic that sorts `metadata.source === "echo-canonical"` first).
 */
function metadataForChunk(chunk) {
  return {
    source: chunk.source || "foundations",
    cite_label: chunk.cite_label,
    anchor: chunk.anchor || null,
    section_id: chunk.section_id || null,
    section_title: chunk.section_title || null,
    subsection_id: chunk.subsection_id || null,
    heading: chunk.heading || null,
    text: chunk.text,
  };
}

async function main() {
  console.log(`→ Reading ${INPUT}`);
  const raw = JSON.parse(readFileSync(INPUT, "utf8"));
  const chunks = raw.chunks;
  console.log(`→ ${chunks.length} chunks (from ${raw.section_count} sections)`);
  console.log(`→ Model: ${MODEL}, batch size: ${BATCH_SIZE}`);
  console.log(`→ Endpoint: ${BASE_URL}/embeddings\n`);

  const out = createWriteStream(OUTPUT_NDJSON, { encoding: "utf8" });
  let written = 0;
  let totalTokens = 0;
  let totalChars = 0;
  const t0 = Date.now();
  let observedDim = null;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const inputs = batch.map((c) => c.text);

    let attempt = 0;
    let result;
    while (true) {
      try {
        attempt++;
        result = await embedBatch(inputs);
        break;
      } catch (err) {
        if (attempt >= 4) throw err;
        const backoff = 1000 * 2 ** (attempt - 1);
        console.warn(
          `  ! batch ${i / BATCH_SIZE + 1} failed (attempt ${attempt}): ${err.message.slice(0, 200)} — retrying in ${backoff}ms`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    const { embeddings, usage } = result;
    if (usage) totalTokens += usage.total_tokens || 0;

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const vec = embeddings[j];

      if (observedDim === null) {
        observedDim = vec.length;
        const expected = EXPECTED_DIMS[MODEL];
        if (expected && observedDim !== expected) {
          die(
            `Model ${MODEL} returned dimension ${observedDim}, expected ${expected}. ` +
              `Re-create the Vectorize index with --dimensions=${observedDim}.`,
          );
        }
      } else if (vec.length !== observedDim) {
        die(`Embedding dim drift at chunk ${chunk.id}: ${vec.length} != ${observedDim}`);
      }

      out.write(
        JSON.stringify({
          id: chunk.id,
          values: vec,
          metadata: metadataForChunk(chunk),
        }) + "\n",
      );
      totalChars += chunk.text.length;
      written++;
    }

    const pct = ((written / chunks.length) * 100).toFixed(1);
    console.log(`  batch ${(i / BATCH_SIZE + 1).toString().padStart(2)}: +${batch.length}  (${written}/${chunks.length}, ${pct}%)`);
  }

  await new Promise((r) => out.end(r));

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  const meta = {
    generated_at: new Date().toISOString(),
    model: MODEL,
    dimensions: observedDim,
    chunk_count: written,
    section_count: raw.section_count,
    total_chars: totalChars,
    total_tokens: totalTokens,
    elapsed_seconds: Number(elapsedSec),
  };
  writeFileSync(OUTPUT_META, JSON.stringify(meta, null, 2));

  console.log("");
  console.log(`✓ Wrote ${written} embeddings to ${OUTPUT_NDJSON}`);
  console.log(`✓ Meta:  ${OUTPUT_META}`);
  console.log(`  model:      ${MODEL}`);
  console.log(`  dim:        ${observedDim}`);
  console.log(`  tokens:     ${totalTokens.toLocaleString()}`);
  console.log(`  est. cost:  $${((totalTokens / 1_000_000) * 0.02).toFixed(4)}  (text-embedding-3-small @ $0.02/M tok)`);
  console.log(`  elapsed:    ${elapsedSec}s`);
}

main().catch((err) => {
  console.error("");
  console.error("✖ build-embeddings failed:", err.message);
  process.exit(1);
});
