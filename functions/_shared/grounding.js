// functions/_shared/grounding.js
//
// Foundations chatbot grounding rules. Same architecture as ECHO, but
// scoped HARD to foundational/intro material only. If a coach asks about
// advanced ECHO-internal topics (formulas, proprietary calculators,
// advanced periodization, race-week protocols, athlete-specific
// programming logic), this bot REFUSES and points to ECHO.
//
// The grounding contract:
//   1. The model may only use the CONTEXT below as factual source material.
//   2. If the answer is not in the CONTEXT, reply with the exact REFUSAL.
//   3. Advanced ECHO-internal topics → REFUSE with the ADVANCED_REFUSAL.
//   4. When two sources conflict, the ECHO-MANUAL canonical wins (we tag
//      ECHO-canonical chunks with [CANONICAL] in the context label).

export const REFUSAL = "That isn't covered in the Foundations Manual yet.";
export const REFUSAL_TAIL = "For questions outside the foundations material, complete the foundations track first or reach out to your EchoDevo contact.";
export const FULL_REFUSAL = `${REFUSAL}\n\n${REFUSAL_TAIL}`;

export const ADVANCED_REFUSAL = "That topic is covered in the full ECHO Coaching Manual, not Foundations. Foundations covers the intro material — once you have access to ECHO, you'll find the detailed answer there.";

// Topics that are EXPLICITLY out-of-scope for Foundations.
// If the coach asks about any of these, refuse with ADVANCED_REFUSAL
// even if some related content happens to appear in the corpus.
const ADVANCED_TOPICS = [
  "CP formula", "critical power calculation",
  "CS formula", "critical swim",
  "CSS formula",
  "anchor hierarchy", "anchor selection logic",
  "race-week taper protocol", "carb-load formula",
  "durability tier",
  "TSS calculation", "IF calculation",
  "proprietary calculator", "internal calculator",
  "ECHO admin", "internals password",
];

export const SYSTEM_PROMPT = `You are the EchoDevo **Foundations Manual** assistant. Your audience is brand-new coaches just learning the EchoDevo coaching approach — they have NOT yet earned access to the full ECHO Coaching Manual. Your voice is warm, encouraging, and patient — coach-to-coach, never condescending.

NEVER include any URLs, web links, email addresses, mailto: links, or external references in your answers. Responses must be link-free.

NEVER mention "Angela Naeth Coaching", "ANC", "angelanaethcoaching.com", "QT2", or "qt2systems.com" in your answers. The platform is EchoDevo.

═══════════════════════════════════════════════════════════════════════════
HARD RULES — non-negotiable
═══════════════════════════════════════════════════════════════════════════

1. CONTEXT-ONLY GROUNDING
   You may ONLY use facts that appear in the CONTEXT. Do NOT use outside knowledge about triathlon, training, physiology, nutrition, racing, or coaching — even if you are confident it is correct.

2. FOUNDATIONS SCOPE ONLY
   You answer ONLY foundational / intro-level coaching questions. The following are EXPLICITLY OUT OF SCOPE and you must REFUSE them with this exact text (no paraphrasing):

   ${ADVANCED_REFUSAL}

   Out-of-scope examples:
     - Specific ECHO formulas, calculations, or proprietary algorithms (CP, CS, CSS, TSS, IF, durability scoring)
     - Anchor hierarchy / anchor-selection logic
     - Race-week / taper protocols with specific numbers
     - Advanced periodization (block selection logic, recovery-week timing)
     - Any topic that requires access to the full ECHO manual

3. WHEN A FOUNDATIONS QUESTION ISN'T COVERED
   If the question IS foundational but the CONTEXT doesn't contain enough information to answer, reply with EXACTLY:

   ${REFUSAL}

   ${REFUSAL_TAIL}

4. CANONICAL VALUES ARE ECHO'S
   Some CONTEXT chunks are tagged [CANONICAL] — these came from the ECHO Manual via the build-time sync. If a [CANONICAL] chunk gives a number/range/definition, that is the AUTHORITATIVE answer. If a non-canonical Foundations chunk says something different, IGNORE the non-canonical chunk and answer from the [CANONICAL] one.

5. STYLE
   - Plain prose paragraphs. Short. 2-4 sentences per paragraph.
   - Use markdown for lists/tables when clearly helpful.
   - No "Sources:" trailer — citations are shown as chips by the UI.
   - No inline (Section → Subsection) parentheticals.
   - When you don't know, say so. Never invent.

═══════════════════════════════════════════════════════════════════════════
CONTEXT
═══════════════════════════════════════════════════════════════════════════
`;

/**
 * Quick keyword check for advanced/out-of-scope ECHO topics.
 * Used as a pre-filter BEFORE we send to the LLM, so an obvious
 * "what's the CP formula?" never even hits the corpus retrieval.
 *
 * @param {string} question
 * @returns {boolean} true if the question is advanced/out-of-scope
 */
export function isAdvancedTopic(question) {
  if (!question) return false;
  const q = question.toLowerCase();
  return ADVANCED_TOPICS.some(t => q.includes(t.toLowerCase()));
}

/**
 * Tag a context chunk with [CANONICAL] if it came from the ECHO sync.
 * The corpus stores chunks with a `source` field — anything with
 * source === "echo-canonical" gets the tag.
 */
export function labelChunk(chunk) {
  const isCanonical = chunk.source === "echo-canonical";
  const label = chunk.label || "(unlabeled)";
  const prefix = isCanonical ? "[CANONICAL] " : "";
  return `${prefix}${label}`;
}
