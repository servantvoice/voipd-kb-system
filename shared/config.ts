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
