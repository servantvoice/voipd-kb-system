# Roadmap

Open content-review items, planned feature enhancements, and a changelog of completed pipeline fixes. Originally started as a content-review checklist on 2026-03-29.

## Contents

- [Roadmap](#roadmap)
  - [Contents](#contents)
  - [Articles to Review](#articles-to-review)
  - [Feature Enhancements](#feature-enhancements)
  - [Review: Public or Internal?](#review-public-or-internal)
- [Large-Scale Future Restructuring for Features and Possible Release](#large-scale-future-restructuring-for-features-and-possible-release)
  - [Open Source Release Considerations](#open-source-release-considerations)
  - [Override/Editorial System Improvements](#overrideeditorial-system-improvements)

## Articles to Review

- [ ] [native-fax/native-fax-send-a-fax-from-email](/articles/native-fax/native-fax-send-a-fax-from-email)
  - Fix obfuscated email address (CF email protection artifact)
  - Fix "niftywidget" placeholder text in content
  - Fix weird link at end of paragraph (angle-bracket self-reference stripped, but left duplicate paragraph of earlier article content as trailing text)
  - Make public after overrides are applied

- [ ] [local-toll-free-porting/port-in-your-existing-numbers](/articles/local-toll-free-porting/port-in-your-existing-numbers)
  - Needs override or a new custom article for Servant Voice clients (public-facing)
  - Current content is partner-focused — porting process and details differ for partner customers
  - Consider writing a separate public article with partner-specific porting instructions

- [ ] [e-911/remove-e911-number-from-manager-portal](/articles/e-911/remove-e911-number-from-manager-portal)
  - Review content and formatting

- [ ] [e-911/configure-notifications-for-e911-calling](/articles/e-911/configure-notifications-for-e911-calling)
  - Review content and formatting

- [ ] [faqs/getting-started-guide](/articles/faqs/getting-started-guide)
  - Review content and formatting

- [ ] [faqs/contacts-and-hours-of-operation](/articles/faqs/contacts-and-hours-of-operation)
  - Phone numbers and more — review/override with Servant Voice contact info

- [ ] [faqs/frequently-asked-questions](/articles/faqs/frequently-asked-questions)
  - Review and override some questions?

- [ ] [faqs/prohibited-and-limited-support-devices](/articles/faqs/prohibited-and-limited-support-devices)
  - Confusing answer to "Questions and Concerns" question

- [ ] [faqs/snapmobile-ios-35-release-notes](/articles/faqs/snapmobile-ios-35-release-notes)
  - Confirm version, remove VoIPDocs link (all of them, if any?), maybe make internal?

- [ ] [web-responders-overview](/articles/web-responders-overview)
  - PHP code samples are mangled in Markdown crawled format (bold markers interfere with code). Needs override with proper code blocks.

- [x] [sip-trunking/create-a-sip-trunk](/articles/sip-trunking/create-a-sip-trunk)
  - Override uploaded 2026-03-31: restored missing "Existing domain for client" requirement bullet, fixed query string cruft on links (`?from_search`, `/version/1`, `?kb_language`), fixed bare URL for E911 link, fixed "IP Contro" typo, converted all links to relative paths
  - Also added pipeline-level fix: URL cruft stripping rules in `shared/transforms.ts`

- [x] [teammate-connector/microsoft-domain-issues](/articles/teammate-connector/microsoft-domain-issues)
  - Override uploaded 2026-03-31: restored full article content (Scope, Requirements, Problem, Solution 1, Solution 2 with images)
  - Root cause: `shared/strip-chrome.ts` only detected `##`/`###` headings as the content-start marker — this article starts with `**bold**` text. Fixed in pipeline (see below).
  - Pipeline fix: Updated `shared/strip-chrome.ts` to detect `[+ More](#)` as a nav-end marker and accept bold text / any heading level as content start. Also fixes voicemail/enable-voicemail-transcription and likely other blank articles.

## Feature Enhancements

- [ ] **Bad link checker** — add a worker (or pipeline step) that does bad link checking and reports on links that don't work properly across all KB articles. Need to specially handle links to category pages that aren't articles but don't error.

- [ ] **Floating Table of Contents** — add a sticky/floating right-side TOC (like voipdocs.io) to article pages
  - `voipd-kb-system/public-kb/` (Hugo): Use `.TableOfContents` built-in + CSS for sticky sidebar
  - `voipd-kb-system/workers/internal/` (Worker): Extract heading IDs from `marked` HTML output, build TOC in template
  - Lower priority polish item

- [ ] **Image sync source URL logging** — when the images worker fails to download an image, the error log records the source URL but not which processed article(s) referenced it. Adding article-source tracking would make debugging future failures much easier. Requires refactoring `syncImages()` in `workers/images/src/index.ts` to track URL → article mapping rather than collecting URLs into a flat Set.

- [ ] **Pipeline: scan custom-articles/ for site manifest** — `workers/pipeline/src/pipeline-workflow.ts` has a TODO to also scan `custom-articles/` and include them in the site manifest and search index. Currently only crawled + override content is indexed.

- [ ] Add diff view to pending review queue (show changes vs current article using jsdiff/diff2html)

- [x] **Callout styling for Scope/Requirements/Troubleshooting sections** — implemented 2026-04-07
  - Added `wrapCallouts()` in `shared/transforms.ts` that wraps `## Scope`, `## Requirements`, and `## Troubleshooting` sections (plus their `**Bold**` variants) in `<div class="callout callout-scope|callout-req|callout-warn">` blocks during pipeline processing
  - Added matching CSS in both `public-kb/static/css/custom.css` (Hugo public site) and `workers/internal/src/templates/layout.ts` (internal worker) — rounded borders, colored backgrounds (blue for Scope, green for Requirements, amber for Troubleshooting/Warning)
  - Also added the upstream "Requirments" → "Requirements" typo fix as a branding-transform replacement (`shared/transforms.ts:15`)

- [x] **Crawl worker restructure** — fixed 2026-04-07
  - Old design batched URLs in groups of 50 with separate step.do() loops per batch, hitting CF Workflows' ~512 step limit at 438+ steps
  - Replaced with a flat 6-step workflow using a single CF Browser Rendering `/crawl` job with `source: "sitemaps"` (up to 100k pages per job)
  - Added `CRAWL_PAGE_LIMIT` and `CRAWL_MAX_AGE_SECONDS` env vars; detects and warns on crawl truncation in manifest and notification email
  - Total runtime now ~5 min (vs. 30–60 min with the batched design)

- [x] **Image sync: helpjuice URLs fetched from wrong CDN** — fixed 2026-04-07
  - Rewritten `imgdocs.example.com/helpjuice_production/...` URLs were being reverse-mapped to `cdn.elev.io` (the primary source CDN) instead of `static.helpjuice.com`, causing 568 403 failures per sync
  - Both sources have empty `pathPrefix`, so prefix matching couldn't distinguish them
  - Added optional `pathSignature` field to `ImageSource`; for `static.helpjuice.com`, `pathSignature: "helpjuice_production"` identifies its paths unambiguously

- [x] **Image sync: clickup URLs missing `/` after pathPrefix strip** — fixed 2026-04-07
  - Reverse-map of `imgdocs.example.comclickup/t24555569/...` was concatenating hostname + remainder without a separator, producing malformed URLs like `https://t24555569.p.clickup-attachments.comt24555569/...` (530 errors)
  - Fixed by re-adding the `/` separator when reconstructing the source URL

- [x] **Pipeline: image sync result + email notification** — fixed 2026-04-07
  - Pipeline used to wait synchronously up to 2 min on the image sync HTTP response, which timed out and caused emails to report "no image sync results"
  - Refactored to fire image sync as fire-and-forget, then read sync stats from the R2 log file in a separate `notify-email` step (3 min initial wait + up to 3×1 min retries)
  - Images worker now always writes a result log to R2 (not only on failure) so the pipeline can reliably read stats

- [x] **Image URL corruption in crawled markdown** — fixed 2026-03-31
  - Root cause: CF Browser Rendering wrapped images in `_` emphasis (`_![](url)_`), consuming underscores from URL hashes
  - Fix 1: Crawl worker now strips `_` emphasis wrapping from images before writing to R2
  - Fix 2: `shared/transforms.ts` has a specific hash replacement for the one known-corrupted URL
  - All images now display correctly including `native-fax/delete-a-native-fax-account`

- [x] Link "Manager Portal" text to Manager Portal URL in article content (transform rule) — added 2026-03-30

- [x] Handle `[email protected]` / `cdn-cgi/l/email-protection` links from CF email obfuscation — added 2026-03-30
  - Linked variants: replaced with "[see original article for email address](sourceUrl)"
  - Bare text variants: replaced with "*(email address — see original article)*"
  - Public articles with these: sms-mms/10dlc-messaging-overview, sms-mms/third-party-smsmms, users/distinctive-ring-via-manager-portal, fraud/good-cyber-hygiene-best-practices

- [x] Fix voicemail category page — fixed Hugo template to use .Page.RelPermalink + fixed typo in categorization (transcriptio → transcription) — 2026-03-30

- [x] Investigate blank article: voicemail/enable-voicemail-transcription — content was stripped by cleanup. Same root cause as microsoft-domain-issues (bold text start). Fixed in `shared/strip-chrome.ts` update 2026-03-31. Re-run pipeline to regenerate.

## Review: Public or Internal?

These articles mention "partner", "reseller", or "White Label" in content but may still be appropriate for public. Review and decide.

- [ ] [features/call-recording](//articles/features/call-recording)
  - Mentions "This option is for White Label Partners only" for one setting. Rest of article is All Users. Maybe add a note/override for that section?

- [ ] [auto-attendants/create-an-auto-attendant](//articles/auto-attendants/create-an-auto-attendant)
  - Mentions "Channel and White Label Partners may also control Auto Attendant Timeouts". Core article is public but has partner-specific instructions mixed in.

- [ ] [sms-mms/10dlc-messaging-overview](//articles/sms-mms/10dlc-messaging-overview)
  - Mentions "Reseller / Non-compliant KYC" in compliance table. Probably fine as public but review context.

# Large-Scale Future Restructuring for Features and Possible Release

## Open Source Release Considerations

Ongoing concerns:

- [ ] **Upstream platform stability risk** — Vendor may change their back-end docs platform in ways that require significant rewrites to the scraping and filtering logic. Will require updating the crawling and filtering system to match the new platform, and in the meantime updates should probably be paused by any users. Overrides will need to be redone/updated when this happens and there may be an entirely differently structure.

## Override/Editorial System Improvements

The current override system supports replacing article content via a plain-text markdown field, which loses the upstream version and prevents merging future updates. A quality-of-life improvement would b adding:

- [ ] **WYSIWYG markdown editor** for the overrides/admin interface
- [ ] **Visual diff viewer** — show changes between the upstream source and the current processed/overridden version (e.g. using jsdiff/diff2html); allow selectively merging upstream changes back in
- [ ] **Change tracking and alerts** — detect and notify when the upstream article is updated or a new one is created,e specially for articles that have local overrides.
- [ ] These improvements may require changes to the R2 object storage structure, which would complicate migration for anyone who has already deployed the current version. At some point a database may be better suited to the platform but there are likely some structural changes that could extend the current platform a ways further.
