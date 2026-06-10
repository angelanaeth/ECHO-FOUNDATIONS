// functions/_shared/openai.js
//
// Minimal OpenAI client for the Foundations chatbot.
// Same surface as ECHO's _shared/openai.js so the chat handler reads
// the same way; we keep both for separation of concerns.

const BASE = "https://api.openai.com/v1";
const CHAT_MODEL = "gpt-4o-mini";
const EMBED_MODEL = "text-embedding-3-small";

export async function chatComplete({ apiKey, messages, temperature = 0.2, max_tokens = 800 }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      temperature,
      max_tokens,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI chat error ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

export async function embed({ apiKey, text }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI embed error ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.data?.[0]?.embedding || [];
}
