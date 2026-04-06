# Deployment Guide

Complete from-scratch setup for deploying the KB system with no prior Cloudflare Workers experience.

## Prerequisites

### Cloudflare account with Workers Paid plan ($5/month)

The free Workers plan does **not** support Workflows (the durable multi-step execution used by the crawl and pipeline workers). You need the **Workers Paid** plan at $5/month, which includes:
- Workflows (required)
- R2 storage (10 GB free, then $0.015/GB/month)
- Workers with 30-second CPU time per invocation

### Domain managed by Cloudflare DNS

Your domain's DNS must be hosted on Cloudflare (nameservers pointed to CF). This is required for:
- **Custom domains** on the internal KB worker and image CDN
- **Cloudflare Access** (Zero Trust) to protect the internal KB behind SSO
- **R2 public access** with a custom domain for serving cached images

If you don't already have a domain on CF, you can add one for free — Cloudflare provides free DNS hosting and proxy.

### Cloudflare Access (Zero Trust)

The internal KB worker serves all articles (including internal/admin-only content) and must be protected. Cloudflare Access provides SSO-gated access using your identity provider (Microsoft Entra ID, Google Workspace, or simple email OTP). CF Access is free for up to 50 users on the Zero Trust free plan.

### Hugo

The public site requires [Hugo](https://gohugo.io/installation/) (the static site generator). Install it locally for development. CF Pages provides Hugo in its build environment automatically.

### Development tools

- **Node.js 18+** and npm
- **Wrangler CLI** — `npm install -g wrangler` then `wrangler login`
- **Git**

---

## 1. R2 Bucket Setup

Create two R2 buckets in the CF dashboard (Storage & Databases > R2):

1. **KB content bucket** — Stores crawled and processed articles
2. **Images bucket** — Stores cached images from upstream CDNs

For the images bucket, enable **Public Access** with a custom domain (e.g., `images.yourdomain.com`). This serves images directly from R2 without going through a Worker.

Also create an **R2 API token** (R2 > Manage R2 API Tokens > Create API Token) with read access to the KB content bucket. The public site's build script uses this to fetch articles. Save the Access Key ID and Secret Access Key — you'll need them for the CF Pages environment.

## 2. Clone and Install

```bash
git clone <this-repo>
cd voipd-kb-system
npm install
cd public-kb && npm install && cd ..
```

## 3. Configure Workers

### 3a. Edit wrangler.toml files

Each worker has a `wrangler.toml` with placeholder values. Edit these:

| Worker | File | Fields to change |
|--------|------|-----------------|
| crawl | `workers/crawl/wrangler.toml` | `name`, `bucket_name` |
| pipeline | `workers/pipeline/wrangler.toml` | `name`, `bucket_name` |
| internal | `workers/internal/wrangler.toml` | `name`, `bucket_name`, `pattern` (route domain) |
| images | `workers/images/wrangler.toml` | `name`, both `bucket_name` entries |

### 3b. Set up environment variables

The easiest way to configure all workers at once is with the master env file:

```bash
cp .env.example .env.private
```

Edit `.env.private` with your actual values (domains, branding, admin emails, API tokens, etc.). The file is organized by category with comments explaining each variable.

Then run the setup script to distribute variables to each worker's `.dev.vars`:

```bash
bash scripts/setup-env.sh
```

This reads `.env.private` and writes the correct subset of variables to each worker's `.dev.vars` and to `public-kb/.dev.vars`. You only maintain one file.

**Alternatively**, you can copy `.dev.vars.example` to `.dev.vars` in each directory and edit them individually.

Key variables:

| Variable | Example | Used by |
|----------|---------|---------|
| `KB_DOMAIN` | `docs.yourdomain.com` | pipeline, internal |
| `INTERNAL_KB_DOMAIN` | `internal.yourdomain.com` | internal |
| `IMAGE_DOMAIN` | `images.yourdomain.com` | pipeline, images |
| `BRAND_NAME` | `Your Company` | pipeline, internal |
| `CONNECT_NAME` | `Your App Connect` | pipeline |
| `ADMIN_EMAILS` | `["admin@example.com"]` | internal |
| `NOTIFICATION_TO` | `admin@example.com` | pipeline |
| `NOTIFICATION_FROM` | `noreply@yourdomain.com` | pipeline |
| `PIPELINE_URL` | `https://your-pipeline-worker.workers.dev` | crawl |
| `PAGES_DEPLOY_HOOK` | CF Pages webhook URL (created in step 7c) | pipeline |
| `IMAGE_SYNC_URL` | `https://your-images-worker.workers.dev/sync` | pipeline |

### 3c. Set Cloudflare Account ID

```bash
export CLOUDFLARE_ACCOUNT_ID=your-account-id
```

Or omit this and Wrangler will prompt you to select an account.

## 4. Deploy Workers

Deploy in this order (dependencies flow left to right):

```bash
npm run deploy:all
```

This runs: `deploy:images` > `deploy:pipeline` > `deploy:internal` > `deploy:crawl`.

Or deploy individually:
```bash
npm run deploy:images      # no dependencies
npm run deploy:pipeline    # needs R2 bucket
npm run deploy:internal    # needs R2 bucket
npm run deploy:crawl       # needs pipeline URL
```

## 5. Push Environment Variables to Cloudflare

After deploying, update the inter-worker URLs in `.env.private` now that you know the worker names:
- `PIPELINE_URL` — `https://<your-pipeline-worker>.workers.dev` (set on crawl worker, tells it where to POST after crawl)
- `IMAGE_SYNC_URL` — `https://<your-images-worker>.workers.dev/sync` (set on pipeline worker, triggers image sync)

Then distribute and push all variables (including secrets) to Cloudflare:

```bash
bash scripts/setup-env.sh    # distributes .env.private to each worker's .dev.vars
bash scripts/push-vars.sh    # pushes all vars to CF via wrangler secret bulk
```

The push script uploads each worker's `.dev.vars` file using `wrangler secret bulk`, which stores all values encrypted. You can also push to a single worker:

```bash
bash scripts/push-vars.sh crawl       # push to crawl worker only
bash scripts/push-vars.sh pipeline    # push to pipeline worker only
bash scripts/push-vars.sh internal    # push to internal worker only
bash scripts/push-vars.sh images      # push to images worker only
```

**CF Pages variables** (HUGO_*, R2_*, KB_DOMAIN_URL) must be set manually in the CF Pages dashboard — Wrangler does not support pushing variables to Pages projects.

<details>
<summary>Manual alternative (without scripts)</summary>

If you prefer not to use the scripts, you can set variables individually:

```bash
# Per-worker secrets
cd workers/crawl && npx wrangler secret put CRAWL_SECRET
cd workers/crawl && npx wrangler secret put CF_API_TOKEN
cd workers/pipeline && npx wrangler secret put CRAWL_SECRET
cd workers/pipeline && npx wrangler secret put POSTMARK_API_TOKEN
cd workers/internal && npx wrangler secret put CRAWL_SECRET
cd workers/images && npx wrangler secret put CRAWL_SECRET
```

Or set all variables for a worker at once from a JSON file:
```bash
cd workers/crawl && npx wrangler secret bulk .dev.vars
```

Non-secret variables can also be set via the CF dashboard (Workers & Pages > worker > Settings > Variables).
</details>

## 7. Public Site (CF Pages)

The `public-kb/` directory contains a Hugo site that fetches public articles from R2 at build time.

### 7a. Create CF Pages project

1. Go to Workers & Pages > Create > Pages > Connect to Git
2. Select this repository
3. Set **Root directory** to `public-kb/`
4. Set **Build command** to `npm run build`
5. Set **Build output directory** to `public`
6. Set **Framework preset** to None

### 7b. Set Pages environment variables

In the Pages project settings (Settings > Environment variables), add:

**R2 credentials** (from the API token created in step 1):
- `R2_ACCESS_KEY_ID` — your R2 API token access key
- `R2_SECRET_ACCESS_KEY` — your R2 API token secret (encrypt this)
- `R2_ENDPOINT` — `https://<your-account-id>.r2.cloudflarestorage.com`
- `R2_BUCKET` — your KB content bucket name

**Hugo branding** (these map to Hugo's `.Site.Params`):
- `KB_DOMAIN_URL` — your public KB URL (e.g., `https://docs.yourdomain.com/`)
- `HUGO_TITLE` — site title (e.g., `Your Company Documentation`)
- `HUGO_PARAMS_DESCRIPTION` — site description
- `HUGO_PARAMS_COMPANYNAME` — your company name
- `HUGO_PARAMS_COMPANYURL` — your company website URL
- `HUGO_PARAMS_LOGOURL` — URL to your logo image
- `HUGO_PARAMS_MANAGERPORTALURL` — manager portal URL (nav link)
- `HUGO_PARAMS_BILLINGPORTALURL` — billing portal URL (nav link)
- `HUGO_PARAMS_STATUSURL` — status page URL (nav link)
- `HUGO_PARAMS_INTERNALKBURL` — internal KB URL (if you link between sites)

### 7c. Create deploy hook

1. In Pages project settings > Builds & Deployments > Deploy hooks
2. Create a hook (name it anything, e.g., "pipeline-trigger")
3. Copy the hook URL
4. Update `PAGES_DEPLOY_HOOK` in your `.env.private`, then push to the pipeline worker:
   ```bash
   bash scripts/setup-env.sh
   bash scripts/push-vars.sh pipeline
   ```

### 7d. Custom domain (optional)

In Pages project settings > Custom domains, add your public KB domain (e.g., `docs.yourdomain.com`).

### 7e. Favicon

When you have a favicon file, drop it into `public-kb/static/favicon.ico`. The HTML template already includes the `<link rel="icon">` tag — browsers handle a missing file gracefully.

### 7f. Remove noindex

The site ships with `<meta name="robots" content="noindex, nofollow">` to prevent indexing during setup. Remove this from `public-kb/layouts/_default/baseof.html` when you're ready to go public.

## 8. DNS and Custom Domains

### Internal KB domain

1. In CF DNS, add a CNAME record for your internal KB domain pointing to your worker
2. Or use the Workers route configured in `wrangler.toml`

**Note:** As soon as the custom domain is active, the internal KB will be reachable. The worker returns a 401 "Unauthorized" page to unauthenticated visitors (it won't expose article content), but the domain will be live. Configure CF Access (step 9) promptly after setting up the domain, or set up Access first if you prefer.

### Image CDN domain

Already configured via R2 Public Access (step 1).

### Public KB domain

Already configured via CF Pages custom domain (step 7d).

## 9. CF Access Setup

Protect the internal KB behind Cloudflare Access:

1. Go to Zero Trust > Access > Applications
2. Create a new application for your internal KB domain
3. Configure an Identity Provider:
   - **Microsoft Entra ID** — Best for organizations with Microsoft 365
   - **Google Workspace** — Alternative for Google-based orgs
   - **One-time PIN** — Simplest option (email-based, no IdP needed)
4. Set access policy: allow your organization's email domain

## 10. Email API Setup

The pipeline worker sends one email per crawl run with article counts.

### Option A: Postmark (recommended for existing users)

1. Create a Postmark account and server
2. Verify your sender domain (DNS records)
3. Get the Server API Token
4. Set `POSTMARK_API_TOKEN` in `.env.private`
5. Optionally set `POSTMARK_MESSAGE_STREAM` if you created a custom transactional stream (defaults to `outbound`)

**Pros:** Best deliverability, detailed bounce/spam tracking, webhook support

### Option B: Resend (simpler alternative)

1. Sign up at resend.com
2. Verify your sender domain
3. Get your API key
4. Set as `RESEND_API_KEY` secret

**Pros:** Simpler API, generous free tier (3,000 emails/month), good developer experience

Either works — the pipeline just does a single HTTP POST.

## 11. Wire Up Service Bindings (Optional)

For lower latency between workers in the same account, use service bindings instead of HTTP calls:

In `workers/crawl/wrangler.toml`, uncomment:
```toml
[[services]]
binding = "PIPELINE_WORKER"
service = "your-pipeline-worker-name"
```

This avoids the public internet hop. The crawl worker automatically prefers the service binding when available.

## 12. Test the Full Pipeline

1. **Manual crawl trigger:**
   ```bash
   curl -X POST https://your-crawl-worker.workers.dev/crawl \
     -H "X-Crawl-Secret: your-secret" \
     -H "Content-Type: application/json"
   ```

2. **Check crawl status:**
   ```bash
   curl https://your-crawl-worker.workers.dev/status/<instance-id>
   ```

3. **Verify R2 output:** Check the CF dashboard for `crawls/` and `processed/` keys

4. **Check public site:** Visit your public KB domain — articles should appear after the first crawl + pipeline run

5. **Check internal site:** Visit your internal KB domain

6. **Verify email:** Confirm the completion email arrived

7. **Check image sync:** Visit your image CDN domain

## 13. Cron Schedule

The crawl worker runs weekly (Sunday 2:00 AM UTC by default). Adjust in `workers/crawl/wrangler.toml`:

```toml
[triggers]
crons = ["0 2 * * SUN"]
```

---

## Cutover from Existing System

If you're migrating from the multi-repo + n8n setup, follow this checklist.

### Pre-cutover (no disruption — test alongside existing system)

1. [ ] Deploy new workers with different names alongside old ones (same R2 bucket)
2. [ ] Set all env vars and secrets on each new worker via CF dashboard
3. [ ] Set up CF Pages project for `public-kb/` with R2 credentials and Hugo env vars
4. [ ] Test new pipeline manually: `POST /process` with a recent `crawlDatePrefix`
5. [ ] Verify `processed/` output matches n8n output (diff in R2)
6. [ ] Verify email, Pages deploy hook, and image sync all trigger correctly
7. [ ] Test new internal worker on a test domain — verify rendering, search, admin UI

### Cutover (brief disruption window)

8. [ ] Update crawl worker to notify new pipeline (`PIPELINE_URL` env var)
9. [ ] Switch DNS for internal KB domain to point at new internal worker
10. [ ] Switch CF Pages project to use `voipd-kb-system` repo (if not already)
11. [ ] Trigger a manual crawl and verify the full pipeline end-to-end

### Post-cutover cleanup

12. [ ] Decommission n8n pipeline (disable or delete workflows)
13. [ ] Delete old workers (or leave idle — no cost if not invoked)
14. [ ] Archive old repos with READMEs pointing to the monorepo
15. [ ] Rotate `CRAWL_SECRET` (old value may be in n8n config or test files)
16. [ ] Remove `noindex` robots meta when ready to go public

---

## Troubleshooting

- **Wrangler can't find account:** Set `CLOUDFLARE_ACCOUNT_ID` env var
- **R2 bucket errors:** Verify bucket names in `wrangler.toml` match actual R2 buckets
- **Auth failures between workers:** Ensure all workers share the same `CRAWL_SECRET`
- **Email not sending:** Check the API token is set as a secret, not a plain variable
- **Pipeline not triggered:** Check the crawl worker has `PIPELINE_URL` or service binding configured
- **Pages build fails:** Check R2 credentials are set in Pages environment variables, not Worker variables
- **Hugo site shows no articles:** The fetch script only runs at build time — trigger a Pages rebuild after the pipeline processes articles
- **Hugo env vars not working:** Hugo env var names are case-sensitive: `HUGO_PARAMS_COMPANYNAME` (all caps for the prefix, then the param name)
