/** Payload shape from crawl worker webhook to pipeline */
export interface CrawlWebhookPayload {
  crawlDatePrefix: string;
  pageCount: number;
  missedPages: number;
  sitemapTotal: number;
  filteredTotal: number;
  timestamp: string;
  modifiedSince?: string | null;
}

/** Per-article metadata stored alongside processed markdown */
export interface ArticleMeta {
  slug: string;
  title: string;
  category: "public" | "internal" | "excluded";
  sourceUrl: string;
  lastCrawled: string;
  isOverride: boolean;
  breadcrumb: string[];
  displayCategory?: string;
  /** Undefined or "approved" = visible on public site (if category=public). "pending-review" = held until admin approves. */
  status?: "pending-review" | "approved";
  /** crawlDatePrefix when this slug was first discovered by the pipeline. */
  firstSeen?: string;
}

/** Entry in the site manifest (processed/_site-manifest.json) */
export type SiteManifestEntry = ArticleMeta;

/** Entry in the search index (processed/_search-index.json) */
export interface SearchIndexEntry {
  slug: string;
  title: string;
  category: "public" | "internal" | "excluded";
  excerpt: string;
}
