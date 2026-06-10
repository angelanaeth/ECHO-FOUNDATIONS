# ECHO Foundations

The **Foundations Manual** — intro-level / pre-ECHO coaching content for new coaches who don't yet have access to the full [ECHO Coaching Manual](https://github.com/angelanaeth/ECHO-MANUAL).

- **Live URL:** https://foundations.echodevo.com (Cloudflare Access gated)
- **Source of truth:** [`angelanaeth/ECHO-MANUAL`](https://github.com/angelanaeth/ECHO-MANUAL). If Foundations and ECHO ever disagree about a value (zones %, block-type definition, terminology), **ECHO wins.** A nightly drift-check workflow opens a PR if drift is detected.
- **Access:** same Cloudflare Access app as `echo-manual.echodevo.com` (same authorized emails).
- **Chatbot:** scoped to foundational topics only. Will not answer questions about ECHO-internal formulas / advanced periodization / proprietary calculators.

## Repo layout

```
ECHO-FOUNDATIONS/
├── functions/                 # Cloudflare Pages Functions
│   ├── _middleware.js         #   Host gate + Access enforcement
│   ├── _shared/
│   │   ├── grounding.js       #   System prompt + topic guardrails for chat
│   │   ├── openai.js          #   LLM client
│   │   └── audit-log.js       #   D1 audit logger
│   └── api/
│       ├── chat.js            #   Foundations chatbot
│       ├── health.js          #   /api/health
│       └── version.js         #   /api/version (deploy fingerprint)
├── public/
│   ├── index.html             #   The manual itself
│   ├── chat/                  #   Chatbot UI (chat.css, chat.js)
│   ├── _headers / _redirects
│   └── favicon.svg
├── content/
│   └── canonical.from-echo.json   # ← Pulled from ECHO-MANUAL at build time.
│                                  #   NEVER edit by hand. Source: ECHO-MANUAL/shared/canonical.json
├── scripts/
│   ├── sync-canonical.mjs     #   Pulls canonical.json from ECHO-MANUAL
│   └── drift-check.mjs        #   Diffs Foundations content against ECHO
├── .github/workflows/
│   ├── deploy.yml             #   Pages deploy on push to main
│   └── drift-check.yml        #   Nightly + on-push drift detection
└── wrangler.toml              #   Cloudflare Pages config
```

## The drift problem (read this first)

ECHO-MANUAL is the **canonical source**. Foundations may not duplicate ECHO's values verbatim — it must **reference** them. We enforce this in three layers:

1. **Build-time sync.** `scripts/sync-canonical.mjs` pulls `shared/canonical.json` from `angelanaeth/ECHO-MANUAL` (raw GitHub URL, gated by `GITHUB_TOKEN`) before every build. Foundations HTML uses `{{canonical.zones.z2.range}}`-style placeholders that get expanded at build time.
2. **Nightly drift check.** A GitHub Action runs every night, pulls the latest ECHO canonical, diffs it against Foundations' last sync, and opens an automated PR if anything has changed.
3. **Semantic check on every edit.** When Angela feeds Foundations new content, the editor scripts cross-reference any term that exists in ECHO and surface a "you said X but ECHO says Y" diff for approval before commit.

## Development

```bash
# 1. Sync the canonical file from ECHO
GITHUB_TOKEN=<your-pat> npm run sync-canonical

# 2. Verify no drift
npm run drift-check

# 3. Local dev
npm run dev
```

## Related repos

- [`angelanaeth/ECHO-MANUAL`](https://github.com/angelanaeth/ECHO-MANUAL) — the full ECHO coaching manual (source of truth)
- [`angelanaeth/ECHO-MANUAL/apps/athlete-bot`](https://github.com/angelanaeth/ECHO-MANUAL/tree/main/apps/athlete-bot) — the public athlete chatbot

---

© EchoDevo Coaching. Internal use only.
