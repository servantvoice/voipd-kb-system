import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { EXCLUDE_PREFIXES } from "../../../shared/categorization";

export interface CrawlParams {
  url?: string;
  modifiedSince?: string;
  webhookUrl?: string;
}

interface CrawlInitResponse {
  success: boolean;
  result: string;
  errors?: Array<{ code: number; message: string }>;
}

interface CrawledRecord {
  url: string;
  markdown?: string;
  status: string;
  metadata?: { status: number; title: string; url: string };
}

interface CrawlPollResponse {
  success: boolean;
  result: {
    id: string;
    status: string;
    total?: number;
    finished?: number;
    records?: CrawledRecord[];
    cursor?: number;
  };
  errors?: Array<{ code: number; message: string }>;
}

function isExcluded(urlPath: string): boolean {
  const lower = urlPath.toLowerCase();
  for (const prefix of EXCLUDE_PREFIXES) {
    if (lower.includes(prefix)) return true;
  }
  return false;
}

// Defaults — overridable via env vars
const DEFAULT_CRAWL_PAGE_LIMIT = 1000;
const DEFAULT_CRAWL_MAX_AGE_SECONDS = 86400; // 24 hours

export class CrawlWorkflow extends WorkflowEntrypoint<Env, CrawlParams> {
  async run(event: WorkflowEvent<CrawlParams>, step: WorkflowStep) {
    try {
      return await this.runInner(event, step);
    } catch (err) {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error("Crawl workflow failed:", msg);
      try {
        await notifyFailure(this.env, event.payload, msg);
      } catch (notifyErr) {
        console.error("Also failed to send failure notification:", notifyErr);
      }
      throw err;
    }
  }

  private async runInner(event: WorkflowEvent<CrawlParams>, step: WorkflowStep) {
    const params: CrawlParams = event.payload ?? {};
    const crawlUrl = params.url ?? "https://voipdocs.io/";

    const crawlPageLimit = parseInt(this.env.CRAWL_PAGE_LIMIT || "", 10) || DEFAULT_CRAWL_PAGE_LIMIT;
    const crawlMaxAge = parseInt(this.env.CRAWL_MAX_AGE_SECONDS || "", 10);
    const maxAgeSeconds = isNaN(crawlMaxAge) ? DEFAULT_CRAWL_MAX_AGE_SECONDS : crawlMaxAge;

    const apiBase = `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/browser-rendering`;
    const authHeaders = {
      Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    };

    const timestamp = new Date().toISOString();
    const datePrefix = timestamp.split("T")[0];

    // Step 1: Fetch and parse sitemap
    const sitemapResult = await step.do("fetch-sitemap", async () => {
      const sitemapUrl = `${crawlUrl}sitemap.xml`;
      console.log(`Fetching sitemap: ${sitemapUrl}`);

      const resp = await fetch(sitemapUrl);
      if (!resp.ok) throw new Error(`Failed to fetch sitemap: ${resp.status}`);

      const xml = await resp.text();
      const urlMatches = xml.match(/<loc>(.*?)<\/loc>/g) ?? [];
      const allUrls = urlMatches.map((m) => m.replace(/<\/?loc>/g, ""));

      const filteredUrls = allUrls.filter((url) => {
        const path = new URL(url).pathname;
        return !isExcluded(path);
      });

      filteredUrls.sort();

      const limitWarning = filteredUrls.length >= crawlPageLimit * 0.9;
      if (limitWarning) {
        console.warn(
          `⚠️ Crawl limit warning: ${filteredUrls.length} filtered URLs is >= 90% of CRAWL_PAGE_LIMIT (${crawlPageLimit}). ` +
          `Increase CRAWL_PAGE_LIMIT env var if the sitemap keeps growing.`
        );
      }

      console.log(`Sitemap: ${allUrls.length} total, ${filteredUrls.length} after filtering`);

      return {
        totalUrls: allUrls.length,
        filteredCount: filteredUrls.length,
        filteredUrls,
        limitWarning,
      };
    });

    // Step 2: Submit single crawl job for all URLs
    // Note: includePatterns is limited to 100 entries by the API — we use excludePatterns only
    // and rely on source: "sitemaps" to scope the crawl to the sitemap's URL set.
    const crawlJob = await step.do("submit-crawl", async () => {
      const crawlConfig: Record<string, unknown> = {
        url: crawlUrl,
        formats: ["markdown"],
        render: false,
        source: "sitemaps",
        limit: crawlPageLimit,
        crawlPurposes: ["search"],
        options: {
          excludePatterns: EXCLUDE_PREFIXES.map((p) => `**${p}**`),
        },
      };

      if (maxAgeSeconds > 0) {
        crawlConfig.maxAge = maxAgeSeconds;
      }

      if (params.modifiedSince) {
        crawlConfig.modifiedSince = params.modifiedSince;
      }

      const resp = await fetch(`${apiBase}/crawl`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(crawlConfig),
      });

      const data = (await resp.json()) as CrawlInitResponse;
      console.log(`Submit crawl: success=${data.success}, jobId=${data.result}`);

      if (!data.success) {
        console.error("Submit crawl failed:", JSON.stringify(data.errors));
        throw new Error(
          `Crawl submit failed: ${data.errors?.map((e) => e.message).join(", ") ?? "unknown"}`
        );
      }

      return { jobId: data.result };
    });

    const jobId = crawlJob.jobId;

    // Step 3: Wait for crawl completion (polls inline; retries give 5×13 = 65 min total)
    const completionResult = await step.do(
      "wait-for-completion",
      { retries: { limit: 5, delay: "10 seconds" } },
      async () => {
        // Give the crawler a head start before polling
        await new Promise((r) => setTimeout(r, 60_000)); // 1 min initial wait

        const startTime = Date.now();
        const MAX_WALL = 13 * 60 * 1000; // 13 min, 2-min buffer before CF 15-min step limit

        while (Date.now() - startTime < MAX_WALL) {
          const resp = await fetch(`${apiBase}/crawl/${jobId}?limit=1`, {
            headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` },
          });
          const data = (await resp.json()) as CrawlPollResponse;

          const status = data.result?.status;
          const total = data.result?.total ?? 0;
          const finished = data.result?.finished ?? 0;

          console.log(`Poll: status=${status}, total=${total}, finished=${finished}`);

          if (status === "completed" || status === "errored") {
            if (status === "errored") {
              console.error("Crawl job errored.");
            }
            return { status, total, finished };
          }

          await new Promise((r) => setTimeout(r, 30_000)); // 30s between polls
        }

        // Still running — throw to trigger retry with fresh 13-min window
        throw new Error(`Crawl still running after 13 minutes — will retry (jobId: ${jobId})`);
      }
    );

    const crawlTruncated = completionResult.total >= crawlPageLimit;
    if (crawlTruncated) {
      console.warn(
        `⚠️ Crawl truncation detected: total=${completionResult.total} >= CRAWL_PAGE_LIMIT=${crawlPageLimit}. ` +
        `Some URLs may have been dropped. Increase CRAWL_PAGE_LIMIT env var.`
      );
    }

    // Step 4: Fetch all results and write to R2
    const writeResult = await step.do("fetch-and-write", async () => {
      const writtenUrls: string[] = [];
      let cursor: number | undefined;
      let pageNum = 0;
      const maxPages = 20;

      do {
        const fetchUrl = new URL(`${apiBase}/crawl/${jobId}`);
        fetchUrl.searchParams.set("limit", "500");
        if (cursor !== undefined) fetchUrl.searchParams.set("cursor", String(cursor));

        const resp = await fetch(fetchUrl.toString(), {
          headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` },
        });
        const data = (await resp.json()) as CrawlPollResponse;

        if (!data.success || !data.result.records) {
          throw new Error(`Fetch page ${pageNum} failed: ${JSON.stringify(data.errors)}`);
        }

        for (const record of data.result.records) {
          if (!record.markdown) continue;

          let urlPath = record.url
            .replace(/^https?:\/\/voipdocs\.io\/?/, "")
            .replace(/\/$/, "");
          if (!urlPath) urlPath = "index";

          let md = record.markdown;
          md = md.replace(/_!\[/g, "![");
          md = md.replace(/(\!\[[^\]]*\]\([^)]+\))_/g, "$1");

          const key = `crawls/${datePrefix}/${urlPath}/index.md`;
          await this.env.KB_BUCKET.put(key, md);
          writtenUrls.push(record.url);
        }

        cursor = data.result.cursor;
        pageNum++;
      } while (cursor && pageNum < maxPages);

      console.log(`Fetched and wrote ${writtenUrls.length} pages`);
      return { writtenUrls, count: writtenUrls.length };
    });

    const writtenUrlSet = new Set(writeResult.writtenUrls);

    // Step 5: Write manifest
    await step.do("write-manifest", async () => {
      const manifest = {
        crawlUrl,
        timestamp,
        datePrefix,
        jobId,
        sitemapTotal: sitemapResult.totalUrls,
        filteredTotal: sitemapResult.filteredCount,
        limitWarning: sitemapResult.limitWarning,
        crawlTruncated,
        crawlTotal: completionResult.total,
        crawlFinished: completionResult.finished,
        writtenPages: writtenUrlSet.size,
        missedPages: sitemapResult.filteredCount - writtenUrlSet.size,
        modifiedSince: params.modifiedSince ?? null,
        urls: Array.from(writtenUrlSet).sort(),
        missedUrls: sitemapResult.filteredUrls
          .filter((url: string) => !writtenUrlSet.has(url))
          .sort(),
      };

      await this.env.KB_BUCKET.put(
        `crawls/${datePrefix}/_manifest.json`,
        JSON.stringify(manifest, null, 2)
      );

      console.log(
        `Manifest: ${writtenUrlSet.size}/${sitemapResult.filteredCount} pages written, ` +
        `${manifest.missedUrls.length} missed` +
        (manifest.limitWarning ? " [LIMIT WARNING]" : "") +
        (manifest.crawlTruncated ? " [TRUNCATED]" : "")
      );
    });

    // Step 6: Notify downstream — prefer service binding > PIPELINE_URL
    const notifyPayload = {
      jobId,
      pageCount: writtenUrlSet.size,
      missedPages: sitemapResult.filteredCount - writtenUrlSet.size,
      sitemapTotal: sitemapResult.totalUrls,
      filteredTotal: sitemapResult.filteredCount,
      limitWarning: sitemapResult.limitWarning,
      crawlTruncated,
      crawlDatePrefix: datePrefix,
      timestamp: new Date().toISOString(),
      modifiedSince: params.modifiedSince ?? null,
    };

    const pipelineWorker = (this.env as Env).PIPELINE_WORKER;
    const pipelineUrl = (this.env as Env).PIPELINE_URL;

    if (pipelineWorker || pipelineUrl) {
      await step.do(
        "notify-downstream",
        { retries: { limit: 3, delay: "30 seconds" } },
        async () => {
          const headers = {
            "Content-Type": "application/json",
            "X-Crawl-Secret": this.env.CRAWL_SECRET,
          };
          const body = JSON.stringify(notifyPayload);

          const resp = pipelineWorker
            ? await pipelineWorker.fetch("https://pipeline/process", { method: "POST", headers, body })
            : await fetch(`${pipelineUrl}/process`, { method: "POST", headers, body });

          if (!resp.ok) {
            throw new Error(`Downstream notify returned ${resp.status}: ${await resp.text()}`);
          }
        }
      );
    }

    return {
      success: true,
      jobId,
      sitemapTotal: sitemapResult.totalUrls,
      filteredTotal: sitemapResult.filteredCount,
      pagesWritten: writtenUrlSet.size,
      missedPages: sitemapResult.filteredCount - writtenUrlSet.size,
      limitWarning: sitemapResult.limitWarning,
      crawlTruncated,
      crawlDatePrefix: datePrefix,
    };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function notifyFailure(env: Env, params: CrawlParams, errorMsg: string): Promise<void> {
  const datePrefix = new Date().toISOString().split("T")[0];
  const subject = `KB Crawl FAILED — ${datePrefix}`;
  const html = `
    <h2 style="color:#c00;">Crawl workflow failed</h2>
    <p>Date: <strong>${datePrefix}</strong></p>
    <p>Source URL: <code>${escapeHtml(params.url ?? "https://voipdocs.io/")}</code></p>
    <p>The weekly crawl did not complete, so the pipeline was not triggered and the KBs were not refreshed.</p>
    <h3>Error</h3>
    <pre style="white-space:pre-wrap;background:#f8f8f8;border:1px solid #ddd;padding:0.75rem;">${escapeHtml(errorMsg)}</pre>
    <p>Check the Cloudflare Workflows dashboard for the errored instance. If this is a transient upstream error (e.g. Browser Rendering 7009), a manual re-trigger often resolves it.</p>
  `.trim();

  const body = JSON.stringify({ subject, html });
  const headers = {
    "Content-Type": "application/json",
    "X-Crawl-Secret": env.CRAWL_SECRET,
  };

  if (env.PIPELINE_WORKER) {
    const resp = await env.PIPELINE_WORKER.fetch("https://pipeline/notify", { method: "POST", headers, body });
    if (!resp.ok) {
      throw new Error(`Pipeline /notify returned ${resp.status}: ${await resp.text()}`);
    }
    return;
  }
  if (env.PIPELINE_URL) {
    const resp = await fetch(`${env.PIPELINE_URL}/notify`, { method: "POST", headers, body });
    if (!resp.ok) {
      throw new Error(`Pipeline /notify returned ${resp.status}: ${await resp.text()}`);
    }
    return;
  }
  console.warn("No PIPELINE_WORKER or PIPELINE_URL configured — cannot send failure email");
}
