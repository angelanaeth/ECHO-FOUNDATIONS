// GET /api/version — deploy fingerprint (commit sha + build time).
// Populated by .github/workflows/deploy.yml at build time via env vars.

export const onRequest = async ({ env }) => {
  return new Response(JSON.stringify({
    app: "echo-foundations",
    commit:    env.GIT_COMMIT    || "unknown",
    branch:    env.GIT_BRANCH    || "unknown",
    built_at:  env.BUILD_TIME    || "unknown",
    canonical_sync_sha: env.CANONICAL_SYNC_SHA || "unknown",
  }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
