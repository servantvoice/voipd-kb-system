# CLAUDE.md

## What This Is

Monorepo for a white-label knowledge base system. Crawls upstream docs, transforms content (branding, URL rewriting, categorization), and serves via Cloudflare Workers + R2. This is the active codebase — other repos in the parent directory are legacy and unused.

## Commands

```bash
npm install                     # install all workspace dependencies
npm run typecheck               # TypeScript check across all packages
npm run deploy:all              # deploy all workers (in correct order)
npm run deploy:crawl            # deploy crawl worker only
npm run deploy:pipeline         # deploy pipeline worker only
npm run deploy:internal         # deploy internal KB worker only
npm run deploy:images           # deploy image sync worker only
```

Per-worker dev:
```bash
cd workers/crawl && npx wrangler dev
cd workers/pipeline && npx wrangler dev
cd workers/internal && npx wrangler dev
cd workers/images && npx wrangler dev
```

Public site (Hugo):
```bash
npm run build:site              # fetch from R2 + hugo build
npm run dev:site                # hugo dev server (content must be fetched first)
cd public-kb && npm run fetch   # fetch content from R2 only
```

## Architecture

### Workers

| Worker | Path | Purpose |
|--------|------|---------|
| crawl | `workers/crawl/` | Weekly cron crawl via CF Browser Rendering API |
| pipeline | `workers/pipeline/` | Post-crawl processing: strip chrome, categorize, transform, write manifests |
| internal | `workers/internal/` | Internal KB site with admin UI, behind CF Access |
| images | `workers/images/` | Syncs images from upstream CDNs to R2 |

### Shared Code (`shared/`)

- `config.ts` — `SystemConfig` interface + `buildConfig(env)` factory
- `branding.ts` — `BrandingConfig` + `buildBrandingRules()` for parameterized brand replacement
- `categorization.ts` — URL categorization (public/internal/excluded)
- `transforms.ts` — Branding, URL, and link transforms. `transformMarkdown(md, config, branding)`
- `strip-chrome.ts` — Remove crawled navigation chrome from raw markdown
- `types.ts` — Shared interfaces (ArticleMeta, CrawlWebhookPayload, etc.)

### Public Site (`public-kb/`)

Hugo static site deployed to CF Pages. Fetches public articles from R2 at build time via `scripts/fetch-content.ts`. All branding configured via `HUGO_PARAMS_*` env vars (companyName, logoUrl, etc.). Build command: `npm run fetch && hugo --baseURL $KB_DOMAIN_URL`.

### Data Flow

```
crawl worker → R2 crawls/{date}/ → pipeline worker → R2 processed/
                                        ├── POST CF Pages deploy hook → public-kb (Hugo)
                                        └── POST images worker /sync
```

### R2 Key Structure

```
crawls/{date}/{en_US/path}/index.md     — raw crawled markdown
processed/{path}/index.md               — transformed markdown
processed/{path}/_meta.json             — article metadata
processed/_site-manifest.json           — all articles index
processed/_search-index.json            — search index
overrides/{path}/index.md               — admin-edited content
custom-articles/{slug}/index.md         — net-new articles
```

## Environment Variables

All deployment-specific values (domains, company names, account IDs, emails) are in `.dev.vars` files (local) and CF dashboard (production). Nothing identifying is committed. See `.dev.vars.example` in each worker directory and the root.

### Branding Variables

The system is designed to be white-labeled. Brand names are never hardcoded in shared code — they come from env vars:

- `BRAND_NAME` — company/brand name (replaces "OIT VoIP", standalone "OIT" in content)
- `CONNECT_NAME` — mobile/desktop app name (replaces "CloudieConnect" in content and slug display)
- `CONNECT_DESKTOP_NAME` — desktop variant name (replaces "CloudieConnect Desktop")
- `SITE_TITLE` — page title used in HTML templates (internal worker)

### Config Variables

- `KB_DOMAIN` — public KB domain
- `INTERNAL_KB_DOMAIN` — internal KB domain (behind CF Access)
- `IMAGE_DOMAIN` — image CDN domain (R2 public bucket)
- `MANAGER_PORTAL_URL` — manager portal URL for link rewriting
- `SOURCE_IMAGE_CDN` — upstream image CDN to rewrite (default: `cdn.elev.io`)

## Key Patterns

- Shared code uses `buildConfig(env)` and `buildBrandingConfig(env)` — no module-level constants with deployment-specific values
- Branding transforms are parameterized via `BrandingConfig` from env vars
- `wrangler.toml` files have placeholder values for `name`, `bucket_name`, and `pattern` — no real deployment values committed
- Workers import shared code via relative paths (`../../../shared/`)
- `buildBreadcrumb(path, branding)` — pass branding so CloudieConnect slug variants display correctly

## Planning

- When asked to plan: output only the plan. No code until told to proceed.
- When given a plan: follow it exactly. Flag real problems and wait.

## Code Quality

- Write code that reads like a human wrote it. No robotic comment blocks.
- Default to no comments. Only comment when the WHY is non-obvious.
- Simple and correct beats elaborate and speculative.
