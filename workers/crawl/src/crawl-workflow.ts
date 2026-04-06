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

const BATCH_SIZE = 50;
const INITIAL_POLL_DELAY = "3 minutes";
const POLL_INTERVAL = "2 minutes";
const INTER_BATCH_DELAY = "1 minute";
const WRITE_CHUNK_SIZE = 50;
const RETRY_BATCH_SIZE = 25;
const MAX_RETRY_ROUNDS = 2;

export class CrawlWorkflow extends WorkflowEntrypoint<Env, CrawlParams> {
  async run(event: WorkflowEvent<CrawlParams>, step: WorkflowStep) {
    const params = event.payload;
    const crawlUrl = params.url ?? "https://voipdocs.io/";
    const apiBase = `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/browser-rendering`;

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

      const batches: string[][] = [];
      for (let i = 0; i < filteredUrls.length; i += BATCH_SIZE) {
        batches.push(filteredUrls.slice(i, i + BATCH_SIZE));
      }

      console.log(`Sitemap: ${allUrls.length} total, ${filteredUrls.length} after filtering, ${batches.length} batches of ${BATCH_SIZE}`);

      return {
        totalUrls: allUrls.length,
        filteredCount: filteredUrls.length,
        filteredUrls,
        batchCount: batches.length,
        batches: batches.map((batch) => ({ size: batch.length, urls: batch })),
      };
    });

    const writtenUrlSet = new Set<string>();
    let totalRecords = 0;
    const allJobIds: string[] = [];

    // Step 2+: Run each batch
    for (let batchIndex = 0; batchIndex < sitemapResult.batchCount; batchIndex++) {
      if (batchIndex > 0) {
        await step.sleep(`inter-batch-delay-${batchIndex}`, INTER_BATCH_DELAY);
      }

      const batch = sitemapResult.batches[batchIndex];
      console.log(`\n── Batch ${batchIndex + 1}/${sitemapResult.batchCount} (${batch.size} URLs) ──`);

      const batchResult = await this.runCrawlBatch(
        step, `batch-${batchIndex}`, batch.urls, crawlUrl, apiBase, params, datePrefix
      );

      allJobIds.push(batchResult.jobId);
      totalRecords += batchResult.totalRecords;
      for (const url of batchResult.writtenUrls) writtenUrlSet.add(url);

      console.log(`Batch ${batchIndex} done: ${batchResult.writtenCount}/${batchResult.totalRecords} pages written (${writtenUrlSet.size} total so far)`);
    }

    // Retry pass
    const missingUrls = sitemapResult.filteredUrls.filter((url: string) => !writtenUrlSet.has(url));

    if (missingUrls.length > 0) {
      console.log(`\n── Retry: ${missingUrls.length} URLs missing markdown ──`);

      for (let retryRound = 0; retryRound < MAX_RETRY_ROUNDS && missingUrls.length > 0; retryRound++) {
        const currentMissing = sitemapResult.filteredUrls.filter((url: string) => !writtenUrlSet.has(url));
        if (currentMissing.length === 0) break;

        const retryBatches: string[][] = [];
        for (let i = 0; i < currentMissing.length; i += RETRY_BATCH_SIZE) {
          retryBatches.push(currentMissing.slice(i, i + RETRY_BATCH_SIZE));
        }

        console.log(`Retry round ${retryRound + 1}: ${currentMissing.length} missing URLs, ${retryBatches.length} batches of ${RETRY_BATCH_SIZE}`);

        for (let retryBatchIndex = 0; retryBatchIndex < retryBatches.length; retryBatchIndex++) {
          await step.sleep(`retry-${retryRound}-delay-${retryBatchIndex}`, INTER_BATCH_DELAY);

          const retryBatch = retryBatches[retryBatchIndex];
          const stepPrefix = `retry-${retryRound}-batch-${retryBatchIndex}`;

          const retryResult = await this.runCrawlBatch(
            step, stepPrefix, retryBatch, crawlUrl, apiBase, params, datePrefix
          );

          allJobIds.push(retryResult.jobId);
          totalRecords += retryResult.totalRecords;
          for (const url of retryResult.writtenUrls) writtenUrlSet.add(url);

          console.log(`Retry batch done: ${retryResult.writtenCount} new pages (${writtenUrlSet.size} total)`);
        }
      }
    }

    const totalWritten = writtenUrlSet.size;

    // Write combined manifest
    await step.do("write-manifest", async () => {
      const manifest = {
        crawlUrl,
        timestamp,
        datePrefix,
        sitemapTotal: sitemapResult.totalUrls,
        filteredTotal: sitemapResult.filteredCount,
        batchCount: sitemapResult.batchCount,
        jobIds: allJobIds,
        totalRecords,
        writtenPages: totalWritten,
        missedPages: sitemapResult.filteredCount - totalWritten,
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

      console.log(`Manifest: ${totalWritten}/${sitemapResult.filteredCount} pages written, ${manifest.missedUrls.length} missed`);
    });

    // Notify downstream — prefer service binding > PIPELINE_URL
    const notifyPayload = {
      batchCount: sitemapResult.batchCount,
      jobIds: allJobIds,
      pageCount: totalWritten,
      missedPages: sitemapResult.filteredCount - totalWritten,
      sitemapTotal: sitemapResult.totalUrls,
      filteredTotal: sitemapResult.filteredCount,
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
      batchCount: sitemapResult.batchCount,
      sitemapTotal: sitemapResult.totalUrls,
      filteredTotal: sitemapResult.filteredCount,
      pagesWritten: totalWritten,
      missedPages: sitemapResult.filteredCount - totalWritten,
      crawlDatePrefix: datePrefix,
    };
  }

  private async runCrawlBatch(
    step: WorkflowStep,
    stepPrefix: string,
    urls: string[],
    crawlUrl: string,
    apiBase: string,
    params: CrawlParams,
    datePrefix: string
  ): Promise<{
    jobId: string;
    writtenCount: number;
    writtenUrls: string[];
    totalRecords: number;
  }> {
    const includePatterns = urls.map((url: string) => {
      const path = new URL(url).pathname.replace(/^\//, "").replace(/\/$/, "");
      return `**/${path}`;
    });

    const crawlJob = await step.do(`${stepPrefix}-initiate`, async () => {
      const crawlConfig: Record<string, unknown> = {
        url: crawlUrl,
        formats: ["markdown"],
        render: false,
        source: "sitemaps",
        limit: urls.length,
        crawlPurposes: ["search"],
        options: {
          includePatterns,
          excludePatterns: EXCLUDE_PREFIXES.map((p) => `**${p}**`),
        },
      };

      if (params.modifiedSince) {
        crawlConfig.modifiedSince = params.modifiedSince;
      }

      const resp = await fetch(`${apiBase}/crawl`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(crawlConfig),
      });

      const data = (await resp.json()) as CrawlInitResponse;
      console.log(`${stepPrefix}: initiate success=${data.success}, jobId=${data.result}`);

      if (!data.success) {
        console.error(`${stepPrefix} failed:`, JSON.stringify(data.errors));
        throw new Error(
          `${stepPrefix} crawl failed: ${data.errors?.map((e) => e.message).join(", ") ?? "unknown"}`
        );
      }

      return { jobId: data.result };
    });

    let isComplete = false;
    let pollCount = 0;
    const maxPolls = 30;

    while (!isComplete && pollCount < maxPolls) {
      const delay = pollCount === 0 ? INITIAL_POLL_DELAY : POLL_INTERVAL;
      await step.sleep(`${stepPrefix}-poll-wait-${pollCount}`, delay);

      const pollStatus = await step.do(`${stepPrefix}-poll-${pollCount}`, async () => {
        const resp = await fetch(`${apiBase}/crawl/${crawlJob.jobId}`, {
          headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` },
        });
        const data = (await resp.json()) as CrawlPollResponse;

        console.log(`${stepPrefix} poll ${pollCount}: status=${data.result?.status}, total=${data.result?.total ?? 0}, finished=${data.result?.finished ?? 0}`);

        if (!data.success) {
          throw new Error(`${stepPrefix} poll failed: ${data.errors?.map((e) => e.message).join(", ")}`);
        }

        return {
          status: data.result.status,
          total: data.result.total ?? 0,
          finished: data.result.finished ?? 0,
        };
      });

      if (pollStatus.status === "completed" || pollStatus.status === "errored") {
        isComplete = true;
        if (pollStatus.status === "errored") {
          console.error(`${stepPrefix} crawl errored.`);
        }
      }
      pollCount++;
    }

    if (!isComplete) {
      console.error(`${stepPrefix} timed out. Returning empty results.`);
      return { jobId: crawlJob.jobId, writtenCount: 0, writtenUrls: [], totalRecords: 0 };
    }

    const fetchResult = await step.do(`${stepPrefix}-fetch`, async () => {
      const records: Array<{ url: string; markdown: string | null }> = [];
      let cursor: number | undefined = undefined;
      let pageNum = 0;
      const maxPages = 5;

      do {
        const fetchUrl = new URL(`${apiBase}/crawl/${crawlJob.jobId}`);
        fetchUrl.searchParams.set("limit", "500");
        if (cursor !== undefined) fetchUrl.searchParams.set("cursor", String(cursor));

        const resp = await fetch(fetchUrl.toString(), {
          headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` },
        });
        const data = (await resp.json()) as CrawlPollResponse;

        if (!data.success || !data.result.records) {
          throw new Error(`${stepPrefix} fetch page ${pageNum} failed: ${JSON.stringify(data.errors)}`);
        }

        for (const record of data.result.records) {
          records.push({ url: record.url, markdown: record.markdown ?? null });
        }

        cursor = data.result.cursor;
        pageNum++;
      } while (cursor && pageNum < maxPages && records.length < BATCH_SIZE * 5);

      console.log(`${stepPrefix}: fetched ${records.length} records, ${records.filter(r => r.markdown).length} with markdown`);
      return { records };
    });

    const records = fetchResult.records;
    let batchWritten = 0;
    const writtenUrls: string[] = [];

    const chunkCount = Math.ceil(records.length / WRITE_CHUNK_SIZE);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const chunkStart = chunkIndex * WRITE_CHUNK_SIZE;
      const chunk = records.slice(chunkStart, chunkStart + WRITE_CHUNK_SIZE);

      const chunkResult = await step.do(`${stepPrefix}-write-${chunkIndex}`, async () => {
        let written = 0;
        const chunkWrittenUrls: string[] = [];
        for (const record of chunk) {
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
          written++;
          chunkWrittenUrls.push(record.url);
        }
        return { written, urls: chunkWrittenUrls };
      });

      batchWritten += chunkResult.written;
      writtenUrls.push(...chunkResult.urls);
    }

    return {
      jobId: crawlJob.jobId,
      writtenCount: batchWritten,
      writtenUrls,
      totalRecords: records.length,
    };
  }
}
