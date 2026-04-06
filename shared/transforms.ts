import type { SystemConfig } from "./config";
import type { BrandingConfig } from "./branding";
import { buildBrandingRules } from "./branding";

// ─── Structural constants (not deployment-specific) ─────────────────────

export interface UrlRule {
  pattern: RegExp;
  replacement: string;
  description: string;
}

export const TYPO_RULES: UrlRule[] = [
  {
    pattern: /\bRequirments\b(?!\s*[-_/])/g,
    replacement: "Requirements",
    description: "Requirments -> Requirements (missing 'e')",
  },
];

export const CORRUPTED_URL_FIXES: UrlRule[] = [
  {
    pattern: /IIHlDuhSX4AJMqiKrKKZmOHDxbR7aIoTd3id6RS8TM/g,
    replacement: "IIHlDuhSX4AJMqiKrKKZmO_HDxbR7aIoTd3id6RS8TM",
    description: "native-fax/delete-a-native-fax-account image hash missing underscore",
  },
];

export const EXCLUDED_LINK_PREFIXES = [
  "/dg-branding/",
  "/dg-invoicing/",
  "/dg-products/",
  "/dg-customers/",
  "/dg-usage/",
  "/dg-taxes-and-fees/",
  "/datagate/",
  "/billing-administration/",
  "/rays-stuff/",
  "/devops-automation-engineer",
  "/mfax-events/",
  "/snaphd/",
];

export const URL_CRUFT_RULES: UrlRule[] = [
  { pattern: /\?from[_% ]?search=\d+/gi, replacement: "", description: "Strip ?from_search=NNN" },
  { pattern: /\?from%5Fsearch=\d+/gi, replacement: "", description: "Strip ?from%5Fsearch=NNN" },
  { pattern: /\/version\/\d+\/?/g, replacement: "", description: "Strip /version/N" },
  { pattern: /\?kb[_% ]?language=en_US/gi, replacement: "", description: "Strip ?kb_language=en_US" },
  { pattern: /&from[_% ]?search=\d+/gi, replacement: "", description: "Strip &from_search=NNN" },
  { pattern: /&from%5Fsearch=\d+/gi, replacement: "", description: "Strip &from%5Fsearch=NNN" },
  { pattern: /&kb[_% ]?language=en_US/gi, replacement: "", description: "Strip &kb_language=en_US" },
  { pattern: /\?kb%5Flanguage=en_US/gi, replacement: "", description: "Strip ?kb%5Flanguage=en_US" },
  { pattern: /&kb%5Flanguage=en_US/gi, replacement: "", description: "Strip &kb%5Flanguage=en_US" },
];

const EMAIL_PROTECTION_LINK_PATTERN =
  /\[([^\]]*email[^\]]*protected[^\]]*)\]\([^)]*cdn-cgi\/l\/email-protection[^)]*\)/gi;

const EMAIL_PROTECTION_TEXT_PATTERN =
  /\[email\s*protected\]/gi;

const PLATFORM_TEXT_CLEANUP = [
  { pattern: /\s*\(helpjuice\.com\)/gi, replacement: "" },
];

// ─── Transform function ─────────────────────────────────────────────────

/**
 * Apply all branding, URL, and link transforms to markdown content.
 * All deployment-specific values come from config and branding parameters.
 */
export function transformMarkdown(
  markdown: string,
  config: SystemConfig,
  branding: BrandingConfig,
  sourceUrl?: string,
): string {
  let result = markdown;

  // 1. Fix known corrupted image URLs
  for (const rule of CORRUPTED_URL_FIXES) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  // 2. Image CDN rewriting (built from config)
  const imageDomain = config.imageDomain;
  result = result.replace(/https?:\/\/cdn\.elev\.io\//gi, `https://${imageDomain}/`);
  result = result.replace(/https?:\/\/static\.helpjuice\.com\//gi, `https://${imageDomain}/`);
  result = result.replace(/https?:\/\/t24555569\.p\.clickup-attachments\.com\//gi, `https://${imageDomain}/clickup/`);

  // 3. URL replacements (built from config)
  result = result.replace(/https?:\/\/voipdocs\.io\/en_US\//gi, "/articles/");
  result = result.replace(/https?:\/\/voipdocs\.io\//gi, "/articles/");
  result = result.replace(/voipdocs\.io/gi, config.kbDomain);

  // 4. Manager Portal links
  result = result.replace(/https?:\/\/manage\.oitvoip\.com/gi, config.managerPortalUrl);

  // 5. Strip URL cruft
  for (const rule of URL_CRUFT_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  // 6. Strip /en_US/ from relative links
  result = result.replace(/\]\(\/?en_US\//g, "](/articles/");
  result = result.replace(/<\/?(?:articles\/)?en[_\\]*US\//g, "</articles/");

  // 7. Strip angle brackets from article autolinks
  result = result.replace(/<(\/articles\/[^>]+)>/g, "");

  // 8. Known slug redirects from legacy Helpjuice numeric slugs
  result = result.replace(/\/articles\/176-account-codes/g, "/articles/features/account-codes");
  result = result.replace(/\/articles\/articles\//g, "/articles/");

  // 9. Remove hyperlinks to excluded content (keep display text)
  for (const prefix of EXCLUDED_LINK_PREFIXES) {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const linkPattern = new RegExp(
      `\\[([^\\]]+)\\]\\([^)]*${escapedPrefix}[^)]*\\)`,
      "gi"
    );
    result = result.replace(linkPattern, "$1");
  }

  // 10. Typo corrections
  for (const rule of TYPO_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  // 11. Strip upstream platform text
  for (const rule of PLATFORM_TEXT_CLEANUP) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  // 12. Branding replacements
  const brandingRules = buildBrandingRules(branding);
  for (const rule of brandingRules) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  // 13. Handle CF email obfuscation
  result = result.replace(EMAIL_PROTECTION_LINK_PATTERN, (_match) => {
    if (sourceUrl) {
      return `[see original article for email address](${sourceUrl})`;
    }
    return "*(email address hidden by source site)*";
  });
  result = result.replace(EMAIL_PROTECTION_TEXT_PATTERN, "*(email address — see original article)*");

  // 14. Link plain-text "Manager Portal" to the portal URL
  result = result.replace(
    /(?<!\[)Manager Portal(?!\]\()/g,
    `[Manager Portal](${config.managerPortalUrl})`
  );

  // 15. Callout wrapping for Scope/Requirements/Troubleshooting sections
  result = wrapCallouts(result);

  return result;
}

/**
 * Wrap Scope, Requirements, and Troubleshooting sections in callout divs.
 * Handles both heading (### Scope) and bold (**Scope**) variants.
 */
function wrapCallouts(md: string): string {
  let result = md;

  // Heading variant: ### Scope
  if (!result.includes("callout-scope")) {
    result = result.replace(
      /^(#{2,3} Scope:?\s*\n)([\s\S]*?)(?=^#{1,3} |^\d+\.\s|^\||^---|^\*\*Requirements|^<div)/m,
      '<div class="callout callout-scope">\n\n$1$2\n</div>\n\n'
    );
  }
  if (!result.includes("callout-req")) {
    result = result.replace(
      /^(#{2,3} Requirements:?\s*\n)([\s\S]*?)(?=^#{1,3} (?!Requirements)[A-Za-z]|^\d+\.\s|^\*\*[A-Z]|^\||^---|^<div)/m,
      '<div class="callout callout-req">\n\n$1$2\n</div>\n\n'
    );
  }

  // Bold variant: **Scope** / **Requirements**
  if (!result.includes("callout-scope")) {
    result = result.replace(
      /^(\*\*Scope:?\*\*\s*\n)([\s\S]*?)(?=^\*\*Requirements|^#{1,3} |^\||^---|^\d+\.\s|^<div)/m,
      '<div class="callout callout-scope">\n\n$1$2\n</div>\n\n'
    );
  }
  if (!result.includes("callout-req")) {
    result = result.replace(
      /^(\*\*Requirements:?\*\*\s*\n)([\s\S]*?)(?=^\*\*[A-Z]|^#{1,3} |^\||^---|^\d+\.\s|^<div)/m,
      '<div class="callout callout-req">\n\n$1$2\n</div>\n\n'
    );
  }

  // Heading variant: ### Troubleshooting
  result = result.replace(
    /^(#{2,3} Troubleshooting\s*\n)([\s\S]*?)(?=^#{1,3} [A-Za-z]|$)/m,
    '<div class="callout callout-warn">\n\n$1$2\n</div>\n\n'
  );

  return result;
}

// ─── Utility functions ──────────────────────────────────────────────────

export function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled";
}

const CASE_CORRECTIONS: Record<string, string> = {
  "mfax": "mFax",
  "mfax analog": "mFax - Analog",
  "mfax digital": "mFax - Digital",
  "snaphd": "SNAP.HD",
  "snapbuilder": "SNAPbuilder",
  "snapmobile": "SnapMobile",
  "voipmonitor": "VoIPMonitor",
  "cdrs": "CDRs",
  "ndp": "NDP",
  "sms mms": "SMS / MMS",
  "e 911": "E-911",
  "pbx": "PBX",
  "api integrations": "API & Integrations",
  "uc integrator": "UC Integrator",
  "sip trunking": "SIP Trunking",
  "faqs": "FAQs",
  "onebill": "OneBill",
  "hardware software": "Hardware & Software",
  "caller id": "Caller ID",
  "local toll free porting": "Local & Toll Free Porting",
};

export function buildBreadcrumb(urlPath: string): string[] {
  return urlPath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const spaced = segment.replace(/-/g, " ");
      const corrected = CASE_CORRECTIONS[spaced.toLowerCase()];
      if (corrected) return corrected;
      return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
    });
}
