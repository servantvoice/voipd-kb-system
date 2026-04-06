/**
 * Search page — form + results list with client-side search fallback.
 */

import type { UserContext } from "../auth";
import type { Env } from "../index";
import { renderLayout, escapeHtml } from "./layout";

export interface SearchPageOptions {
  query?: string;
  results?: Array<{
    slug: string;
    title: string;
    excerpt: string;
    category: string;
  }>;
  user: UserContext;
  env: Env;
}

export function renderSearchPage(opts: SearchPageOptions): string {
  const { query, results, user, env } = opts;

  const resultsHtml = results
    ? results.length > 0
      ? `<p>${results.length} result${results.length !== 1 ? "s" : ""} for "<strong>${escapeHtml(query ?? "")}</strong>"</p>
         <ul>
           ${results
             .map(
               (r) => `
             <li>
               <a href="/articles/${escapeHtml(r.slug)}">${escapeHtml(r.title)}</a>
               <span class="badge ${r.category === "public" ? "public" : "internal"}">${escapeHtml(r.category.toUpperCase())}</span>
               <br><small>${escapeHtml(r.excerpt.slice(0, 200))}</small>
             </li>`,
             )
             .join("\n")}
         </ul>`
      : `<p>No results for "<strong>${escapeHtml(query ?? "")}</strong>".</p>`
    : "";

  const content = `
    <h1>Search</h1>
    <form method="get" action="/search">
      <fieldset role="group">
        <input type="search" name="q" placeholder="Search articles..." value="${escapeHtml(query ?? "")}" autofocus>
        <button type="submit">Search</button>
      </fieldset>
    </form>
    ${resultsHtml}

    <script>
    // Client-side search: load the search index for instant filtering
    (function() {
      let idx = null;
      const form = document.querySelector('form');
      const input = document.querySelector('input[name="q"]');

      async function loadIndex() {
        if (idx) return idx;
        try {
          const resp = await fetch('/api/search?q=&_index=1');
          // The API returns the raw index when _index=1
          idx = await resp.json();
        } catch { idx = []; }
        return idx;
      }

      // Pre-load the index on focus
      input.addEventListener('focus', () => loadIndex(), { once: true });
    })();
    </script>`;

  return renderLayout({
    title: "Search",
    content,
    user,
    activePath: "/search",
    env,
  });
}
