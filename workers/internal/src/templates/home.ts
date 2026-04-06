/**
 * Home page — shows a grid of article categories.
 */

import type { UserContext } from "../auth";
import type { Env } from "../index";
import { renderLayout, escapeHtml } from "./layout";

export interface HomePageOptions {
  categories: Array<{
    name: string;
    count: number;
    publicCount: number;
    internalCount: number;
  }>;
  user: UserContext;
  env: Env;
}

export function renderHomePage(opts: HomePageOptions): string {
  const { categories, user, env } = opts;

  const brandName = env?.BRAND_NAME || "Knowledge Base";

  const rows = categories
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (cat) => `
      <div class="cat-row" data-public="${cat.publicCount}" data-internal="${cat.internalCount}">
        <a href="/category/${encodeURIComponent(cat.name)}"><strong>${escapeHtml(cat.name)}</strong></a>
        <span class="cat-counts">
          ${cat.count} &mdash;
          <span class="badge public">PUBLIC</span>&nbsp;${cat.publicCount}
          &nbsp;
          <span class="badge internal">INTERNAL</span>&nbsp;${cat.internalCount}
        </span>
      </div>`,
    )
    .join("\n");

  const content = `
    <h1>Knowledge Base</h1>
    <p>Browse all ${escapeHtml(brandName)} documentation — public and internal articles.</p>
    <div class="filter-bar">
      <label>Show:</label>
      <button class="outline" data-filter="all">All</button>
      <button class="outline" data-filter="public">Public Only</button>
      <button class="outline" data-filter="internal">Internal Only</button>
    </div>
    ${rows}`;

  return renderLayout({ title: "Home", content, user, activePath: "/", env });
}
