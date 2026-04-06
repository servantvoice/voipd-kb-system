interface Env {
  KB_BUCKET: R2Bucket;
  PIPELINE_WORKFLOW: Workflow;
  CRAWL_SECRET: string;

  // Config
  KB_DOMAIN: string;
  INTERNAL_KB_DOMAIN: string;
  IMAGE_DOMAIN: string;
  MANAGER_PORTAL_URL: string;
  SOURCE_IMAGE_CDN: string;

  // Branding
  BRAND_NAME: string;
  CONNECT_NAME: string;
  CONNECT_DESKTOP_NAME: string;

  // Notification
  POSTMARK_API_TOKEN?: string;
  POSTMARK_MESSAGE_STREAM?: string;
  RESEND_API_KEY?: string;
  NOTIFICATION_TO: string;
  NOTIFICATION_FROM: string;

  // Downstream triggers
  PAGES_DEPLOY_HOOK: string;
  IMAGE_SYNC_URL: string;
}
