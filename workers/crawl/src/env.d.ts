interface Env {
  KB_BUCKET: R2Bucket;
  CRAWL_WORKFLOW: Workflow;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  CRAWL_SECRET: string;
  // Pipeline trigger — use service binding or HTTP URL
  PIPELINE_WORKER?: Fetcher;
  PIPELINE_URL?: string;
  // Crawl tuning — optional, see defaults in crawl-workflow.ts
  CRAWL_BATCH_SIZE?: string;
  CRAWL_RETRY_BATCH_SIZE?: string;
  CRAWL_MAX_RETRY_ROUNDS?: string;
  CRAWL_INITIAL_POLL_DELAY?: string;
  CRAWL_POLL_INTERVAL?: string;
  CRAWL_INTER_BATCH_DELAY?: string;
}
