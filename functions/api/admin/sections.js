// functions/api/admin/sections.js
//
// Admin editor backend for the EchoDevo Foundations Manual.
//
// Same architecture as ECHO-MANUAL/functions/api/admin/sections.js, but
// pointed at the angelanaeth/ECHO-FOUNDATIONS repo, and with TWO extra
// capabilities tailored to the Foundations workflow:
//
//   POST /api/admin/pull-from-echo
//        Pull a named section from ECHO-MANUAL's public/index.html
//        into a Foundations section. Used by the "🔄 Pull Latest from
//        ECHO" button in the editor.
//
//   GET  /api/admin/echo-sections
//        List sections available in ECHO-MANUAL so the editor can
//        offer a "copy from ECHO" picker.
//
// Routes (dispatched by method + path + ?param):
//
//   GET  /api/admin/sections                  → list Foundations sections
//   GET  /api/admin/sections?id=sec-N         → read one section
//   PUT  /api/admin/sections?id=sec-N         → save one section (commit on main)
//   GET  /api/admin/echo-sections             → list ECHO sections (read-only)
//   GET  /api/admin/echo-sections?id=sec-N    → read one ECHO section (read-only)
//   POST /api/admin/pull-from-echo            → copy a section from ECHO into Foundations
//        body: { echo_id, foundations_id?, mode: 'overwrite'|'append' }
//
// All endpoints inherit Cloudflare Access gating from /api/admin path.

const COMMON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
};

const F_OWNER  = "angelanaeth";
const F_REPO   = "ECHO-FOUNDATIONS";
const F_FILE   = "public/index.html";
const F_BRANCH = "main";

const E_OWNER  = "angelanaeth";
const E_REPO   = "ECHO-MANUAL";
const E_FILE   = "public/index.html";
const E_BRANCH = "main";

// ───────────────────────────────────────────────────────────────────────
// Top-level dispatch
// ───────────────────────────────────────────────────────────────────────

export const onRequest = async (ctx) => {
  const url = new URL(ctx.request.url);
  const path = url.pathname;
  const method = ctx.request.method;

  try {
    // ECHO read-only mirror routes
    if (path.endsWith("/echo-sections")) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      return await getEchoSections(ctx, url);
    }

    // Pull-from-ECHO action
    if (path.endsWith("/pull-from-echo")) {
      if (method !== "POST") return json({ error: "method not allowed" }, 405);
      return await pullFromEcho(ctx);
    }

    // Foundations sections
    if (path.endsWith("/sections")) {
      if (method === "GET") return await getFoundationsSections(ctx, url);
      if (method === "PUT") return await putFoundationsSection(ctx, url);
      return json({ error: "method not allowed" }, 405);
    }

    return json({ error: "unknown admin route" }, 404);
  } catch (err) {
    return json({ error: err.message || String(err) }, 500);
  }
};

// ───────────────────────────────────────────────────────────────────────
// Foundations sections (read/write)
// ───────────────────────────────────────────────────────────────────────

async function getFoundationsSections(ctx, url) {
  const id = url.searchParams.get("id");
  const file = await fetchFile(ctx.env, F_OWNER, F_REPO, F_FILE, F_BRANCH);
  if (!id) return json({ sections: listSections(file.content) });
  const section = extractSection(file.content, id);
  if (!section) return json({ error: `section ${id} not found` }, 404);
  return json({ id, title: section.title, html: section.html, sha: file.sha });
}

async function putFoundationsSection(ctx, url) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "missing ?id=sec-N" }, 400);

  const body = await ctx.request.json().catch(() => ({}));
  const newHtml = typeof body.html === "string" ? body.html : null;
  if (newHtml === null) return json({ error: "missing body.html" }, 400);

  const author = ctx.request.headers.get("cf-access-authenticated-user-email")
              || "foundations-editor@echodevo.com";

  const file = await fetchFile(ctx.env, F_OWNER, F_REPO, F_FILE, F_BRANCH);
  const rewritten = replaceSection(file.content, id, newHtml);
  if (!rewritten) return json({ error: `section ${id} not found` }, 404);

  // Safety guards
  if (rewritten.length < file.content.length * 0.5) {
    return json({ error: "refused: new file would be <50% size of original" }, 400);
  }
  if (!rewritten.includes("</main>")) {
    return json({ error: "refused: </main> closing tag missing in result" }, 400);
  }

  const commitMessage = (typeof body.commit_message === "string" && body.commit_message.trim())
    ? body.commit_message.trim()
    : `edit(${id}): update via Foundations admin editor`;

  const commit = await commitFile(ctx.env, F_OWNER, F_REPO, F_FILE, F_BRANCH, {
    newContent: rewritten,
    prevSha: file.sha,
    message: commitMessage,
    author,
  });

  return json({ ok: true, commit_sha: commit.sha, html_url: commit.html_url });
}

// ───────────────────────────────────────────────────────────────────────
// ECHO sections (read-only mirror — used by the editor's picker)
// ───────────────────────────────────────────────────────────────────────

async function getEchoSections(ctx, url) {
  const id = url.searchParams.get("id");
  const file = await fetchFile(ctx.env, E_OWNER, E_REPO, E_FILE, E_BRANCH);
  if (!id) return json({ sections: listSections(file.content), source: "echo-manual" });
  const section = extractSection(file.content, id);
  if (!section) return json({ error: `ECHO section ${id} not found` }, 404);
  return json({ id, title: section.title, html: section.html, source: "echo-manual" });
}

// ───────────────────────────────────────────────────────────────────────
// Pull-from-ECHO action
// ───────────────────────────────────────────────────────────────────────

async function pullFromEcho(ctx) {
  const body = await ctx.request.json().catch(() => ({}));
  const echoId = (body.echo_id || "").trim();
  const foundationsId = (body.foundations_id || "").trim();
  const mode = (body.mode || "overwrite").trim();   // 'overwrite' or 'append'

  if (!echoId) return json({ error: "missing body.echo_id" }, 400);
  if (!foundationsId) return json({ error: "missing body.foundations_id" }, 400);
  if (mode !== "overwrite" && mode !== "append") {
    return json({ error: "body.mode must be 'overwrite' or 'append'" }, 400);
  }

  const author = ctx.request.headers.get("cf-access-authenticated-user-email")
              || "foundations-editor@echodevo.com";

  // 1. Read the ECHO section
  const echoFile = await fetchFile(ctx.env, E_OWNER, E_REPO, E_FILE, E_BRANCH);
  const echoSection = extractSection(echoFile.content, echoId);
  if (!echoSection) return json({ error: `ECHO section ${echoId} not found` }, 404);

  // 2. Read the Foundations file
  const fFile = await fetchFile(ctx.env, F_OWNER, F_REPO, F_FILE, F_BRANCH);
  const fSection = extractSection(fFile.content, foundationsId);
  if (!fSection) return json({ error: `Foundations section ${foundationsId} not found` }, 404);

  // 3. Compose the new Foundations section HTML
  //    - Strip ECHO-specific advanced markers (admin-reveal slots, anchor pills, etc.)
  //    - Add a banner noting the source
  const cleanedEcho = sanitizeFromEcho(echoSection.html);

  const banner = `<!-- Pulled from ECHO-MANUAL ${echoId} on ${new Date().toISOString()} by ${author} -->
<div class="canonical-callout">
  <strong>Sourced from ECHO Coaching Manual.</strong> This material was copied from the canonical ECHO source and may be edited below for the Foundations audience. The drift-check workflow will flag if the original ECHO version diverges from this copy.
</div>
`;

  let newHtml;
  if (mode === "overwrite") {
    newHtml = banner + cleanedEcho;
  } else {
    newHtml = fSection.html + "\n\n" + banner + cleanedEcho;
  }

  // 4. Write back
  const rewritten = replaceSection(fFile.content, foundationsId, newHtml);
  if (!rewritten) return json({ error: "internal: replace failed unexpectedly" }, 500);

  const commit = await commitFile(ctx.env, F_OWNER, F_REPO, F_FILE, F_BRANCH, {
    newContent: rewritten,
    prevSha: fFile.sha,
    message: `pull(echo→foundations): ${echoId} → ${foundationsId} [${mode}]`,
    author,
  });

  return json({
    ok: true,
    pulled_from: echoId,
    pulled_into: foundationsId,
    mode,
    commit_sha: commit.sha,
    html_url: commit.html_url,
    new_html_preview: newHtml.slice(0, 600),
  });
}

/**
 * Strip ECHO-specific markup that doesn't belong in Foundations:
 *   - Admin-reveal slots (formula gating)
 *   - Anchor pills referencing advanced sections
 *   - Internal-only comments
 */
function sanitizeFromEcho(html) {
  let out = html;
  // Remove admin-reveal slots entirely
  out = out.replace(/<div\s+class="echo-internals-slot"[^>]*>[\s\S]*?<\/div>/g, "");
  // Remove anchor links to advanced ECHO sections that won't exist in Foundations
  out = out.replace(/<a\s+href="#(anchor-hierarchy|cp-formula|cs-formula|css-formula|taper-protocol)[^"]*"[^>]*>([\s\S]*?)<\/a>/g, "$2");
  // Remove explicit ECHO/ANC mentions in prose
  out = out.replace(/\b(ECHO Coaching Manual|Angela Naeth Coaching|ANC)\b/g, "EchoDevo");
  // Tighten any double blank lines created by the strips
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// GitHub helpers
// ───────────────────────────────────────────────────────────────────────

async function fetchFile(env, owner, repo, path, branch) {
  const token = env.MANUAL_EDIT_GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new Error("MANUAL_EDIT_GH_TOKEN not configured on this Pages project");

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept":        "application/vnd.github+json",
      "User-Agent":    "foundations-admin-editor",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) throw new Error(`GitHub fetch ${owner}/${repo}/${path} failed: ${r.status}`);
  const data = await r.json();
  const content = atob(data.content.replace(/\n/g, ""));
  return { content, sha: data.sha };
}

async function commitFile(env, owner, repo, path, branch, { newContent, prevSha, message, author }) {
  const token = env.MANUAL_EDIT_GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new Error("MANUAL_EDIT_GH_TOKEN not configured");

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(newContent))),
    sha: prevSha,
    branch,
    committer: { name: "Foundations Editor", email: "foundations-editor@echodevo.com" },
    author:    { name: author.split("@")[0] || "editor", email: author },
  };

  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept":        "application/vnd.github+json",
      "User-Agent":    "foundations-admin-editor",
      "Content-Type":  "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`GitHub commit failed: ${r.status} ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  return { sha: data.commit.sha, html_url: data.commit.html_url };
}

// ───────────────────────────────────────────────────────────────────────
// HTML section parsing
// ───────────────────────────────────────────────────────────────────────

/**
 * List all sections in the file. A "section" is a <section class="card">
 * with an `id="sec-N"` attribute.
 */
function listSections(html) {
  const re = /<section[^>]*\bclass="[^"]*\bcard\b[^"]*"[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const inner = m[2];
    const titleMatch = inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const title = titleMatch ? stripTags(titleMatch[1]).replace(/\s+/g, " ").trim() : "(untitled)";
    out.push({ id, title, char_count: inner.length });
  }
  return out;
}

function extractSection(html, id) {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  const re = new RegExp(
    `<section[^>]*\\bid="${safe}"[^>]*>([\\s\\S]*?)<\\/section>`,
    "i",
  );
  const m = html.match(re);
  if (!m) return null;
  const inner = m[1];
  const titleMatch = inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
  const title = titleMatch ? stripTags(titleMatch[1]).replace(/\s+/g, " ").trim() : "(untitled)";
  return { title, html: inner };
}

function replaceSection(html, id, newInner) {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  const re = new RegExp(
    `(<section[^>]*\\bid="${safe}"[^>]*>)([\\s\\S]*?)(<\\/section>)`,
    "i",
  );
  if (!re.test(html)) return null;
  return html.replace(re, `$1${newInner}$3`);
}

function stripTags(s) { return String(s).replace(/<[^>]+>/g, ""); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: COMMON_HEADERS });
}
