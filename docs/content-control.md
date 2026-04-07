# Content Control Guide

This guide covers the three layers that control what gets crawled, how it's categorized, and how content and metadata can be overridden.

---

## Overview

Content control works in three layers, applied in order:

| Layer | Where | Effect |
|-------|-------|--------|
| Categorization rules | `shared/categorization.ts` | Determines public/internal/excluded at crawl and pipeline time |
| Branding & transform rules | `shared/transforms.ts` + `shared/branding.ts` | Rewrites content: brand names, URLs, links, typos |
| Overrides | R2 `overrides/` prefix or admin UI | Replaces content or metadata for specific articles |

---

## Categorization Rules

**File:** `shared/categorization.ts`

This file is the single source of truth for what gets crawled and how articles are categorized. Both the crawl worker and the pipeline worker import from it directly — there is no manual sync step.

### Three Outcomes

- **`excluded`** — article is skipped at crawl time entirely; never stored in R2
- **`internal`** — stored and served on the internal KB only (behind CF Access)
- **`public`** — stored and published to both the internal and public KB

### Priority Chain

Rules are evaluated in this order, stopping at the first match:

1. **`PUBLIC_OVERRIDES`** — exact paths that stay public despite matching an internal rule  
   Example: `/integrations/url-call-popup` is public even though `/integrations/` is an internal prefix

2. **`EXCLUDE_PREFIXES`** — path prefixes that exclude articles entirely  
   Example: `/datagate/`, `/snaphd/`, `/billing-administration/`  
   Articles matching these are never crawled or stored.

3. **`INTERNAL_EXACT_PATHS`** — specific full paths that are internal  
   Used when only certain articles in a section are internal (e.g., specific `/faqs/`, `/native-fax/`, `/e-911/` paths)

4. **`INTERNAL_PREFIXES`** — path prefixes where all articles are internal  
   Example: `/release-notes/`, `/sip-trunking/`, `/troubleshooting/`, `/integrations/`

5. **Pattern matching** — paths containing `partner` or matching `/snapmobile/.*-release-notes` are internal

6. **Default** — everything else is public

### How to Add Rules

**Exclude an entire section** (stop crawling it):
```typescript
export const EXCLUDE_PREFIXES = [
  // existing...
  "/new-section-to-ignore/",
];
```

**Mark a section as internal**:
```typescript
export const INTERNAL_PREFIXES = [
  // existing...
  "/partner-tools/",
];
```

**Mark specific articles as internal within a public section**:
```typescript
export const INTERNAL_EXACT_PATHS = [
  // existing...
  "/features/some-admin-only-feature",
];
```

**Force a path public despite matching an internal prefix**:
```typescript
export const PUBLIC_OVERRIDES = [
  // existing...
  "/integrations/some-customer-facing-tool",
];
```

After changing `categorization.ts`, redeploy the crawl and pipeline workers (`npm run deploy:crawl` and `npm run deploy:pipeline`) and re-run the pipeline to reprocess existing content.

---

## Branding & Content Transforms

**Files:** `shared/transforms.ts`, `shared/branding.ts`

The pipeline worker applies a series of transforms to every article — both crawled content and override content — before writing it to `processed/`. The crawl worker does not apply transforms.

### Transform Pipeline (in order)

1. **Corrupted image URL fixes** — repairs specific hashes corrupted by the crawl process
2. **Image CDN rewriting** — rewrites upstream CDN URLs to the deployment's image domain
3. **URL replacements** — rewrites `voipdocs.io/en_US/` links to `/articles/`, bare domain refs to the KB domain
4. **Manager Portal links** — replaces `manage.oitvoip.com` with the configured portal URL
5. **URL cruft stripping** — removes `?from_search=NNN`, `/version/N`, `?kb_language=en_US`, etc.
6. **Relative link normalization** — converts `/en_US/` relative links to `/articles/`
7. **Legacy slug redirects** — remaps old Helpjuice numeric slugs to current paths
8. **Excluded content links** — removes hyperlinks to excluded paths (keeps display text)
9. **Typo corrections** — fixes known typos in upstream content (e.g., "Requirments")
10. **Platform text cleanup** — strips upstream platform artifacts (e.g., `(helpjuice.com)`)
11. **Branding replacements** — replaces upstream vendor names with your brand (see below)
12. **CF email obfuscation** — replaces protected email links with a note pointing to the original article
13. **Manager Portal text linking** — turns plain-text "Manager Portal" into a hyperlink
14. **Callout wrapping** — wraps `Scope`, `Requirements`, and `Troubleshooting` sections in styled divs

### Branding Replacements

Branding rules are in `shared/branding.ts`, parameterized from environment variables:

| Env var | Purpose |
|---------|---------|
| `BRAND_NAME` | Replaces "OIT VoIP", "OITVoIP", standalone "OIT" |
| `CONNECT_NAME` | Replaces "CloudieConnect", "Cloudie Connect" |
| `CONNECT_DESKTOP_NAME` | Replaces "CloudieConnect Desktop" |

To add a new brand replacement, add a rule to `buildBrandingRules()` in `shared/branding.ts`:

```typescript
{
  pattern: /UpstreamProductName/gi,
  replacement: branding.brandName,
  description: "UpstreamProductName → brand name",
},
```

Order matters — more specific patterns must come before more general ones.

### Other Transform Changes

**Add a URL rewrite** — add to `URL_CRUFT_RULES` or inline in `transformMarkdown()`:
```typescript
{ pattern: /\?old-param=\d+/gi, replacement: "", description: "Strip old query param" },
```

**Add a typo correction** — add to `TYPO_RULES`:
```typescript
{ pattern: /\bMisspelledWord\b/g, replacement: "CorrectWord", description: "Fix typo" },
```

After changing transforms, redeploy the pipeline worker and re-run the pipeline to reprocess all articles.

---

## Overrides via the Admin UI

Overrides let you change the content or metadata of individual articles without modifying the crawl pipeline or categorization rules. They survive re-crawls — the pipeline always checks for overrides before processing raw content.

### Two Types of Override

**Metadata override** — change category, title, or display category without touching the content:
- Navigate to the article on the internal KB
- Click **Edit Metadata**
- Update title, display category, or visibility (public/internal)
- Save

**Content override** — replace the full article text with edited markdown:
- Navigate to the article on the internal KB
- Click **Edit Content**
- Edit the markdown in the editor
- Save

### Admin vs. Editor Roles

- **Admin** — changes are written directly to R2 and take effect immediately
- **Editor** — changes are submitted to a pending queue for admin review

Admins can review pending submissions from the **Pending Review** section of the admin UI. Each pending item shows a preview; admins can approve (publishes it) or reject (discards it).

---

## How Overrides Work in R2

When you save an override via the admin UI, two R2 keys are written:

```
overrides/{slug}/index.md        optional — replaces crawled markdown
overrides/{slug}/_meta.json      optional — overrides category/title/displayCategory/breadcrumb
```

### Pipeline Merge Logic

On each pipeline run, for each article:

1. **Content**: if `overrides/{slug}/index.md` exists, it replaces the raw crawled markdown. Transforms are still applied to override content.
2. **Metadata**: if `overrides/{slug}/_meta.json` exists, its `category`, `title`, `displayCategory`, and `breadcrumb` fields are merged over the auto-derived values.
3. `isOverride: true` is set in `processed/{slug}/_meta.json` when either override file exists.

### Persistence

The `overrides/` prefix is never touched by the crawl or pipeline — it is only written by admin actions and the apply-overrides script. `processed/` is always rewritten by the pipeline, but it reads `overrides/` first, so metadata edits and content overrides persist through every re-crawl.

### Minimal `_meta.json` Shape

A metadata-only override file needs only the fields you want to change:

```json
{
  "slug": "phone-system-features/call-recording",
  "category": "public",
  "displayCategory": "Phone System Features",
  "breadcrumb": ["Phone System Features", "Call Recording"]
}
```

---

## Bulk / Programmatic Overrides

For large-scale category restructuring — or seeding a fresh bucket with a known-good category layout — use the starter package in `scripts/`.

### `scripts/category-overrides-starter.json`

A snapshot of the category structure (498 articles) with each article's `category`, `displayCategory`, and `breadcrumb`. This captures the restructure from 50+ raw VoIPDocs section names down to a smaller set of display categories.

Use it as a starting point: edit the JSON to match your own category taxonomy, then apply it.

### `scripts/apply-category-overrides.sh`

Reads `category-overrides-starter.json` and uploads a `_meta.json` to `overrides/{slug}/` for each entry via wrangler.

```bash
# Dry run — prints paths without uploading
./scripts/apply-category-overrides.sh --dry-run

# Apply to your R2 bucket
./scripts/apply-category-overrides.sh
```

Requires wrangler to be authenticated (`npx wrangler whoami` should show your account). After running, trigger a pipeline run to have the new metadata applied to `processed/` and the site manifests rebuilt.
