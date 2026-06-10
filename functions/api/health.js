// GET /api/health — deploy fingerprint + binding sanity check.
// Public on pages.dev so CI smoke-tests can verify a deploy actually
// landed (see _middleware.js PUBLIC_ON_PAGES_DEV allowlist).

export const onRequest = async ({ env }) => {
  const body = {
    ok: true,
    app: "echo-foundations",
    ts: new Date().toISOString(),
    has_openai_key:  !!env.OPENAI_API_KEY,
    has_vectorize:   !!env.VEC,
    has_audit_db:    !!env.DB,
    has_github_token: !!env.GITHUB_TOKEN,
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
