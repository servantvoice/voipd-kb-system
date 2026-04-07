import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { buildConfig } from "../../../shared/config";
import { buildBrandingConfig } from "../../../shared/branding";
import { categorizeUrl } from "../../../shared/categorization";
import { R2_PREFIXES } from "../../../shared/config";
import { transformMarkdown, extractTitle, buildBreadcrumb } from "../../../shared/transforms";
import { stripPageChrome } from "../../../shared/strip-chrome";
import type { ArticleMeta, SearchIndexEntry } from "../../../shared/types";

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
            const breadcrumb = buildBreadcrumb(article.path);

            const meta: ArticleMeta = {
              slug: article.path,
              title,
              category,
              sourceUrl: article.url,
              lastCrawled: crawlDatePrefix,
              isOverride,
              breadcrumb,
            };

            // Apply override metadata if present
            if (overrideMeta) {
              if (overrideMeta.category) meta.category = overrideMeta.category as ArticleMeta["category"];
              if (overrideMeta.title) meta.title = overrideMeta.title as string;
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

      console.log(`Manifests: ${siteManifest.length} total (${publicCount} public, ${internalCount} internal)`);

      return { totalCount: siteManifest.length, publicCount, internalCount };
    });

    // Step 4: Trigger downstream + send notification
    await step.do("notify", { retries: { limit: 2, delay: "10 seconds" } }, async () => {
      const errors: string[] = [];

      // Trigger CF Pages deploy hook
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

      // Trigger image sync and wait for results (with timeout)
      let imageSyncResult: ImageSyncResult | null = null;
      if (this.env.IMAGE_SYNC_URL) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout
          const resp = await fetch(this.env.IMAGE_SYNC_URL, {
            method: "POST",
            headers: { "X-Crawl-Secret": this.env.CRAWL_SECRET },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (resp.ok) {
            imageSyncResult = await resp.json() as ImageSyncResult;
            console.log(`Image sync: ${imageSyncResult.downloaded} downloaded, ${imageSyncResult.alreadyCached} cached, ${imageSyncResult.failed} failed`);
          } else {
            errors.push(`Image sync: ${resp.status}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("abort")) {
            errors.push("Image sync timed out (>2min) — sync may still be running");
          } else {
            errors.push(`Image sync error: ${msg}`);
          }
        }
      }

      // Send email notification (always, regardless of image sync outcome)
      try {
        await sendNotificationEmail(this.env, {
          crawlDatePrefix,
          publicCount: manifestStats.publicCount,
          internalCount: manifestStats.internalCount,
          totalCount: manifestStats.totalCount,
          processedCount: allProcessed.length,
          imageSyncResult,
          notifyErrors: errors.length > 0 ? errors : null,
          limitWarning: manifest.limitWarning,
          crawlTruncated: manifest.crawlTruncated,
        });
        console.log("Notification email sent");
      } catch (err) {
        errors.push(`Email: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (errors.length > 0) {
        console.error("Notification errors:", errors.join("; "));
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
  imageSyncResult: ImageSyncResult | null;
  notifyErrors: string[] | null;
  limitWarning?: boolean;
  crawlTruncated?: boolean;
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

  const html = `
    <h2>KB Refresh Complete</h2>
    <p>Crawl date: <strong>${data.crawlDatePrefix}</strong></p>
    ${crawlWarningHtml}
    <h3>Articles</h3>
    <ul>
      <li>Processed: ${data.processedCount}</li>
      <li>Public: ${data.publicCount}</li>
      <li>Internal: ${data.internalCount}</li>
      <li>Total in manifest: ${data.totalCount}</li>
    </ul>
    ${imageSyncHtml}
    ${errorsHtml}
  `.trim();

  if (env.POSTMARK_API_TOKEN) {
    const resp = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": env.POSTMARK_API_TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        From: env.NOTIFICATION_FROM,
        To: env.NOTIFICATION_TO,
        Subject: subject,
        HtmlBody: html,
        MessageStream: env.POSTMARK_MESSAGE_STREAM || "outbound",
      }),
    });

    if (!resp.ok) {
      throw new Error(`Postmark returned ${resp.status}: ${await resp.text()}`);
    }
  } else if (env.RESEND_API_KEY) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.NOTIFICATION_FROM,
        to: env.NOTIFICATION_TO,
        subject: subject,
        html: html,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Resend returned ${resp.status}: ${await resp.text()}`);
    }
  } else {
    console.log("No email API token configured — skipping notification email");
  }
}
