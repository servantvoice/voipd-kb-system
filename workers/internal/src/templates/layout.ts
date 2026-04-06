/**
 * Base HTML layout used by every page.
 * Uses Pico CSS for minimal, classless styling.
 */

import type { UserContext } from "../auth";
import type { Env } from "../index";

export interface LayoutOptions {
  title: string;
  content: string;
  user: UserContext | null;
  nav?: string;
  activePath?: string;
  env?: Env;
}

export function renderLayout(opts: LayoutOptions): string {
  const { title, content, user, activePath, env } = opts;

  const siteTitle = env?.SITE_TITLE || "Knowledge Base";
  const brandName = env?.BRAND_NAME || "Knowledge Base";

  const adminNav =
    user?.role === "admin"
      ? `
        <li><a href="/.admin/"${activePath === "/.admin/" ? ' aria-current="page"' : ""}>Admin</a></li>
        <li><a href="/.admin/pending"${activePath === "/.admin/pending" ? ' aria-current="page"' : ""}>Pending Review</a></li>
        <li><a href="/.admin/custom/new"${activePath === "/.admin/custom/new" ? ' aria-current="page"' : ""}>New Article</a></li>`
      : "";

  const editorNav =
    user?.role === "editor"
      ? `
        <li><a href="/.admin/pending"${activePath === "/.admin/pending" ? ' aria-current="page"' : ""}>Pending Review</a></li>
        <li><a href="/.admin/custom/new"${activePath === "/.admin/custom/new" ? ' aria-current="page"' : ""}>New Article</a></li>`
      : "";

  const userBadge = user
    ? `<span style="font-size:0.85rem;opacity:0.8;">User: ${escapeHtml(user.email)}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - ${escapeHtml(siteTitle)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
  <style>
    :root {
      --pico-font-size: 16px;
    }
    .badge {
      display: inline-block;
      padding: 0.15em 0.55em;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      vertical-align: middle;
    }
    .badge.public {
      background: #16a34a;
      color: #fff;
    }
    .badge.internal {
      background: #d97706;
      color: #fff;
    }
    .badge.override {
      background: #6366f1;
      color: #fff;
    }
    .site-header {
      border-bottom: 1px solid var(--pico-muted-border-color);
      margin-bottom: 1.5rem;
    }
    .site-header nav {
      padding-top: 0.5rem;
      padding-bottom: 0.5rem;
    }
    .search-box {
      max-width: 220px;
    }
    .site-footer {
      border-top: 1px solid var(--pico-muted-border-color);
      margin-top: 2rem;
      padding: 1rem 0;
      text-align: center;
      font-size: 0.85rem;
      opacity: 0.7;
    }
    .breadcrumb {
      list-style: none !important;
      display: flex;
      flex-wrap: wrap;
      gap: 0;
      padding: 0 !important;
      margin: 0 0 0.5rem 0 !important;
      font-size: 0.9rem;
    }
    .breadcrumb li {
      padding: 0;
      margin: 0;
    }
    .breadcrumb li:not(:last-child)::after {
      content: " / ";
      margin: 0 0.4em;
      opacity: 0.5;
    }
    .article-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }
    .copy-btn {
      cursor: pointer;
      font-size: 0.8rem;
    }
    .filter-bar {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }
    .filter-bar label {
      margin: 0;
      font-weight: 600;
    }
    .filter-bar button {
      padding: 0.25em 0.75em;
      margin: 0;
      font-size: 0.85rem;
      width: auto;
    }
    .filter-bar button.outline:not(.active) {
      opacity: 0.6;
    }
    .filter-bar button.active {
      opacity: 1;
    }
    [data-category].filtered-out {
      display: none !important;
    }
    .cat-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 0.4rem 0;
      border-bottom: 1px solid var(--pico-muted-border-color);
    }
    .cat-row:last-child {
      border-bottom: none;
    }
    .cat-counts {
      font-size: 0.85rem;
      opacity: 0.7;
      white-space: nowrap;
    }
    .callout {
      border: 1px solid #d0d7de;
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
    }
    .callout h2, .callout h3 {
      font-size: 1rem;
      margin-top: 0;
      margin-bottom: 0.25rem;
    }
    .callout p, .callout ul {
      font-size: 0.9rem;
      margin-bottom: 0.25rem;
    }
    .callout ul {
      padding-left: 1.25rem;
    }
    .callout-scope {
      background-color: #f0f7ff;
      border-color: #b6d4fe;
    }
    .callout-req {
      background-color: #f0fdf4;
      border-color: #a7f3d0;
    }
    .callout-warn {
      background-color: #fef2f2;
      border-color: #fca5a5;
    }
  </style>
</head>
<body>
  <header class="site-header container">
    <nav>
      <ul>
        <li><a href="/"><strong>${escapeHtml(brandName)}</strong></a></li>
      </ul>
      <ul>
        <li><a href="/"${activePath === "/" ? ' aria-current="page"' : ""}>Home</a></li>
        <li><a href="/search"${activePath === "/search" ? ' aria-current="page"' : ""}>Search</a></li>
        ${adminNav}${editorNav}
        <li>${userBadge}</li>
      </ul>
    </nav>
  </header>

  <main class="container">
    ${content}
  </main>

  <footer class="site-footer container">
    Powered by ${escapeHtml(brandName)}
  </footer>
  <script>
    (function(){
      function getCookie(n){var m=document.cookie.match('(^|;)\\\\s*'+n+'=([^;]*)');return m?m[2]:null;}
      function setCookie(n,v){document.cookie=n+'='+v+';path=/;max-age=31536000;SameSite=Lax';}
      var filter=getCookie('kb-filter')||'all';
      function applyFilter(f){
        filter=f;setCookie('kb-filter',f);
        document.querySelectorAll('[data-category]').forEach(function(el){
          var cat=el.getAttribute('data-category');
          if(f==='all')el.classList.remove('filtered-out');
          else if(cat!==f)el.classList.add('filtered-out');
          else el.classList.remove('filtered-out');
        });
        document.querySelectorAll('.filter-bar button[data-filter]').forEach(function(b){
          b.classList.toggle('active',b.getAttribute('data-filter')===f);
        });
        // Update category counts visibility on home page
        document.querySelectorAll('.cat-row').forEach(function(row){
          if(f==='all'){row.style.display='';return;}
          var pub=parseInt(row.getAttribute('data-public')||'0');
          var int=parseInt(row.getAttribute('data-internal')||'0');
          if(f==='public'&&pub===0)row.style.display='none';
          else if(f==='internal'&&int===0)row.style.display='none';
          else row.style.display='';
        });
      }
      document.addEventListener('click',function(e){
        var btn=e.target.closest('[data-filter]');
        if(btn)applyFilter(btn.getAttribute('data-filter'));
      });
      // Apply on load
      if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){applyFilter(filter);});
      else applyFilter(filter);
    })();
  </script>
</body>
</html>`;
}

/** Minimal HTML entity escaping. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
