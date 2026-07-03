# Deploying ECHO-FOUNDATIONS

This document is the source of truth for how Foundations
(`foundations.echodevo.com` / `echo-foundations.pages.dev`) gets built,
deployed, and kept in sync with ECHO-MANUAL.

## Architecture at a glance

```
┌──────────────────────┐        ┌────────────────────────────┐
│ ECHO-MANUAL (repo)   │──sync─▶│ content/canonical.from-echo│
│  shared/canonical.js │        │ .json (numbers, zones,     │
└──────────────────────┘        │  refs) — used at build     │
                                │  time only                 │
                                └────────────┬───────────────┘
                                             │
                                             ▼
                       ┌───────────────────────────────────────┐
                       │ public/index.html                     │
                       │  14× <section id="sec-*" class="card">│
                       │  Coach-editable via /admin/edit       │
                       └────────────┬──────────────────────────┘
                                    │
                    chunk-manual ──▶│◀── build-embeddings ──▶ OpenAI
                                    │                          embed API
                                    ▼
                       ┌───────────────────────────────────────┐
                       │ content/foundations-embeddings.ndjson │
                       └────────────┬──────────────────────────┘
                                    │  sync-vectorize
                                    ▼
                       ┌───────────────────────────────────────┐
                       │ Vectorize index                       │
                       │   echo-foundations-corpus             │
                       │  ← queried by functions/api/chat.js   │
                       └───────────────────────────────────────┘
```

**Cloudflare bindings** (see `wrangler.toml`):

| Binding | Kind        | Name / ID                                        |
|---------|-------------|--------------------------------------------------|
| `VEC`   | Vectorize   | `echo-foundations-corpus`                        |
| `DB`    | D1 database | `echo-foundations` (`f4c05f6f-a6c7-45a0-9ee8-327b7a275a76`) |

## Required GitHub Actions secrets

The `Deploy Foundations` workflow expects these repo-level secrets:

| Secret                    | Purpose                                                      | Blocking? |
|---------------------------|--------------------------------------------------------------|-----------|
| `CLOUDFLARE_API_TOKEN`    | Wrangler auth for `pages deploy` + Vectorize sync            | **yes**   |
| `CLOUDFLARE_ACCOUNT_ID`   | Cloudflare account ID (`b0e6e7177462586abca25e1f812f2bad`)   | **yes**   |
| `ECHO_MANUAL_READ_TOKEN`  | GitHub PAT with `repo` scope — reads ECHO-MANUAL canonical   | **yes**   |
| `OPENAI_API_KEY`          | OpenAI key for `text-embedding-3-small`                      | soft-fail — RAG rebuild skipped without it; deploy still ships |

The workflow's `Validate secrets are present` step will hard-fail if any
of the blocking secrets are missing, and will verify the Cloudflare
token is `active` by hitting `/user/tokens/verify` before installing
anything.

## Required Cloudflare Pages runtime env vars

These are set on the Pages project (production environment), NOT in
GitHub Actions. They are consumed by the Functions runtime:

| Var                        | Consumer                                    |
|----------------------------|---------------------------------------------|
| `OPENAI_API_KEY`           | `functions/api/chat.js` for chat completion + query embed |
| `MANUAL_EDIT_GH_TOKEN`     | `functions/api/admin/sections.js` to commit edits to `public/index.html` |

`/api/health` returns a JSON manifest of which bindings + secrets are
wired up. That's what the deploy workflow's smoke test asserts.

## Full deploy flow (workflow: `Deploy Foundations`)

Runs on every push to `main` and on manual `workflow_dispatch`.

1. **Checkout** (fetch-depth: 20 — needed by staleness guard)
2. **Staleness guard** — refuse to deploy if `main` has already moved
   past this workflow's commit. Prevents an older-commit run finishing
   after a newer one and rolling back the canonical Cloudflare deployment.
3. **Validate secrets** — hard-fail if any blocking secret missing;
   verify Cloudflare token is active.
4. **Install** deps.
5. **Sync canonical from ECHO-MANUAL** — pulls `shared/canonical.json`
   from the ECHO-MANUAL repo into `content/canonical.from-echo.json`.
6. **Expand canonical placeholders** into HTML.
7. **Drift check** — asserts every canonical value is literally
   referenced (or intentionally overridden) in Foundations prose.
8. **Build chunks** — parse `public/index.html`
   `<section id="sec-*" class="card">` blocks into
   `content/foundations-chunks.json`. 14 sections → ~110 chunks.
9. **Build embeddings** (soft-fail if `OPENAI_API_KEY` missing) — calls
   `text-embedding-3-small` in batches → `content/foundations-embeddings.ndjson`.
10. **Sync Vectorize** (soft-fail on transient error) — deletes stale
    IDs (from prior commits' chunks files) and upserts the current
    NDJSON into `echo-foundations-corpus`.
11. **Stamp version.json** with commit + build timestamp.
12. **Deploy to Cloudflare Pages** via `cloudflare/wrangler-action@v3`.
13. **Wait 30s** for propagation.
14. **Smoke test** — asserts `/api/health` returns
    `ok:true, has_openai_key:true, has_vectorize:true, has_audit_db:true, has_github_token:true`.
    If any is false, the deploy is marked failed (the code is already
    live at this point — this is a red-flag alarm, not a rollback).

## Chunking rules

`scripts/chunk-manual.mjs`:

- Parses every `<section id="sec-*" class="card">…</section>` block.
- Splits on `<h3>` / `<h4>` subheading boundaries.
- Enforces `MAX_CHARS=1500` per chunk (splits at paragraph boundaries),
  drops `<MIN_CHARS=60`.
- Each chunk ID is `foundations:<section_id>:<idx>:<8-char sha1 of text>`.
  The content-hash suffix is what triggers stale-cleanup: if a section's
  text is rewritten, its ID changes → `sync-vectorize.mjs` reads prior
  commits' `foundations-chunks.json`, finds the old ID, deletes it from
  Vectorize before upserting the new one.
- Chunk metadata includes `source: "foundations"` (distinct from
  `"echo-canonical"` used for cross-referenced ECHO chunks the chat
  function may co-index later).

## When things look wrong

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| CI fails at **Validate secrets** with a `missing` message | New secret hasn't been added | Add it under repo Settings → Secrets → Actions |
| CI fails at **Validate secrets** with `CLOUDFLARE_API_TOKEN verify returned HTTP 401` | Token was rotated / expired | Create a new Cloudflare API token with Vectorize:Edit + Pages:Edit + Account:Read; update the secret |
| CI fails at **Staleness guard** with `REFUSING TO DEPLOY: main has moved past…` | Correct behavior. Two workflow runs raced and this one is on the older commit | Do not force through. Dispatch fresh via `workflow_dispatch` against main HEAD |
| **Drift Check** workflow fails at `Sync canonical from ECHO-MANUAL` with `Bad credentials` | `ECHO_MANUAL_READ_TOKEN` PAT expired or lost `repo` scope | Rotate the PAT (needs `repo` scope) and update the secret |
| CI reaches **Build embeddings** and it's marked skipped | `OPENAI_API_KEY` secret missing | Add the OpenAI key to Actions secrets. Chatbot keeps working on the previous Vectorize snapshot until then |
| **Sync Vectorize** step fails with `Vectorize API call failed` on `/delete_by_ids` | Cloudflare token missing `Vectorize:Edit` scope | Add the scope to the CF token, or rotate |
| **Smoke test** fails with `health missing/false fields: ['has_openai_key']` | Cloudflare Pages runtime env var (NOT the GitHub Actions secret) is missing | Add `OPENAI_API_KEY` under Pages project → Settings → Environment variables → Production, then redeploy |
| **Smoke test** fails with `has_vectorize: false` | `VEC` binding not attached to the Pages project | Bind `echo-foundations-corpus` under Pages project → Settings → Functions → Vectorize bindings |
| **Smoke test** fails with `has_github_token: false` | `MANUAL_EDIT_GH_TOKEN` runtime env var missing on Pages project | Add it under Pages project → Environment variables → Production |
| Admin edits are committed to `main` but not on live site after CI succeeds | Multiple runs completed out-of-order; Cloudflare promoted older-commit deployment to canonical | Dispatch `Deploy Foundations` via `workflow_dispatch` against main. Staleness guard now prevents this from happening in the first place. |
| Chatbot returns "I can't find that" for content that exists in Foundations | Vectorize wasn't refreshed (RAG steps were skipped, or `OPENAI_API_KEY` missing) | Add `OPENAI_API_KEY` to Actions secrets and re-dispatch deploy |

## Manual RAG rebuild (local)

If you need to force a full re-index without a code change:

```bash
export OPENAI_API_KEY=sk-...
export CLOUDFLARE_API_TOKEN=cfut_...
export CLOUDFLARE_ACCOUNT_ID=b0e6e7177462586abca25e1f812f2bad

npm install
npm run build:chunks         # public/index.html → content/foundations-chunks.json
npm run build:embeddings     # → content/foundations-embeddings.ndjson (calls OpenAI)
npm run sync:vectorize       # → deletes stale IDs, upserts current into echo-foundations-corpus
```

Or all-in-one: `npm run build:rag`.

## Admin editor

`/admin/edit` provides a TinyMCE WYSIWYG for each `<section id="sec-*" class="card">`.
Save calls `POST /api/admin/sections/:id` → `functions/api/admin/sections.js`
which uses `MANUAL_EDIT_GH_TOKEN` to commit the mutated HTML back to
`public/index.html` on `main`. That push then triggers the full
`Deploy Foundations` workflow above, which will rebuild chunks +
embeddings + push to Vectorize.

**Turnaround: edit → live on site is ~2–3 minutes** (CI dominates).
