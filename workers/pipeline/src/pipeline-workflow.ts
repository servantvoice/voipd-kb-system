import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { buildConfig } from "../../../shared/config";
import { buildBrandingConfig } from "../../../shared/branding";
import { categorizeUrl } from "../../../shared/categorization";
import { R2_PREFIXES } from "../../../shared/config";
import { transformMarkdown, extractTitle, buildBreadcrumb } from "../../../shared/transforms";
import { stripPageChrome } from "../../../shared/strip-chrome";
import type { ArticleMeta, SearchIndexEntry } from "../../../shared/types";
import { sendEmail } from "../../../shared/email";

interface PipelineParams {
  crawlDatePrefix: string;
  pageCount: number;
  missedPages: number;
  sitemapTotal: number;
  filteredTotal: number;
  limitWarning?: boolean;
  crawlTruncated?: boolean;
}

interface ManifestData {
  urls: string[];
  writtenPages: number;
  missedUrls: string[];
  crawlUrl: string;
  limitWarning?: boolean;
  crawlTruncated?: boolean;
}

interface ProcessedArticle {
  path: string;
  markdown: string;
  meta: ArticleMeta;
}

const CHUNK_SIZE = 50;

export class PipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    try {
      return await this.runInner(event, step);
    } catch (err) {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error("Pipeline workflow failed:", msg);
      try {
        await sendEmail(this.env, `KB Pipeline FAILED — ${event.payload.crawlDatePrefix}`, `
          <h2 style="color:#c00;">Pipeline workflow failed</h2>
          <p>Crawl date: <strong>${event.payload.crawlDatePrefix}</strong></p>
          <p>The pipeline that transforms crawled markdown and builds the site manifest errored out. The public and internal KBs may be stale.</p>
          <h3>Error</h3>
          <pre style="white-space:pre-wrap;background:#f8f8f8;border:1px solid #ddd;padding:0.75rem;">${escapeHtml(msg)}</pre>
          <p>Check the Cloudflare Workflows dashboard for the errored instance and retry manually if appropriate.</p>
        `.trim());
      } catch (emailErr) {
        console.error("Also failed to send failure email:", emailErr);
      }
      throw err;
    }
  }

  private async runInner(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { crawlDatePrefix } = event.payload;
    console.log(`Pipeline started for crawl date: ${crawlDatePrefix}`);

    // Step 1: Read manifest
    const manifest = await step.do("read-manifest", async () => {
      const key = `${R2_PREFIXES.crawls}${crawlDatePrefix}/_manifest.json`;
      const obj = await this.env.KB_BUCKET.get(key);
      if (!obj) throw new Error(`Manifest not found: ${key}`);
      const data = JSON.parse(await obj.text()) as ManifestData;
      console.log(`Manifest: ${data.urls.length} URLs to process`);
      return {
        urls: data.urls,
        crawlUrl: data.crawlUrl,
        limitWarning: data.limitWarning ?? false,
        crawlTruncated: data.crawlTruncated ?? false,
      };
    });

    // Convert full URLs to relative paths
    const articles = manifest.urls
      .map((url) => {
        const rawPath = url
          .replace(/^https?:\/\/voipdocs\.io\/?/, "")
          .replace(/\/$/, "");
        const cleanPath = rawPath.replace(/^en_US\//, "");
        return { url, rawPath: rawPath || "index", path: cleanPath || "index" };
      })
      .filter((a) => a.path !== "index"); // skip root URL

    // Step 1b: Load previous site manifest so we can detect newly-discovered slugs
    // and carry forward status/firstSeen for slugs we've already seen.
    const previousMeta = await step.do("read-previous-manifest", async () => {
      const key = `${R2_PREFIXES.processed}_site-manifest.json`;
      const obj = await this.env.KB_BUCKET.get(key);
      if (!obj) {
        console.log("No previous site manifest — treating all slugs as new");
        return { knownSlugs: [] as string[], byslug: {} as Record<string, ArticleMeta> };
      }
      try {
        const arr = JSON.parse(await obj.text()) as ArticleMeta[];
        const byslug: Record<string, ArticleMeta> = {};
        for (const m of arr) byslug[m.slug] = m;
        return { knownSlugs: arr.map((m) => m.slug), byslug };
      } catch {
        return { knownSlugs: [] as string[], byslug: {} as Record<string, ArticleMeta> };
      }
    });
    const knownSlugSet = new Set(previousMeta.knownSlugs);
    const previousBySlug = previousMeta.byslug;

    const allProcessed: ProcessedArticle[] = [];

    // Step 2: Process articles in chunks
    const chunkCount = Math.ceil(articles.length / CHUNK_SIZE);

    for (let i = 0; i < chunkCount; i++) {
      const chunk = articles.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);

      const chunkResults = await step.do(`process-chunk-${i}`, async () => {
        const config = buildConfig(this.env as unknown as Record<string, string>);
        const branding = buildBrandingConfig(this.env as unknown as Record<string, string>);
        const results: ProcessedArticle[] = [];

        for (const article of chunk) {
          try {
            // Read raw markdown from crawl output
            const rawKey = `${R2_PREFIXES.crawls}${crawlDatePrefix}/${article.rawPath}/index.md`;
            let markdown = "";
            const rawObj = await this.env.KB_BUCKET.get(rawKey);
            if (rawObj) {
              markdown = await rawObj.text();
            }

            if (!markdown) continue;

            // Check for override content
            let isOverride = false;
            let overrideMeta: Record<string, unknown> | null = null;

            const overrideKey = `${R2_PREFIXES.overrides}${article.path}/index.md`;
            const overrideObj = await this.env.KB_BUCKET.get(overrideKey);
            if (overrideObj) {
              const overrideContent = await overrideObj.text();
              if (overrideContent.trim()) {
                isOverride = true;
                markdown = overrideContent;
              }
            }

            // Check for override metadata
            const overrideMetaKey = `${R2_PREFIXES.overrides}${article.path}/_meta.json`;
            const overrideMetaObj = await this.env.KB_BUCKET.get(overrideMetaKey);
            if (overrideMetaObj) {
              try {
                overrideMeta = JSON.parse(await overrideMetaObj.text());
              } catch {
                // Invalid override meta — ignore
              }
            }

            // Strip page chrome (skip for overrides — already in final form)
            let title = "Untitled";
            if (!isOverride) {
              const stripped = stripPageChrome(markdown, article.path);
              markdown = stripped.markdown;
              title = stripped.title;
            } else {
              title = extractTitle(markdown);
            }

            // Categorize
            let category = categorizeUrl("/" + article.path);

            // Apply branding transforms (skip for overrides)
            if (!isOverride) {
              markdown = transformMarkdown(markdown, config, branding, article.url);
            }

            // Build metadata
            const breadcrumb = buildBreadcrumb(article.path, branding);

            const meta: ArticleMeta = {
              slug: article.path,
              title,
              category,
              sourceUrl: article.url,
              lastCrawled: crawlDatePrefix,
              isOverride,
              breadcrumb,
            };

            // Carry forward status/firstSeen from previous manifest; mark newly-discovered
            // slugs as pending-review so they don't auto-publish.
            const prev = previousBySlug[article.path];
            if (prev?.firstSeen) meta.firstSeen = prev.firstSeen;
            if (prev?.status) meta.status = prev.status;

            if (!knownSlugSet.has(article.path)) {
              meta.status = "pending-review";
              meta.firstSeen = crawlDatePrefix;
            }

            // Apply override metadata if present
            if (overrideMeta) {
              console.log(`Applying override meta for ${article.path}: ${Object.keys(overrideMeta).join(",")}`);
              if (overrideMeta.category) meta.category = overrideMeta.category as ArticleMeta["category"];
              if (overrideMeta.title) meta.title = overrideMeta.title as string;
              if (overrideMeta.status) meta.status = overrideMeta.status as ArticleMeta["status"];
              if (overrideMeta.displayCategory) {
                (meta as ArticleMeta & { displayCategory: string }).displayCategory =
                  overrideMeta.displayCategory as string;
                meta.breadcrumb = [
                  overrideMeta.displayCategory as string,
                  ...(breadcrumb.length > 1 ? breadcrumb.slice(1) : [meta.title]),
                ];
              }
              if (
                overrideMeta.breadcrumb &&
                Array.isArray(overrideMeta.breadcrumb) &&
                overrideMeta.breadcrumb.length > 0
              ) {
                meta.breadcrumb = overrideMeta.breadcrumb as string[];
              }
            }

            // Write processed markdown + metadata to R2
            const processedKey = `${R2_PREFIXES.processed}${article.path}/index.md`;
            const metaKey = `${R2_PREFIXES.processed}${article.path}/_meta.json`;

            await this.env.KB_BUCKET.put(processedKey, markdown);
            await this.env.KB_BUCKET.put(metaKey, JSON.stringify(meta, null, 2));

            results.push({ path: article.path, markdown, meta });
          } catch (err) {
            console.error(`Error processing ${article.path}:`, err instanceof Error ? err.message : String(err));
          }
        }

        console.log(`Chunk ${i}: processed ${results.length}/${chunk.length} articles`);
        return results;
      });

      allProcessed.push(...chunkResults);
    }

    // Step 3: Build site manifest + search index
    const manifestStats = await step.do("build-manifests", async () => {
      const siteManifest: ArticleMeta[] = [];
      const searchIndex: SearchIndexEntry[] = [];

      for (const item of allProcessed) {
        if (item.meta.category === "excluded") continue;

        siteManifest.push(item.meta);

        const excerpt = item.markdown
          .replace(/^#.*$/gm, "")
          .replace(/[#*_\[\]()]/g, "")
          .replace(/<[^>]*>/g, "")
          .replace(/<[^>]*$/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 200);

        searchIndex.push({
          slug: item.meta.slug,
          title: item.meta.title,
          category: item.meta.category,
          excerpt,
        });
      }

      // TODO: In future, also scan custom-articles/ and include them

      await this.env.KB_BUCKET.put(
        `${R2_PREFIXES.processed}_site-manifest.json`,
        JSON.stringify(siteManifest, null, 2)
      );

      await this.env.KB_BUCKET.put(
        `${R2_PREFIXES.processed}_search-index.json`,
        JSON.stringify(searchIndex, null, 2)
      );

      const publicCount = siteManifest.filter((m) => m.category === "public").length;
      const internalCount = siteManifest.filter((m) => m.category === "internal").length;
      const pendingReviewEntries = siteManifest.filter((m) => m.status === "pending-review");
      const pendingReviewCount = pendingReviewEntries.length;
      const newlyPendingSlugs = pendingReviewEntries
        .filter((m) => m.firstSeen === crawlDatePrefix)
        .map((m) => m.slug);

      console.log(`Manifests: ${siteManifest.length} total (${publicCount} public, ${internalCount} internal, ${pendingReviewCount} pending review)`);
      if (newlyPendingSlugs.length > 0) {
        console.log(`Newly discovered this run: ${newlyPendingSlugs.join(", ")}`);
      }

      return {
        totalCount: siteManifest.length,
        publicCount,
        internalCount,
        pendingReviewCount,
        newlyPendingSlugs,
      };
    });

    // Step 4: Trigger CF Pages deploy + fire image sync (fire-and-forget)
    await step.do("trigger-downstream", async () => {
      const errors: string[] = [];

      if (this.env.PAGES_DEPLOY_HOOK) {
        try {
          const resp = await fetch(this.env.PAGES_DEPLOY_HOOK, { method: "POST" });
          if (!resp.ok) {
            errors.push(`Pages deploy hook: ${resp.status}`);
          } else {
            console.log("CF Pages deploy triggered");
          }
        } catch (err) {
          errors.push(`Pages deploy hook error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (this.env.IMAGE_SYNC_URL) {
        // Fire and forget — don't await the full sync response
        fetch(this.env.IMAGE_SYNC_URL, {
          method: "POST",
          headers: { "X-Crawl-Secret": this.env.CRAWL_SECRET },
        }).catch(() => {});
        console.log("Image sync triggered (fire-and-forget)");
      }

      if (errors.length > 0) {
        console.error("Trigger errors:", errors.join("; "));
      }
    });

    // Step 5: Wait for image sync to complete, then send notification email
    await step.do("notify-email", { retries: { limit: 2, delay: "10 seconds" } }, async () => {
      // Wait for image sync worker to finish, then poll until log appears (max ~6 min total)
      await new Promise((r) => setTimeout(r, 180_000)); // 3 min initial wait

      let imageSyncResult: ImageSyncResult | null = null;
      const logKey = `logs/image-sync/${crawlDatePrefix}.log`;

      for (let attempt = 0; attempt < 3; attempt++) {
        const logObj = await this.env.KB_BUCKET.get(logKey);
        if (logObj) {
          const text = await logObj.text();
          // Results line format: "Results: N downloaded, N cached, N revalidated, N failed"
          const resultsMatch = text.match(/Results: (\d+) downloaded, (\d+) cached, (\d+) revalidated, (\d+) failed/);
          const scannedArticles = text.match(/Scanned: (\d+) articles/)?.[1];
          const uniqueImages = text.match(/(\d+) unique images/)?.[1];
          const duration = text.match(/Duration: ([^\n]+)/)?.[1];
          const errorLines = text.split("\n").filter((l) => l.startsWith("403 ") || l.startsWith("Error:"));
          if (resultsMatch) {
            imageSyncResult = {
              downloaded: parseInt(resultsMatch[1]),
              alreadyCached: parseInt(resultsMatch[2]),
              revalidated: parseInt(resultsMatch[3]),
              failed: parseInt(resultsMatch[4]),
              scannedArticles: parseInt(scannedArticles ?? "0"),
              uniqueImages: parseInt(uniqueImages ?? "0"),
              duration: duration ?? "",
              errors: errorLines,
            };
            console.log(`Image sync: ${imageSyncResult.downloaded} downloaded, ${imageSyncResult.alreadyCached} cached, ${imageSyncResult.failed} failed`);
            break;
          }
        }
        if (attempt < 2) {
          console.log(`Image sync log not ready yet (attempt ${attempt + 1}) — waiting 60s`);
          await new Promise((r) => setTimeout(r, 60_000)); // 1 min between retries
        } else {
          console.log("Image sync log not found after retries — sync may still be running");
        }
      }

      const errors: string[] = [];
      try {
        await sendNotificationEmail(this.env, {
          crawlDatePrefix,
          publicCount: manifestStats.publicCount,
          internalCount: manifestStats.internalCount,
          totalCount: manifestStats.totalCount,
          processedCount: allProcessed.length,
          pendingReviewCount: manifestStats.pendingReviewCount,
          newlyPendingSlugs: manifestStats.newlyPendingSlugs,
          imageSyncResult,
          notifyErrors: errors.length > 0 ? errors : null,
          limitWarning: manifest.limitWarning,
          crawlTruncated: manifest.crawlTruncated,
          internalKbDomain: this.env.INTERNAL_KB_DOMAIN,
        });
        console.log("Notification email sent");
      } catch (err) {
        errors.push(`Email: ${err instanceof Error ? err.message : String(err)}`);
        console.error("Email error:", errors.join("; "));
      }
    });

    return {
      success: true,
      crawlDatePrefix,
      processed: allProcessed.length,
      publicCount: manifestStats.publicCount,
      internalCount: manifestStats.internalCount,
      totalCount: manifestStats.totalCount,
    };
  }
}

// ─── Email notification ─────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


interface ImageSyncResult {
  scannedArticles: number;
  uniqueImages: number;
  alreadyCached: number;
  downloaded: number;
  failed: number;
  revalidated: number;
  duration: string;
  errors: string[];
}

interface NotifyData {
  crawlDatePrefix: string;
  publicCount: number;
  internalCount: number;
  totalCount: number;
  processedCount: number;
  pendingReviewCount: number;
  newlyPendingSlugs: string[];
  imageSyncResult: ImageSyncResult | null;
  notifyErrors: string[] | null;
  limitWarning?: boolean;
  crawlTruncated?: boolean;
  internalKbDomain?: string;
}

async function sendNotificationEmail(env: Env, data: NotifyData): Promise<void> {
  const subject = `KB Refresh Complete — ${data.crawlDatePrefix}`;

  let imageSyncHtml = "";
  if (data.imageSyncResult) {
    const r = data.imageSyncResult;
    imageSyncHtml = `
    <h3>Image Sync</h3>
    <ul>
      <li>Articles scanned: ${r.scannedArticles}</li>
      <li>Unique images: ${r.uniqueImages}</li>
      <li>Already cached: ${r.alreadyCached}</li>
      <li>Downloaded: ${r.downloaded}</li>
      <li>Revalidated: ${r.revalidated}</li>
      <li>Failed: ${r.failed}</li>
      <li>Duration: ${r.duration}</li>
    </ul>
    ${r.failed > 0 ? `<p><em>See image sync error log in R2 for details.</em></p>` : ""}`;
  } else {
    imageSyncHtml = `<h3>Image Sync</h3><p><em>No results (sync timed out or was not triggered).</em></p>`;
  }

  let crawlWarningHtml = "";
  if (data.crawlTruncated) {
    crawlWarningHtml = `
    <p style="color:#c00;font-weight:bold;">&#9888; Crawl truncated: the crawler hit the page limit and may have dropped URLs. Increase CRAWL_PAGE_LIMIT on the crawl worker.</p>`;
  } else if (data.limitWarning) {
    crawlWarningHtml = `
    <p style="color:#c00;font-weight:bold;">&#9888; Crawl limit warning: filtered URL count is approaching CRAWL_PAGE_LIMIT. Consider increasing it before the next crawl.</p>`;
  }

  let errorsHtml = "";
  if (data.notifyErrors && data.notifyErrors.length > 0) {
    errorsHtml = `
    <h3>Warnings</h3>
    <ul>${data.notifyErrors.map((e) => `<li>${e}</li>`).join("")}</ul>`;
  }

  let pendingHtml = "";
  if (data.pendingReviewCount > 0) {
    const reviewUrl = data.internalKbDomain ? `https://${data.internalKbDomain}/.admin/review` : null;
    const newItems = data.newlyPendingSlugs.length > 0
      ? `<p><strong>New this run (${data.newlyPendingSlugs.length}):</strong></p>
         <ul>${data.newlyPendingSlugs.slice(0, 20).map((s) => `<li><code>${s}</code></li>`).join("")}</ul>
         ${data.newlyPendingSlugs.length > 20 ? `<p><em>...and ${data.newlyPendingSlugs.length - 20} more</em></p>` : ""}`
      : "";
    pendingHtml = `
    <h3 style="color:#c60;">Pending Review (${data.pendingReviewCount})</h3>
    <p>These articles are held from the public site until an admin approves them.${reviewUrl ? ` <a href="${reviewUrl}">Review queue</a>` : ""}</p>
    ${newItems}`;
  }

  const html = `
    <h2>KB Refresh Complete</h2>
    <p>Crawl date: <strong>${data.crawlDatePrefix}</strong></p>
    ${crawlWarningHtml}
    <h3>Articles</h3>
    <ul>
      <li>Processed: ${data.processedCount}</li>
      <li>Public: ${data.publicCount}</li>
      <li>Internal: ${data.internalCount}</li>
      <li>Pending review: ${data.pendingReviewCount}${data.pendingReviewCount > 0 ? " <em>(subset of above — held from public site)</em>" : ""}</li>
      <li>Total in manifest: ${data.totalCount}</li>
    </ul>
    ${pendingHtml}
    ${imageSyncHtml}
    ${errorsHtml}
  `.trim();

  await sendEmail(env, subject, html);
}
