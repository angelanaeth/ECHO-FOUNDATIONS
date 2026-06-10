// functions/_shared/audit-log.js
//
// Lightweight D1 audit logger. Mirror of the ECHO logger but writes to
// the Foundations D1 database (binding `DB`). Logs are best-effort —
// a failure here NEVER blocks the user-facing response.

/**
 * @param {object} ctx        - the Pages Functions context
 * @param {object} entry      - row payload
 * @param {string} entry.bot  - e.g. 'foundations-chat', 'foundations-health'
 * @param {string} entry.event
 * @param {string} [entry.user]
 * @param {string} [entry.q]
 * @param {string} [entry.a]
 * @param {number} [entry.elapsed_ms]
 * @param {boolean} [entry.success]
 * @param {string} [entry.reason]
 * @param {object} [entry.meta]
 */
export async function audit(ctx, entry) {
  try {
    const db = ctx.env?.DB;
    if (!db) return;
    const row = {
      ts: new Date().toISOString(),
      bot:        entry.bot        || "foundations",
      event:      entry.event      || "(unknown)",
      user:       entry.user       || ctx.request?.headers?.get?.("cf-access-authenticated-user-email") || "(anon)",
      q:          (entry.q || "").slice(0, 4000),
      a:          (entry.a || "").slice(0, 4000),
      elapsed_ms: Number.isFinite(entry.elapsed_ms) ? entry.elapsed_ms : null,
      success:    entry.success === false ? 0 : 1,
      reason:     entry.reason || null,
      meta_json:  entry.meta ? JSON.stringify(entry.meta).slice(0, 2000) : null,
    };
    const stmt = db.prepare(
      `INSERT INTO chat_log (ts, bot, event, user, q, a, elapsed_ms, success, reason, meta_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(
      row.ts, row.bot, row.event, row.user, row.q, row.a,
      row.elapsed_ms, row.success, row.reason, row.meta_json,
    );
    // Best-effort — never await in the user path.
    ctx.waitUntil(stmt.run().catch((e) => console.warn("audit insert failed:", e?.message || e)));
  } catch (e) {
    console.warn("audit() threw:", e?.message || e);
  }
}
