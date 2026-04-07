/**
 * Internal Knowledge Base Worker
 *
 * Serves ALL articles (public + internal) from R2 with markdown-to-HTML
 * rendering.  Sits behind Cloudflare Access (Entra ID SSO) at
 * the domain configured in INTERNAL_KB_DOMAIN (wrangler.toml).
 */

import { verifyAccessJwt, type UserContext } from "./auth";
import { renderMarkdown } from "./renderer";
import { loadSearchIndex, searchArticles, type SearchEntry } from "./search";
import { renderLayout, escapeHtml } from "./templates/layout";
import { renderArticlePage } from "./templates/article";
import { renderHomePage } from "./templates/home";
import { renderSearchPage } from "./templates/search";
import {
  handleAdminDashboard,
  handleGetOverrideEditor,
  handlePostOverride,
  handleDeleteOverride,
  handleGetCustomNew,
  handlePostCustom,
  handleGetPending,
  handlePostApprove,
  handlePostReject,
  handleGetEditMeta,
  handlePostEditMeta,
} from "./admin";

// ---------------------------------------------------------------------------
// Env interface
// ---------------------------------------------------------------------------

export interface Env {
  KB_BUCKET: R2Bucket;
  CF_ACCOUNT_ID: string;
  KB_DOMAIN: string;
  INTERNAL_KB_DOMAIN: string;
  ADMIN_EMAILS: string;
  EDITOR_EMAILS: string;
  VIEWER_EMAILS: string;
  CRAWL_SECRET: string;
  PAGES_DEPLOY_HOOK: string;
  BRAND_NAME: string;
  CONNECT_NAME: string;
  CONNECT_DESKTOP_NAME: string;
  SITE_TITLE: string;
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error("Unhandled error:", err);
      return htmlResponse(
        renderLayout({
          title: "Error",
          content: `<h1>Something went wrong</h1><p>An internal error occurred. Please try again later.</p>`,
          user: null,
          env,
        }),
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Authenticate — CF Access should always set the cookie, but handle
  // the edge case where it is missing.
  const user = await verifyAccessJwt(request, env);
  if (!user) {
    return htmlResponse(
      renderLayout({
        title: "Unauthorized",
        content: `<h1>Unauthorized</h1><p>Could not verify your identity. Make sure you are signed in through Cloudflare Access.</p>`,
        user: null,
        env,
      }),
      401,
    );
  }

  // -----------------------------------------------------------------------
  // Public pages
  // -----------------------------------------------------------------------

  if (path === "/" && method === "GET") {
    return handleHome(env, user);
  }

  if (path.startsWith("/articles/") && method === "GET") {
    const slug = path.replace("/articles/", "");
    return handleArticle(slug, env, user);
  }

  if (path.startsWith("/category/") && method === "GET") {
    const category = decodeURIComponent(path.replace("/category/", ""));
    return handleCategory(category, env, user);
  }

  if (path === "/search" && method === "GET") {
    return handleSearch(url, env, user);
  }

  // -----------------------------------------------------------------------
  // Search API
  // -----------------------------------------------------------------------

  if (path === "/api/search" && method === "GET") {
    return handleSearchApi(url, env);
  }

  // -----------------------------------------------------------------------
  // Admin pages (require admin or editor role)
  // -----------------------------------------------------------------------

  if (path === "/.admin/" && method === "GET") {
    if (user.role !== "admin") return forbidden();
    return handleAdminDashboard(env, user);
  }

  if (path.startsWith("/.admin/override/") && method === "GET") {
    if (user.role !== "admin" && user.role !== "editor") return forbidden();
    const slug = path.replace("/.admin/override/", "");
    return handleGetOverrideEditor(slug, env, user);
  }

  if (path === "/.admin/custom/new" && method === "GET") {
    if (user.role !== "admin" && user.role !== "editor") return forbidden();
    return handleGetCustomNew(env, user);
  }

  if (path === "/.admin/pending" && method === "GET") {
    return handleGetPending(env, user);
  }

  if (path.startsWith("/.admin/edit-meta/") && method === "GET") {
    if (user.role !== "admin") return forbidden();
    const slug = path.replace("/.admin/edit-meta/", "");
    return handleGetEditMeta(slug, env, user);
  }

  // -----------------------------------------------------------------------
  // Admin API
  // -----------------------------------------------------------------------

  if (path.startsWith("/api/admin/override/") && method === "POST") {
    if (user.role !== "admin" && user.role !== "editor") return forbidden();
    const slug = path.replace("/api/admin/override/", "");
    return handlePostOverride(slug, request, env, user);
  }

  if (path.startsWith("/api/admin/override/") && method === "DELETE") {
    if (user.role !== "admin") return forbidden();
    const slug = path.replace("/api/admin/override/", "");
    return handleDeleteOverride(slug, env, user);
  }

  if (path.startsWith("/api/admin/custom/") && method === "POST") {
    if (user.role !== "admin" && user.role !== "editor") return forbidden();
    const slug = path.replace("/api/admin/custom/", "");
    return handlePostCustom(slug, request, env, user);
  }

  if (path.startsWith("/api/admin/approve/") && method === "POST") {
    if (user.role !== "admin") return forbidden();
    const slug = decodeURIComponent(path.replace("/api/admin/approve/", ""));
    return handlePostApprove(slug, request, env, user);
  }

  if (path.startsWith("/api/admin/reject/") && method === "POST") {
    if (user.role !== "admin") return forbidden();
    const slug = decodeURIComponent(path.replace("/api/admin/reject/", ""));
    return handlePostReject(slug, request, env, user);
  }

  if (path.startsWith("/api/admin/edit-meta/") && method === "POST") {
    if (user.role !== "admin") return forbidden();
    const slug = decodeURIComponent(path.replace("/api/admin/edit-meta/", ""));
    return handlePostEditMeta(slug, request, env, user);
  }

  // -----------------------------------------------------------------------
  // 404
  // -----------------------------------------------------------------------

  return htmlResponse(
    renderLayout({
      title: "Not Found",
      content: `<h1>Page not found</h1><p>The page <code>${escapeHtml(path)}</code> does not exist.</p><p><a href="/">Go home</a></p>`,
      user,
      env,
    }),
    404,
  );
}

// ---------------------------------------------------------------------------
// Page handlers
// ---------------------------------------------------------------------------

interface ArticleMeta {
  slug: string;
  title: string;
  category: string;
  sourceUrl?: string;
  lastCrawled?: string;
  isOverride?: boolean;
  breadcrumb?: string[];
}

interface SiteManifest {
  articles: ArticleMeta[];
  categories: Record<
    string,
    {
      articles: ArticleMeta[];
    }
  >;
}

async function loadManifest(bucket: R2Bucket): Promise<SiteManifest | null> {
  try {
    const obj = await bucket.get("processed/_site-manifest.json");
    if (!obj) return null;
    const raw = (await obj.json()) as ArticleMeta[] | SiteManifest;

    // Pipeline writes a flat array; convert to categorized structure
    if (Array.isArray(raw)) {
      const categories: Record<string, { articles: ArticleMeta[] }> = {};
      for (const article of raw) {
        // Use first breadcrumb segment as category, or "General"
        const catName =
          article.breadcrumb && article.breadcrumb.length > 0
            ? article.breadcrumb[0]
            : "General";
        if (!categories[catName]) {
          categories[catName] = { articles: [] };
        }
        categories[catName].articles.push(article);
      }
      return { articles: raw, categories };
    }

    return raw;
  } catch {
    return null;
  }
}

async function handleHome(env: Env, user: UserContext): Promise<Response> {
  const manifest = await loadManifest(env.KB_BUCKET);

  if (!manifest) {
    return htmlResponse(
      renderLayout({
        title: "Home",
        content: `<h1>Knowledge Base</h1><p>No site manifest found. The crawler may not have run yet.</p>`,
        user,
        activePath: "/",
        env,
      }),
    );
  }

  const categories = Object.entries(manifest.categories).map(
    ([name, data]) => {
      const publicCount = data.articles.filter(
        (a) => a.category === "public",
      ).length;
      const internalCount = data.articles.filter(
        (a) => a.category === "internal" || a.category !== "public",
      ).length;
      return {
        name,
        count: data.articles.length,
        publicCount,
        internalCount: data.articles.length - publicCount,
      };
    },
  );

  return htmlResponse(renderHomePage({ categories, user, env }));
}

async function handleArticle(
  slug: string,
  env: Env,
  user: UserContext,
): Promise<Response> {
  // Priority: override > custom-article > processed
  let md: string | null = null;
  let category: "public" | "internal" = "public";
  let title = slug.split("/").pop() ?? slug;
  let isOverride = false;
  let sourceUrl: string | undefined;

  // Check override first
  const overrideObj = await env.KB_BUCKET.get(`overrides/${slug}/index.md`);
  if (overrideObj) {
    md = await overrideObj.text();
    isOverride = true;
    const metaObj = await env.KB_BUCKET.get(`overrides/${slug}/_meta.json`);
    if (metaObj) {
      try {
        const meta = (await metaObj.json()) as Record<string, unknown>;
        if (meta.category === "internal") category = "internal";
        if (typeof meta.title === "string") title = meta.title;
      } catch {
        /* ignore */
      }
    }
  }

  // Check custom article
  if (!md) {
    const customObj = await env.KB_BUCKET.get(
      `custom-articles/${slug}/index.md`,
    );
    if (customObj) {
      md = await customObj.text();
      const metaObj = await env.KB_BUCKET.get(
        `custom-articles/${slug}/_meta.json`,
      );
      if (metaObj) {
        try {
          const meta = (await metaObj.json()) as Record<string, unknown>;
          if (meta.category === "internal") category = "internal";
          if (typeof meta.title === "string") title = meta.title;
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Check processed (crawled) article
  if (!md) {
    const processedObj = await env.KB_BUCKET.get(
      `processed/${slug}/index.md`,
    );
    if (processedObj) {
      md = await processedObj.text();
      const metaObj = await env.KB_BUCKET.get(
        `processed/${slug}/_meta.json`,
      );
      if (metaObj) {
        try {
          const meta = (await metaObj.json()) as Record<string, unknown>;
          if (meta.category === "internal") category = "internal";
          if (typeof meta.title === "string") title = meta.title;
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (!md) {
    return htmlResponse(
      renderLayout({
        title: "Not Found",
        content: `<h1>Article not found</h1><p>No article at <code>${escapeHtml(slug)}</code>.</p><p><a href="/">Go home</a></p>`,
        user,
        env,
      }),
      404,
    );
  }

  // Extract title from first H1 if present
  const h1Match = md.match(/^#\s+(.+)$/m);
  if (h1Match) {
    title = h1Match[1].trim();
  }

  const html = renderMarkdown(md);

  // Get breadcrumb from metadata if available, otherwise build from slug
  let breadcrumb: string[] = [];
  const metaSources = [
    `processed/${slug}/_meta.json`,
    `overrides/${slug}/_meta.json`,
    `custom-articles/${slug}/_meta.json`,
  ];
  for (const metaKey of metaSources) {
    const metaObj = await env.KB_BUCKET.get(metaKey);
    if (metaObj) {
      try {
        const meta = (await metaObj.json()) as Record<string, unknown>;
        if (Array.isArray(meta.breadcrumb) && meta.breadcrumb.length > 0) {
          breadcrumb = meta.breadcrumb as string[];
        }
        if (typeof meta.sourceUrl === "string" && !sourceUrl) {
          sourceUrl = meta.sourceUrl;
        }
        if (breadcrumb.length > 0) break;
      } catch {
        /* ignore */
      }
    }
  }
  if (breadcrumb.length === 0) {
    // Fallback: humanize slug segments when metadata lacks breadcrumb
    breadcrumb = slug.split("/").filter(Boolean).map((s) => {
      const lower = s.toLowerCase();
      if (lower === "cloudieconnect-desktop") return env.CONNECT_DESKTOP_NAME;
      if (lower === "cloudieconnect" || lower === "cloudie_connect") return env.CONNECT_NAME;
      let name = s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      name = name.replace(/\bE 911\b/g, "E-911");
      name = name.replace(/\bSms Mms\b/g, "SMS / MMS");
      name = name.replace(/\bFaqs\b/g, "FAQs");
      name = name.replace(/\bOb /g, "OneBill - ");
      name = name.replace(/\bOnebill\b/g, "OneBill");
      name = name.replace(/\bSnapbuilder\b/g, "SNAPbuilder");
      name = name.replace(/\bTeammate /g, "TeamMate ");
      name = name.replace(/\bUc /g, "UC ");
      name = name.replace(/\bVoipmonitor\b/g, "VoIPMonitor");
      name = name.replace(/\bCdrs\b/g, "CDRs");
      name = name.replace(/\bNdp\b/g, "NDP");
      name = name.replace(/\bSip /g, "SIP ");
      name = name.replace(/\bPbx\b/g, "PBX");
      name = name.replace(/\bMfax\b/g, "mFax");
      name = name.replace(/\bHardware Software\b/g, "Hardware & Software");
      name = name.replace(/\bCaller Id\b/g, "Caller ID");
      name = name.replace(/\bApi /g, "API ");
      name = name.replace(/\bLocal Toll Free Porting\b/g, "Local & Toll Free Porting");
      return name;
    });
  }

  return htmlResponse(
    renderArticlePage({
      title,
      html,
      category,
      slug,
      breadcrumb,
      user,
      kbDomain: env.KB_DOMAIN,
      isOverride,
      sourceUrl,
      env,
    }),
  );
}

async function handleCategory(
  categoryName: string,
  env: Env,
  user: UserContext,
): Promise<Response> {
  const manifest = await loadManifest(env.KB_BUCKET);
  if (!manifest || !manifest.categories[categoryName]) {
    return htmlResponse(
      renderLayout({
        title: "Not Found",
        content: `<h1>Category not found</h1><p>No category named "${escapeHtml(categoryName)}".</p><p><a href="/">Go home</a></p>`,
        user,
        env,
      }),
      404,
    );
  }

  const cat = manifest.categories[categoryName];
  const articleList = cat.articles
    .map(
      (a) => `
      <tr data-category="${a.category === "public" ? "public" : "internal"}">
        <td><a href="/articles/${escapeHtml(a.slug)}">${escapeHtml(a.title)}</a></td>
        <td><span class="badge ${a.category === "public" ? "public" : "internal"}">${escapeHtml((a.category || "public").toUpperCase())}</span></td>
      </tr>`,
    )
    .join("\n");

  const content = `
    <nav>
      <ul class="breadcrumb">
        <li><a href="/">Home</a></li>
        <li>${escapeHtml(categoryName)}</li>
      </ul>
    </nav>
    <h1>${escapeHtml(categoryName)}</h1>
    <p>${cat.articles.length} article${cat.articles.length !== 1 ? "s" : ""}</p>
    <div class="filter-bar">
      <label>Show:</label>
      <button class="outline" data-filter="all">All</button>
      <button class="outline" data-filter="public">Public Only</button>
      <button class="outline" data-filter="internal">Internal Only</button>
    </div>
    <table>
      <thead><tr><th>Article</th><th>Category</th></tr></thead>
      <tbody>${articleList}</tbody>
    </table>`;

  return htmlResponse(
    renderLayout({
      title: categoryName,
      content,
      user,
      activePath: `/category/${categoryName}`,
      env,
    }),
  );
}

async function handleSearch(
  url: URL,
  env: Env,
  user: UserContext,
): Promise<Response> {
  const query = url.searchParams.get("q") ?? "";

  if (!query.trim()) {
    return htmlResponse(renderSearchPage({ user, env }));
  }

  const index = await loadSearchIndex(env.KB_BUCKET);
  const results = searchArticles(index, query);

  return htmlResponse(renderSearchPage({ query, results, user, env }));
}

async function handleSearchApi(url: URL, env: Env): Promise<Response> {
  const query = url.searchParams.get("q") ?? "";
  const wantIndex = url.searchParams.get("_index") === "1";

  const index = await loadSearchIndex(env.KB_BUCKET);

  if (wantIndex) {
    return new Response(JSON.stringify(index), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const results = searchArticles(index, query);
  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

function forbidden(): Response {
  return new Response("Forbidden", { status: 403 });
}
