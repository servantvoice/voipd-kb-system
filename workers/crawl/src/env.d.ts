interface Env {
  KB_BUCKET: R2Bucket;
  CRAWL_WORKFLOW: Workflow;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  CRAWL_SECRET: string;
  // Pipeline trigger — use service binding or HTTP URL
  PIPELINE_WORKER?: Fetcher;
  PIPELINE_URL?: string;
}
