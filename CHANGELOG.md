# Changelog

All notable changes to the `voipd-kb-system` monorepo are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are date-based (`YYYY-MM-DD`) since the system is deployed continuously rather than versioned releases.

## [Unreleased]

### Added
- **Vendor email/domain swaps in `transformMarkdown`.** `support@oit.co` is replaced with the bare word `support`; standalone `oit.co` and `oitvoip.com` mentions are rewritten to `BRAND_DOMAIN` (new env var on the pipeline worker). Order matters: the email rule runs before the domain rule so the email's domain isn't rewritten before the email pattern can match.
- `BRAND_DOMAIN` env var added to `SystemConfig` (`shared/config.ts`), `.env.private`, `workers/pipeline/.dev.vars{,.example}`, and `scripts/setup-env.sh` distribution.

### Fixed
- `workers/internal/src/admin.ts` `handlePostOverride` (override editor save) now (1) writes `processed/{slug}/_meta.json` in addition to `index.md`, (2) calls `updateSiteManifest` so Hugo's `category === "public"` filter sees the new state, and (3) fires `PAGES_DEPLOY_HOOK` whenever the article was or is public — covering public→internal transitions where the public site needs to drop the article. Previously, saving an override never triggered a Pages rebuild and never updated the manifest, so category changes silently stayed visible on the public site until the next weekly pipeline run.
- `handlePostOverride` and `handlePostEditMeta` now derive `wasPublic` from the live site manifest instead of `existingMeta.category`. Loading from `overrides/_meta.json` could be stale if a prior broken save corrupted that file without updating the manifest; reading the manifest is the right "what does the public site actually see today" signal so recovery saves still trigger the rebuild.
- `public-kb/scripts/fetch-content.ts` now wipes `content/articles/` before writing. CF Pages preserves gitignored directories as a build cache between deployments, so articles whose category flipped public→internal (or were deleted) would otherwise be carried over from a prior build's cached files and silently rebuilt by Hugo into the new deployment, even though the manifest correctly excluded them.

## [2026-04-19]

### Added
- **Review gate for newly-discovered crawl articles.** The pipeline compares each run's slugs against the previous `processed/_site-manifest.json` and marks unknown ones `status: "pending-review"` with a `firstSeen` date. Hugo fetch filters them out of the public build; internal KB shows a "Needs Review" banner with inline Approve button. New `/.admin/review` admin page groups pending items by category with Approve / Edit Metadata / Edit Content actions.
- `ArticleMeta.status` (`"pending-review" | "approved"`) and `ArticleMeta.firstSeen` in `shared/types.ts`. Override `_meta.json` may carry `status` so admin approvals persist across pipeline runs.
- **Failure notification emails.** Both crawl and pipeline workflow `run()` methods are wrapped in try/catch. On failure they send a one-shot email with the error stack before re-throwing. Crawl calls `POST /notify` on the pipeline worker via service binding (no new secrets on the crawl worker).
- `shared/email.ts` centralizes Postmark / Resend dispatch so both workers reuse one implementation.
- Pipeline notification email now reports pending-review count, lists newly-pending slugs (up to 20), and links to the internal KB review queue.
- `scripts/regenerate-starter.sh` rebuilds `category-overrides-starter.json` from the live R2 site manifest in a single network call. Meant for re-baselining the fresh-onboarding starter JSON, not a deploy step.

### Changed
- Regenerated `scripts/category-overrides-starter.json` (504 entries) from live R2. Previous starter had stale entries (e.g. `talent-lms-course-requirements` marked public) that would have silently reverted admin overrides if the apply script was ever re-run.
- `scripts/apply-category-overrides.sh` now refuses to run against a populated deployment without `--force`, and the header explicitly warns it is fresh-onboarding priming only.

### Fixed
- `workers/internal/src/admin.ts` `handlePostOverride` (content editor) no longer wipes `displayCategory`, `breadcrumb`, `sourceUrl`, `lastCrawled`, or `status` from `_meta.json` when saving. Previously, using the content editor after setting custom metadata via the metadata editor reverted the metadata on the next pipeline run.
- `handlePostEditMeta` and `handlePostOverride` both now set `status: "approved"` on save — explicit admin action = approval.
- `scripts/apply-category-overrides.sh` and `scripts/regenerate-starter.sh` use macOS-compatible `mktemp -t` templates; the previous `mktemp /tmp/foo-XXXXXX.json` pattern returned the literal path on macOS and caused "File exists" errors on repeat runs.
- Crawl workflow `runInner()` defaults `event.payload` to `{}` so manual `wrangler workflows trigger` (which passes no params) doesn't NPE on `params.url`.

## [2026-04-07]

### Added
- **Callout styling for Scope / Requirements / Troubleshooting sections.** `wrapCallouts()` in `shared/transforms.ts` wraps those headings in `<div class="callout callout-{scope,req,warn}">` blocks; matching CSS in Hugo and internal worker templates (rounded borders, colored backgrounds).
- `scripts/category-overrides-starter.json` and `scripts/apply-category-overrides.sh` for priming overrides on a fresh deployment.
- `CRAWL_PAGE_LIMIT` and `CRAWL_MAX_AGE_SECONDS` env vars for crawl worker tuning; pipeline detects and warns on crawl truncation in manifest and notification email.
- `ROADMAP.md` capturing open content-review items, feature ideas, and a running changelog of completed pipeline fixes.

### Changed
- **Crawl worker restructured to a single 6-step workflow.** Previously batched URLs in groups of 50 with separate `step.do()` loops per batch, hitting CF Workflows' ~512 step limit at 438+ steps. Now uses a single CF Browser Rendering `/crawl` job with `source: "sitemaps"` (up to 100k pages per job). Total runtime cut from 30–60 min to ~5 min.
- **Pipeline image sync flow is now fire-and-forget.** Pipeline no longer blocks for up to 2 min on the image sync HTTP response. It triggers sync, then reads sync stats from the R2 log file in a separate `notify-email` step (3 min initial wait + up to 3×1 min retries). Images worker always writes a result log to R2 (not only on failure) so pipeline can reliably read stats.
- Slug display-name humanization (`OneBill`, `SNAPbuilder`, `TeamMate`, `UC`, `VoIPMonitor`, `CDRs`, `NDP`, `SIP`, `PBX`, `mFax`, `Hardware & Software`, `Caller ID`, `API`, `Local & Toll Free Porting`) applied in internal and public breadcrumb builders for consistency.

### Fixed
- **Image sync reverse-mapping for helpjuice.** `imgdocs/helpjuice_production/...` URLs were being mapped back to `cdn.elev.io` (the primary source) instead of `static.helpjuice.com` because both sources had empty `pathPrefix`. Added optional `pathSignature` field to `ImageSource`; helpjuice paths are now disambiguated by the `helpjuice_production` signature. Resolved ~568 403 failures per sync.
- **Image sync missing slash separator for clickup URLs.** Reverse-mapped URLs like `t24555569.p.clickup-attachments.comt24555569/...` (malformed — missing `/`) now reconstruct correctly.
- **Feedback-footer stripping in crawled markdown** (`shared/strip-chrome.ts`). Upstream feedback blocks no longer bleed into article content.
- Branding transforms made safer — narrower regex anchors to avoid rewriting partial matches inside URLs or code spans.

## [2026-04-06] — Initial Release

First deployment of the Cloudflare-Workers-based KB system. Supersedes the previous n8n-based pipeline.

### Added
- **Monorepo layout** under `voipd-kb-system/` with 4 Cloudflare Workers (`crawl`, `pipeline`, `internal`, `images`), a Hugo public site (`public-kb/`), and shared TypeScript code (`shared/`).
- **Crawl worker** — weekly `0 2 * * SUN` UTC cron triggers a workflow that fetches the sitemap, submits a CF Browser Rendering batch crawl, polls for completion, and writes raw markdown to `crawls/{date}/{path}/index.md`. Webhook-triggers the pipeline on completion via service binding.
- **Pipeline worker** — strips page chrome, applies branding transforms, categorizes URLs as `public | internal | excluded` from hardcoded pattern lists (`shared/categorization.ts`), merges admin overrides from `overrides/`, writes `processed/{path}/{index.md, _meta.json}` and the aggregate `processed/{_site-manifest.json, _search-index.json}`. Fires the CF Pages deploy hook and the images worker. Sends a completion email via Postmark or Resend.
- **Internal worker** — serves `staffdocs.*` behind Cloudflare Access (Entra ID SSO). Renders all articles (public + internal), provides an admin UI for override content, override metadata, custom articles, editor-submission approval queue, and delete flows. Admin writes go to `overrides/` and `custom-articles/`; editor writes go to `editorial/pending/` for review.
- **Images worker** — mirrors image assets from upstream CDNs (elev.io, helpjuice, clickup, imgur, etc.) to R2 under `images/`, rewriting article image links to the local CDN.
- **Hugo public site (`public-kb/`)** — fetches public articles from R2 at build time via `scripts/fetch-content.ts`, generates static site. All branding parameterized via `HUGO_PARAMS_*` env vars. Deployed to CF Pages with auto-rebuild via deploy hook.
- **Shared code (`shared/`)** — `config.ts` (SystemConfig + R2 prefixes), `branding.ts` (BrandingConfig with env-driven names), `categorization.ts` (URL categorization rules), `transforms.ts` (branding / URL / link rewriting + `wrapCallouts`), `strip-chrome.ts` (crawl chrome removal), `types.ts` (ArticleMeta, CrawlWebhookPayload, etc.).
- **Deployment automation** — `scripts/setup-env.sh` interactively creates `.dev.vars` files from examples; `scripts/push-vars.sh` pushes env vars and secrets to CF via `wrangler secret bulk`. `docs/deployment-guide.md` walks through fork → deploy from scratch.
- **White-labeling** — every brand-specific value (`BRAND_NAME`, `CONNECT_NAME`, `CONNECT_DESKTOP_NAME`, `SITE_TITLE`, `KB_DOMAIN`, `INTERNAL_KB_DOMAIN`, `IMAGE_DOMAIN`, `MANAGER_PORTAL_URL`, `SOURCE_IMAGE_CDN`) lives in env vars or `.dev.vars`; none committed to code.
- **Service binding** from crawl → pipeline (lower latency than HTTP, same-account); `PIPELINE_URL` HTTP fallback documented.
- **Email notifications** via Postmark (`POSTMARK_API_TOKEN`, `POSTMARK_MESSAGE_STREAM`) or Resend (`RESEND_API_KEY`) — pick one.

### Fixed
- **Image URL corruption in crawled markdown.** CF Browser Rendering wrapped images in `_` emphasis (`_![](url)_`), consuming underscores from URL hashes. Crawl worker now strips `_` emphasis wrapping from images before writing to R2.
- **"Manager Portal" link injection** — transform rule links bare "Manager Portal" text in article content to the `MANAGER_PORTAL_URL`.
- **CF email-obfuscation artifacts** (`[email protected]`, `cdn-cgi/l/email-protection` links) — linked variants rewrite to "*[see original article for email address](sourceUrl)*"; bare text variants rewrite to "*(email address — see original article)*".
- **Voicemail category page** — Hugo template fixed to use `.Page.RelPermalink`; `transcriptio → transcription` typo corrected in `shared/categorization.ts`.
- **Blank article `voicemail/enable-voicemail-transcription`** — `shared/strip-chrome.ts` updated to detect `[+ More](#)` as the nav-end marker and accept bold text / any heading level as the content-start marker (the article starts with `**bold**` text, not a heading).
- URL cruft stripping in `shared/transforms.ts` (`?from_search`, `/version/1`, `?kb_language`, etc.).

### Removed
- n8n webhook configuration from the crawl worker (`N8N_WEBHOOK_URL` env var) — replaced by the pipeline service binding.
