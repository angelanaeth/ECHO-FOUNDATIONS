// functions/_middleware.js
//
// Foundations Pages-wide middleware. Mirrors the ECHO-MANUAL middleware
// philosophy:
//
//   1. Restrict which hostnames are allowed to serve content at all.
//      Only `foundations.echodevo.com` is user-facing. The raw
//      `*.pages.dev` hostname is closed to the public — it can only
//      be reached by including a shared deploy-probe header so CI
//      smoke-tests still pass.
//
//   2. On the public-facing hostname, every request must carry a
//      Cloudflare Access JWT (`cf-access-jwt-assertion` header).
//      CF Access normally enforces this at the edge before the request
//      ever reaches Pages, but we belt-and-suspenders it here so that
//      if the Access app is ever accidentally disabled, the foundations
//      content stays gated.
//
// IMPORTANT: Foundations is gated by the SAME Cloudflare Access app as
// `echo-manual.echodevo.com` — same authorized emails. Editing that
// policy in Cloudflare is the single source of access truth.

const PROTECTED_HOSTS = new Set([
  "foundations.echodevo.com",
]);

const PAGES_DEV_SUFFIX = ".echo-foundations.pages.dev";
const PAGES_DEV_ROOT   = "echo-foundations.pages.dev";

// CI / deploy-pipeline probe. Must match env.DEPLOY_PROBE_SECRET to
// reach private routes on pages.dev. If unset, pages.dev is closed
// except for the public allowlist below.
const DEPLOY_PROBE_HEADER = "x-anc-deploy-probe";

export const onRequest = async (context) => {
  const { request, next, env } = context;
  const url = new URL(request.url);
  const host = url.hostname;
  const path = url.pathname;

  // ─── 1. Allow protected hostnames straight through ────────────────
  if (PROTECTED_HOSTS.has(host)) {
    const res = await next();
    return applyHardeningHeaders(res, { protectedHost: true, path });
  }

  // ─── 2. Handle pages.dev (and preview subdomains) ─────────────────
  if (host === PAGES_DEV_ROOT || host.endsWith(PAGES_DEV_SUFFIX)) {
    const PUBLIC_ON_PAGES_DEV = new Set([
      "/api/health",
      "/api/version",
      "/version.json",
      "/favicon.svg",
      "/logo.png",
      "/logo-dark-mode.png",
      "/robots.txt",
      "/chat/chat.css",
      "/chat/chat.js",
    ]);
    if (PUBLIC_ON_PAGES_DEV.has(path)) {
      const res = await next();
      return applyHardeningHeaders(res, { protectedHost: false, path });
    }

    const probe = request.headers.get(DEPLOY_PROBE_HEADER);
    const expected = env.DEPLOY_PROBE_SECRET;
    if (expected && probe && probe === expected) {
      if (path.startsWith("/api/")) {
        const res = await next();
        return applyHardeningHeaders(res, { protectedHost: false, path });
      }
    }

    return new Response(
      [
        '<!doctype html>',
        '<meta charset="utf-8">',
        '<title>Forbidden</title>',
        '<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,Inter,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#1a1a1a}h1{font-size:22px;margin:0 0 12px}a{color:#d65416}</style>',
        '<h1>This URL is not public</h1>',
        '<p>The EchoDevo Foundations Manual is only available to authorized coaches.</p>',
        '<p>Coaches: please sign in at <a href="https://foundations.echodevo.com">foundations.echodevo.com</a>.</p>',
      ].join("\n"),
      {
        status: 403,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
        },
      },
    );
  }

  // ─── 3. Any other host: closed ────────────────────────────────────
  return new Response("Forbidden", {
    status: 403,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
    },
  });
};

function applyHardeningHeaders(res, { protectedHost, path }) {
  const headers = new Headers(res.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, notranslate");
  if (path === "/" || path === "/index.html" || path.startsWith("/api/")) {
    headers.set("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
    headers.set("Pragma", "no-cache");
    headers.set("Expires", "0");
  }
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), interest-cohort=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  if (protectedHost) {
    const email = res.headers.get("cf-access-authenticated-user-email") || "";
    if (email) headers.set("X-Authenticated-User", email);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};
