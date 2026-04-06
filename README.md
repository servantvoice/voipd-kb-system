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

## Quick Start

```bash
git clone <this-repo>
cd sv-kb-system
npm install && cd public-kb && npm install && cd ..

# 1. Edit wrangler.toml in each worker:
#    Change `name`, `bucket_name`, and `pattern` placeholders

# 2. Configure all environment variables from one file:
cp .env.example .env.private
# Edit .env.private with your values (domains, branding, emails, etc.)
bash scripts/setup-env.sh    # distributes to each worker's .dev.vars

# 3. Set CLOUDFLARE_ACCOUNT_ID (or let Wrangler prompt)
export CLOUDFLARE_ACCOUNT_ID=your-account-id

# 4. Deploy workers and push env vars to Cloudflare
npm run deploy:images
npm run deploy:pipeline
npm run deploy:internal
npm run deploy:crawl
bash scripts/push-vars.sh --all   # push vars + secrets to CF
```

See [docs/deployment-guide.md](docs/deployment-guide.md) for the full from-scratch setup guide.

## Configuration

All deployment-specific values live in environment variables, not in committed files. This means the repo contains no domain names, company names, account IDs, or email addresses.

**Three places to configure:**

1. **`wrangler.toml`** — Edit `name`, `bucket_name`, and `pattern` placeholders (8 edits across 4 workers)
2. **`.dev.vars`** — All env vars for local development (gitignored)
3. **CF Dashboard** — Production env vars and secrets

See `.dev.vars.example` in each worker directory for the complete variable list.

## Email Notifications

The pipeline worker sends a completion email after each crawl. Two providers are supported:

- **Postmark** — Set `POSTMARK_API_TOKEN` secret
- **Resend** — Set `RESEND_API_KEY` secret

Either works — the pipeline does a single HTTP POST per run.

## Public Site (Hugo)

The `public-kb/` directory contains a Hugo static site deployed to CF Pages. It fetches public articles from R2 at build time and generates a static site. The pipeline worker triggers a Pages rebuild after each crawl run via a deploy hook.

See `public-kb/.dev.vars.example` for the required CF Pages environment variables (R2 credentials, Hugo branding vars, base URL).

## Deployment Guide

See [docs/deployment-guide.md](docs/deployment-guide.md) for the full from-scratch setup guide including all prerequisites, worker deployment, CF Pages setup, and cutover from an existing system.
