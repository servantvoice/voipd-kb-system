/**
 * Article page template — renders a single KB article with badges,
 * breadcrumbs, and action buttons.
 */

import type { UserContext } from "../auth";
import type { Env } from "../index";
import { renderLayout, escapeHtml } from "./layout";

export interface ArticlePageOptions {
  title: string;
  html: string;
  category: "public" | "internal";
  slug: string;
  breadcrumb: string[];
  user: UserContext;
  kbDomain: string;
  isOverride?: boolean;
  sourceUrl?: string;
  env: Env;
}

export function renderArticlePage(opts: ArticlePageOptions): string {
  const {
    title,
    html,
    category,
    slug,
    breadcrumb,
    user,
    kbDomain,
    isOverride,
    sourceUrl,
    env,
  } = opts;

  // Breadcrumb HTML — show Home > Category (linked), skip the article title
  // since it's already in the h1 below
  const crumbs = [`<li><a href="/">Home</a></li>`];
  if (breadcrumb.length > 0) {
    // First segment is the category name
    crumbs.push(
      `<li><a href="/category/${encodeURIComponent(breadcrumb[0])}">${escapeHtml(breadcrumb[0])}</a></li>`,
    );
  }
  const crumbHtml = crumbs.join("\n        ");

  // Badge
  const badgeClass = category === "public" ? "public" : "internal";
  const badgeLabel = category === "public" ? "PUBLIC" : "INTERNAL";

  // Copy public URL button (only for public articles)
  const publicUrl = `https://${kbDomain}/articles/${slug}`;
  const copyBtn =
    category === "public"
      ? `<button class="copy-btn outline secondary" onclick="navigator.clipboard.writeText('${publicUrl}').then(()=>{this.textContent='Copied!'})">Copy Public URL</button>`
      : "";

  // Edit button (admin = "Edit Override", editor = "Propose Edit")
  const editBtn =
    user.role === "admin"
      ? `<a href="/.admin/override/${escapeHtml(slug)}" role="button" class="outline secondary" style="font-size:0.8rem;">Edit Override</a>
         <a href="/.admin/edit-meta/${escapeHtml(slug)}" role="button" class="outline secondary" style="font-size:0.8rem;">Edit Metadata</a>`
      : user.role === "editor"
        ? `<a href="/.admin/override/${escapeHtml(slug)}" role="button" class="outline secondary" style="font-size:0.8rem;">Propose Edit</a>`
        : "";

  // Override indicator
  const overrideIndicator = isOverride
    ? ` <span class="badge override">Override</span>`
    : "";

  // Source link (opens in new tab)
  const sourceLink = sourceUrl
    ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener" style="font-size:0.8rem;opacity:0.7;">View Original</a>`
    : "";

  const content = `
    <ul class="breadcrumb">
      ${crumbHtml}
    </ul>

    <p>
      <span class="badge ${badgeClass}">${badgeLabel}</span>${overrideIndicator}
      ${copyBtn} ${editBtn} ${sourceLink}
    </p>

    <article>
      ${html}
    </article>`;

  return renderLayout({
    title,
    content,
    user,
    activePath: `/articles/${slug}`,
    env,
  });
}
