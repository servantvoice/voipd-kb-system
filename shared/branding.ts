export interface BrandingConfig {
  brandName: string;
  connectDesktopName: string;
  connectName: string;
}

export function buildBrandingConfig(env: Record<string, string>): BrandingConfig {
  return {
    brandName: env.BRAND_NAME ?? "",
    connectDesktopName: env.CONNECT_DESKTOP_NAME ?? "",
    connectName: env.CONNECT_NAME ?? "",
  };
}

export interface BrandingRule {
  pattern: RegExp;
  replacement: string;
  description: string;
}

/**
 * Build branding regex rules from config. These match upstream vendor brand
 * names and replace them with the deployment's branding.
 * Order matters: more specific patterns first to avoid partial matches.
 */
export function buildBrandingRules(branding: BrandingConfig): BrandingRule[] {
  return [
    {
      pattern: /OIT\s*VoIP[''\u2019]?s?/gi,
      replacement: branding.brandName,
      description: "OIT VoIP (with optional possessive/plural)",
    },
    {
      pattern: /OITVoIP[''\u2019]?s?/gi,
      replacement: branding.brandName,
      description: "OITVoIP (no space, with optional possessive/plural)",
    },
    {
      pattern: /CloudieConnect\s+Desktop/gi,
      replacement: branding.connectDesktopName,
      description: "CloudieConnect Desktop",
    },
    {
      pattern: /CloudieConnect/gi,
      replacement: branding.connectName,
      description: "CloudieConnect",
    },
    {
      pattern: /Cloudie\s*Connect/gi,
      replacement: branding.connectName,
      description: "Cloudie Connect (with space)",
    },
    {
      pattern: /\bOIT\b(?!\s*[-_/])/g,
      replacement: branding.brandName,
      description: "Standalone OIT (not in URL slugs)",
    },
  ];
}
