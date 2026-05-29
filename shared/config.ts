export interface SystemConfig {
  kbDomain: string;
  internalKbDomain: string;
  imageDomain: string;
  sourceImageCdn: string;
  managerPortalUrl: string;
  brandDomain: string;
  r2Prefixes: typeof R2_PREFIXES;
}

export const R2_PREFIXES = {
  crawls: "crawls/",
  processed: "processed/",
  overrides: "overrides/",
  customArticles: "custom-articles/",
  editorialDrafts: "editorial/drafts/",
  editorialPending: "editorial/pending/",
} as const;

// Manifest collapse guard. A degenerate crawl (e.g. Browser Rendering returns empty
// for most URLs) must not be allowed to publish a near-empty site over a healthy one.
// A run only counts as "collapsed" when there's a prior baseline worth protecting —
// a fresh run with no history (previousCount <= 0) always passes so first-time setup
// and recovery from an empty manifest still work.
export const MANIFEST_FLOOR = 50;
export const MANIFEST_COLLAPSE_RATIO = 0.5;

export function isManifestCollapse(writtenCount: number, previousCount: number): boolean {
  if (previousCount <= 0) return false;
  return writtenCount < MANIFEST_FLOOR || writtenCount < previousCount * MANIFEST_COLLAPSE_RATIO;
}

export function buildConfig(env: Record<string, string>): SystemConfig {
  return {
    kbDomain: env.KB_DOMAIN ?? "",
    internalKbDomain: env.INTERNAL_KB_DOMAIN ?? "",
    imageDomain: env.IMAGE_DOMAIN ?? "",
    sourceImageCdn: env.SOURCE_IMAGE_CDN ?? "cdn.elev.io",
    managerPortalUrl: env.MANAGER_PORTAL_URL ?? "",
    brandDomain: env.BRAND_DOMAIN ?? "",
    r2Prefixes: R2_PREFIXES,
  };
}
