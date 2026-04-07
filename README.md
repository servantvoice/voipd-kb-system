# KB System

A white-label knowledge base system that crawls an upstream documentation site, transforms the content (rebranding, URL rewriting, categorization), and serves it via Cloudflare Workers + R2.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌─────────┐
│ crawl worker │────>│   pipeline   │────>│   R2    │
│ (weekly cron)│     │   worker     │     │ bucket  │
└──────────────┘     └──────┬───────┘     └────┬────┘
                            │                  │
                    ┌───────┴────────┐    ┌────┴────────┐
                    │                │    │             │
               ┌────▼───┐    ┌──────▼┐   │  internal   │
               │ images │    │ Pages │   │   worker    │
               │ worker │    │ deploy│   │  (admin UI) │
               └────────┘    └───────┘   └─────────────┘
```

**Four Cloudflare Workers + a Hugo public site in one monorepo:**

| Component | Purpose |
|-----------|---------|
| `workers/crawl/` | Weekly crawl of upstream docs via CF Browser Rendering API |
| `workers/pipeline/` | Post-crawl processing: strip nav chrome, categorize, rebrand, build manifests |
| `workers/internal/` | Internal KB site with admin UI (behind CF Access) |
| `workers/images/` | Sync images from upstream CDNs to R2 for self-hosting |
| `public-kb/` | Hugo static site for the public KB, deployed to CF Pages |
| `shared/` | Categorization rules, branding transforms, configuration — imported by all workers |

## Prerequisites

- **Cloudflare account** with Workers Paid plan ($5/month) — required for Workflows
- **Domain managed by Cloudflare DNS** — required for custom domains and CF Access
- **Node.js 18+**, npm, git
- **Wrangler CLI** — `npm install -g wrangler`
- **Hugo** — for local public site development

See [docs/deployment-guide.md](docs/deployment-guide.md) for full details on prerequisites.

## Quick Start

```bash
git clone <this-repo>
cd voipd-kb-system
npm install && cd public-kb && npm install && cd ..
```

### 1. Edit wrangler.toml placeholders

Each worker's `wrangler.toml` has placeholder values for `name`, `bucket_name`, and (for internal) `pattern`. Edit these to match your deployment.

### 2. Configure environment variables

All deployment-specific values (domains, branding, emails, API tokens) live in a single `.env.private` file:

```bash
cp .env.example .env.private
# Edit .env.private with your values
bash scripts/setup-env.sh        # distributes to each worker's .dev.vars
```

### 3. Deploy workers

```bash
export CLOUDFLARE_ACCOUNT_ID=your-account-id
npm run deploy:all               # deploys images, pipeline, internal, crawl (in order)
bash scripts/push-vars.sh        # pushes all vars to Cloudflare via wrangler secret bulk
```

### 4. Set up CF Pages

Create a CF Pages project connected to this repo with root directory `public-kb/`. Set the R2 credentials and Hugo branding vars in the Pages environment. See [step 7 in the deployment guide](docs/deployment-guide.md#7-public-site-cf-pages).

### 5. Test

```bash
curl -X POST https://your-crawl-worker.workers.dev/crawl \
  -H "X-Crawl-Secret: your-secret" \
  -H "Content-Type: application/json"
```

## Configuration

All deployment-specific values live in environment variables, not in committed files. No domain names, company names, account IDs, or email addresses in the codebase.

**Single source of truth:** `.env.private` (gitignored) contains all variables for all workers and the Hugo site. Two scripts manage distribution:

| Script | Purpose |
|--------|---------|
| `bash scripts/setup-env.sh` | Reads `.env.private`, writes the correct subset to each worker's `.dev.vars` and `public-kb/.dev.vars` |
| `bash scripts/push-vars.sh` | Pushes all vars to Cloudflare Workers via `wrangler secret bulk` |
| `bash scripts/push-vars.sh crawl` | Push to a single worker only |

CF Pages variables must be set in the CF dashboard manually (Wrangler doesn't support Pages).

## Email Notifications

The pipeline worker sends a completion email after each crawl. Two providers are supported:

- **Postmark** — Set `POSTMARK_API_TOKEN` and optionally `POSTMARK_MESSAGE_STREAM` (defaults to `outbound`)
- **Resend** — Set `RESEND_API_KEY`

Both require `NOTIFICATION_TO` and `NOTIFICATION_FROM` (sender/recipient email addresses). Either provider works — the pipeline does a single HTTP POST per run.

## Public Site (Hugo)

The `public-kb/` directory contains a Hugo static site deployed to CF Pages. It fetches public articles from R2 at build time and generates a static site. The pipeline worker triggers a Pages rebuild after each crawl run via a deploy hook.

All branding is configured via `HUGO_PARAMS_*` environment variables in the CF Pages project (company name, logo URL, portal links, etc.).

## Content Control

Categorization rules, branding transforms, and the article override system are documented in [docs/content-control.md](docs/content-control.md). This covers:

- How `shared/categorization.ts` controls what gets crawled and whether articles are public or internal
- How `shared/transforms.ts` rewrites branding, URLs, and links
- How to use the admin UI to override individual article content or metadata
- How overrides are stored in R2 and survive re-crawls

Open content-review items (articles needing manual edits, override candidates, public/internal reclassification) are tracked in [ROADMAP.md](ROADMAP.md).

### Seeding category overrides

`scripts/category-overrides-starter.json` contains a ready-to-use category structure (498 articles organized into compact display categories). Run the apply script after deploying to seed your bucket:

```bash
bash scripts/apply-category-overrides.sh --dry-run   # preview
bash scripts/apply-category-overrides.sh             # upload
```

Then trigger a pipeline run to apply the overrides to `processed/` and rebuild the site manifests.

## Deployment Guide

See [docs/deployment-guide.md](docs/deployment-guide.md) for the comprehensive from-scratch setup guide including all prerequisites, worker deployment, CF Pages setup, DNS, CF Access, email API, and cutover from an existing system.

## Roadmap & Open Items

[ROADMAP.md](ROADMAP.md) tracks open content-review items, planned feature enhancements (callout styling, floating TOC, link checker, override editor improvements), and the changelog of completed pipeline fixes.
