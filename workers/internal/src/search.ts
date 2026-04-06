/**
 * Search helpers — loads the pre-built search index from R2 and
 * performs simple text matching.
 */

export interface SearchEntry {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
}

/** Read the search index JSON from R2. Returns an empty array on failure. */
export async function loadSearchIndex(
  bucket: R2Bucket,
): Promise<SearchEntry[]> {
  try {
    const obj = await bucket.get("processed/_search-index.json");
    if (!obj) return [];
    const text = await obj.text();
    return JSON.parse(text) as SearchEntry[];
  } catch {
    return [];
  }
}

/**
 * Simple case-insensitive text search over title + excerpt.
 * Returns matching entries sorted by relevance (title match first).
 */
export function searchArticles(
  index: SearchEntry[],
  query: string,
): SearchEntry[] {
  if (!query.trim()) return [];

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const scored = index
    .map((entry) => {
      const titleLower = entry.title.toLowerCase();
      const excerptLower = entry.excerpt.toLowerCase();

      let score = 0;
      for (const term of terms) {
        if (titleLower.includes(term)) score += 10;
        if (excerptLower.includes(term)) score += 1;
      }
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((s) => s.entry);
}
