/**
 * Strip navigation chrome from crawled markdown articles.
 *
 * Crawled articles have a consistent structure: breadcrumbs, title, author,
 * empty headings, Contact Us nav, [+ More] link, Table of Contents, then
 * actual content.
 */

export interface StripResult {
  markdown: string;
  title: string;
}

export function stripPageChrome(markdown: string, articlePath: string): StripResult {
  let md = markdown;

  if (!md.trim()) {
    return { markdown: "", title: "Untitled" };
  }

  // ─── 1. STRUCTURAL CLEANUP ──────────────────────────────────────────
  // Keep the # Title, find end of nav chrome, take everything after.

  const lines = md.split("\n");
  let titleLine = -1;
  let contentStart = -1;

  // Find the # Title (first H1 that isn't "Contact Us")
  for (let i = 0; i < lines.length; i++) {
    if (/^# +[A-Za-z0-9]/.test(lines[i]) && !lines[i].startsWith("# Contact Us")) {
      titleLine = i;
      break;
    }
  }

  // Find where real content starts after nav chrome
  if (titleLine >= 0) {
    let pastChrome = false;
    for (let i = titleLine + 1; i < lines.length; i++) {
      const line = lines[i].trim();

      // These markers signal the end of the nav chrome area
      if (/^\[\\\?\+ \s*More\]\(#\)/.test(line) || line === "Table of Contents") {
        pastChrome = true;
        continue;
      }

      // Any heading (h2-h6) well past the title = content starts
      if (/^#{2,6} [A-Za-z]/.test(line) && i > titleLine + 2) {
        if (/^# Contact Us/.test(line)) continue;
        contentStart = i;
        break;
      }

      // Past chrome: first non-empty, non-link, non-nav line = content
      if (pastChrome && line && !/^\[/.test(line) && !/^\* \[/.test(line)) {
        contentStart = i;
        break;
      }
    }

    // Fallback: bold text starting a section (e.g., **Scope**, **Requirements**)
    if (contentStart < 0) {
      for (let i = titleLine + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^\*\*[A-Za-z]/.test(line) && i > titleLine + 2) {
          contentStart = i;
          break;
        }
      }
    }
  }

  // Reconstruct: title + content
  if (titleLine >= 0 && contentStart > 0) {
    const title = lines[titleLine];
    const content = lines.slice(contentStart).join("\n");
    md = title + "\n\n" + content;
  }

  // ─── 2. REMOVE BREADCRUMBS ──────────────────────────────────────────
  md = md.replace(/^(\* \[[^\]]+\]\([^)]+\)\s*\n){1,5}/m, "");

  // ─── 3. BOTTOM-OF-ARTICLE CHROME ───────────────────────────────────
  md = md.replace(/\[[^\]]+\]\([^)]*##search[_%]?5?[Fq_]?query=[^)]+\)\s*/g, "");
  md = md.replace(/\[[^\]]+\]\([^)]*contact-us##[^)]*\)\s*/g, "");
  md = md.replace(/\[[^\]]+\]\([^)]*\/contact-us#[^)]*\)\s*/g, "");
  md = md.replace(
    /Was this article helpful\?\s*\n\s*\n\s*Yes\s*\n\s*\n\s*No\s*\n\s*\n\s*Give feedback about this article\s*/g,
    ""
  );
  md = md.replace(
    /^## Related Articles\s*\n\n(?:[\s\S]*?)(?=\n\[Knowledge|Close Expand|$)/m,
    ""
  );
  md = md.replace(
    /\[Knowledge Base Software powered by Helpjuice\]\(https?:\/\/helpjuice\.com[^)]*\)/g,
    ""
  );
  md = md.replace(/Close Expand\s*\n\s*\n\s*#{1,6}\s*$/g, "");
  md = md.replace(/\n*Are we missing a feature[^\n]*\n?/gi, "");

  // ─── 4. FIX RELATIVE LINKS ─────────────────────────────────────────
  if (articlePath) {
    const escapedPath = articlePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Fix doubled path: voipdocs.io/en_US/{article-path}/en_US/{target}
    const redundantLinkPattern = new RegExp(
      "https?://voipdocs\\.io/en_US/" + escapedPath + "/en[_%]5FUS/",
      "gi"
    );
    md = md.replace(redundantLinkPattern, "https://voipdocs.io/en_US/");

    // Fix relative link resolution: voipdocs.io/en_US/{article-path}/{target}
    const relLinkPattern = new RegExp(
      "(https?://voipdocs\\.io/en_US/)" + escapedPath + "/(?!en[_%])",
      "gi"
    );
    md = md.replace(relLinkPattern, "$1");
  }
  md = md.replace(/en%5FUS/gi, "en_US");

  // ─── 5. REMOVE REMAINING CHROME ────────────────────────────────────
  md = md.replace(/\[[^\]]+\]\([^)]*\/authors\/\d+\)/g, "");
  md = md.replace(/^#{1,6} *$/gm, "");
  md = md.replace(/\[\+ \s*More\]\(#\)/g, "");

  // ─── 6. WHITESPACE NORMALIZATION ───────────────────────────────────
  md = md.replace(/\n{4,}/g, "\n\n\n");
  md = md.trim();

  // ─── 7. EXTRACT CLEAN TITLE ────────────────────────────────────────
  const titleMatch = md.match(/^# (.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Untitled";

  return { markdown: md, title };
}
