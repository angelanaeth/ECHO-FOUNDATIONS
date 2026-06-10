// functions/api/chat.js
//
// Foundations chatbot endpoint. Same shape as ECHO's /api/chat but:
//   - scoped to the foundations Vectorize index (env.VEC)
//   - refuses advanced ECHO-internal topics via isAdvancedTopic()
//   - tags ECHO-canonical chunks so the model knows which to trust on conflict

import {
  SYSTEM_PROMPT, FULL_REFUSAL, ADVANCED_REFUSAL,
  isAdvancedTopic, labelChunk,
} from "../_shared/grounding.js";
import { chatComplete, embed } from "../_shared/openai.js";
import { audit } from "../_shared/audit-log.js";

const TOP_K = 8;
const MIN_SCORE = 0.30;

export const onRequestPost = async (ctx) => {
  const { request, env } = ctx;
  const t0 = Date.now();

  let body;
  try { body = await request.json(); } catch { return jsonErr(400, "Body must be JSON."); }
  const question = (body?.q || body?.question || "").toString().trim();
  if (!question) return jsonErr(400, "Missing question.");

  // Hard-stop on advanced topics before we even touch the corpus.
  if (isAdvancedTopic(question)) {
    audit(ctx, {
      bot: "foundations-chat", event: "refused_advanced", q: question,
      a: ADVANCED_REFUSAL, success: true, reason: "advanced_topic",
      elapsed_ms: Date.now() - t0,
    });
    return jsonOk({ ok: true, answer: ADVANCED_REFUSAL, sources: [], refused: true });
  }

  if (!env.OPENAI_API_KEY) return jsonErr(503, "Chat is not configured (missing OPENAI_API_KEY).");
  if (!env.VEC)            return jsonErr(503, "Chat is not configured (missing Vectorize binding).");

  // 1. Embed the question.
  let qvec;
  try {
    qvec = await embed({ apiKey: env.OPENAI_API_KEY, text: question });
  } catch (e) {
    audit(ctx, { bot:"foundations-chat", event:"embed_error", q: question, success: false, reason: e?.message?.slice(0,200), elapsed_ms: Date.now()-t0 });
    return jsonErr(502, "Could not embed the question.");
  }

  // 2. Retrieve top chunks.
  let matches = [];
  try {
    const result = await env.VEC.query(qvec, { topK: TOP_K, returnMetadata: "all" });
    matches = (result?.matches || []).filter(m => (m.score || 0) >= MIN_SCORE);
  } catch (e) {
    audit(ctx, { bot:"foundations-chat", event:"vector_error", q: question, success: false, reason: e?.message?.slice(0,200), elapsed_ms: Date.now()-t0 });
    return jsonErr(502, "Could not retrieve context.");
  }

  if (matches.length === 0) {
    audit(ctx, { bot:"foundations-chat", event:"no_context", q: question, a: FULL_REFUSAL, success: true, reason: "no_matches", elapsed_ms: Date.now()-t0 });
    return jsonOk({ ok: true, answer: FULL_REFUSAL, sources: [], refused: true });
  }

  // 3. Build context, prefer canonical chunks at the top.
  matches.sort((a, b) => {
    const aCanon = a.metadata?.source === "echo-canonical" ? 1 : 0;
    const bCanon = b.metadata?.source === "echo-canonical" ? 1 : 0;
    if (aCanon !== bCanon) return bCanon - aCanon;          // canonical first
    return (b.score || 0) - (a.score || 0);                  // then by score
  });

  const contextBlocks = matches.map((m, i) => {
    const label = labelChunk({ label: m.metadata?.label, source: m.metadata?.source });
    const text  = (m.metadata?.text || "").slice(0, 1200);
    return `[${i + 1}] ${label}\n${text}`;
  }).join("\n\n---\n\n");

  // 4. LLM call.
  let answer;
  try {
    answer = await chatComplete({
      apiKey: env.OPENAI_API_KEY,
      messages: [
        { role: "system", content: SYSTEM_PROMPT + contextBlocks },
        { role: "user",   content: question },
      ],
    });
  } catch (e) {
    audit(ctx, { bot:"foundations-chat", event:"llm_error", q: question, success: false, reason: e?.message?.slice(0,200), elapsed_ms: Date.now()-t0 });
    return jsonErr(502, "Could not generate an answer.");
  }

  // 5. Build sources for the UI (citation chips).
  const sources = matches.map((m) => ({
    label: m.metadata?.label || "(unlabeled)",
    canonical: m.metadata?.source === "echo-canonical",
    score: Number((m.score || 0).toFixed(3)),
  }));

  audit(ctx, {
    bot:"foundations-chat", event:"answered", q: question, a: answer,
    success: true, reason: null, elapsed_ms: Date.now()-t0,
    meta: { matches: matches.length, canonical: sources.filter(s=>s.canonical).length },
  });

  return jsonOk({ ok: true, answer, sources, refused: false });
};

// Method gate — only POST is allowed.
export const onRequest = async (ctx) => {
  if (ctx.request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { "Allow": "POST" } });
  }
  return onRequestPost(ctx);
};

function jsonOk(obj)  { return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
function jsonErr(s,m) { return new Response(JSON.stringify({ ok: false, error: m }), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
