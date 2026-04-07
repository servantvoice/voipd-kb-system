/**
 * Admin API handlers — override editor, custom articles, editorial approval.
 *
 * Admins write directly to `overrides/` and `custom-articles/`.
 * Editors write to `editorial/pending/` for review.
 */

import type { Env } from "./index";
import type { UserContext } from "./auth";
import { renderLayout, escapeHtml } from "./templates/layout";
import { renderMarkdown } from "./renderer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArticleMeta {
  slug: string;
  title: string;
  category: "public" | "internal";
  author: string;
  createdAt: string;
  updatedAt: string;
  status: "live" | "pending";
  breadcrumb?: string[];
  displayCategory?: string;
  sourceUrl?: string;
  lastCrawled?: string;
  isOverride?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Admin dashboard
// ---------------------------------------------------------------------------

export async function handleAdminDashboard(
  env: Env,
  user: UserContext,
): Promise<Response> {
  const content = `
    <h1>Admin Dashboard</h1>
    <div class="article-grid">
      <article>
        <header><strong>Overrides</strong></header>
        <p>Edit existing articles with custom content that replaces the crawled version.</p>
        <footer><a href="/search" role="button" class="outline">Find article to override</a></footer>
      </article>
      <article>
        <header><strong>Custom Articles</strong></header>
        <p>Create entirely new internal-only articles.</p>
        <footer><a href="/.admin/custom/new" role="button" class="outline">New Custom Article</a></footer>
      </article>
      <article>
        <header><strong>Pending Review</strong></header>
        <p>Editor submissions awaiting approval.</p>
        <footer><a href="/.admin/pending" role="button" class="outline">View Queue</a></footer>
      </article>
    </div>`;

  return htmlResponse(
    renderLayout({
      title: "Admin",
      content,
      user,
      activePath: "/.admin/",
      env,
    }),
  );
}

// ---------------------------------------------------------------------------
// Override editor
// ---------------------------------------------------------------------------

export async function handleGetOverrideEditor(
  slug: string,
  env: Env,
  user: UserContext,
): Promise<Response> {
  // Load existing processed article
  let existingMd = "";
  let existingCategory: "public" | "internal" = "public";

  const processedObj = await env.KB_BUCKET.get(
    `processed/${slug}/index.md`,
  );
  if (processedObj) {
    existingMd = await processedObj.text();
  }

  const metaObj = await env.KB_BUCKET.get(
    `processed/${slug}/_meta.json`,
  );
  if (metaObj) {
    try {
      const meta = (await metaObj.json()) as Record<string, unknown>;
      if (meta.category === "internal") existingCategory = "internal";
    } catch {
      /* ignore */
    }
  }

  // Load existing override if any
  const overrideObj = await env.KB_BUCKET.get(
    `overrides/${slug}/index.md`,
  );
  if (overrideObj) {
    existingMd = await overrideObj.text();
    const overrideMeta = await env.KB_BUCKET.get(
      `overrides/${slug}/_meta.json`,
    );
    if (overrideMeta) {
      try {
        const m = (await overrideMeta.json()) as Record<string, unknown>;
        if (m.category === "internal") existingCategory = "internal";
        if (m.category === "public") existingCategory = "public";
      } catch {
        /* ignore */
      }
    }
  }

  // Get existing title from metadata
  let existingTitle = slug.split("/").pop() ?? slug;
  const processedMeta = await env.KB_BUCKET.get(`processed/${slug}/_meta.json`);
  if (processedMeta) {
    try {
      const m = (await processedMeta.json()) as Record<string, unknown>;
      if (typeof m.title === "string") existingTitle = m.title;
    } catch { /* ignore */ }
  }

  // NOTE: The preview script uses DOMPurify to sanitize rendered HTML before
  // inserting it into the DOM, which is the recommended approach for UGC.
  const content = `
    <h1>${user.role === "admin" ? "Edit Override" : "Propose Edit"}</h1>
    <form method="post" action="/api/admin/override/${escapeHtml(slug)}">
      <label>Article Path</label>
      <input type="text" value="${escapeHtml(slug)}" disabled style="opacity:0.7;">

      <label for="title">Title</label>
      <input type="text" id="title" name="title" value="${escapeHtml(existingTitle)}" required>

      <label for="category">Category</label>
      <select id="category" name="category">
        <option value="public"${existingCategory === "public" ? " selected" : ""}>Public</option>
        <option value="internal"${existingCategory === "internal" ? " selected" : ""}>Internal</option>
      </select>

      <label for="content">Content (Markdown)</label>
      <textarea id="content" name="content" rows="20" style="font-family:monospace;">${escapeHtml(existingMd)}</textarea>

      <div style="display:flex;gap:1rem;align-items:center;">
        <button type="submit">${user.role === "admin" ? "Save Override" : "Submit for Review"}</button>
        ${user.role === "admin" ? `<button type="button" class="outline secondary" onclick="if(confirm('Delete this override?'))fetch('/api/admin/override/${escapeHtml(slug)}',{method:'DELETE'}).then(()=>location.href='/articles/${escapeHtml(slug)}')">Delete Override</button>` : ""}
      </div>
    </form>

    <h2>Preview</h2>
    <article id="preview"></article>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js"></script>
    <script>
      const ta = document.getElementById('content');
      const preview = document.getElementById('preview');
      function updatePreview() {
        const rendered = marked.parse(ta.value || '');
        // DOMPurify sanitizes all rendered HTML before DOM insertion
        preview.innerHTML = DOMPurify.sanitize(rendered);
      }
      ta.addEventListener('input', updatePreview);
      updatePreview();
    </script>`;

  return htmlResponse(
    renderLayout({
      title: `Override: ${slug}`,
      content,
      user,
      activePath: "/.admin/",
      env,
    }),
  );
}

export async function handlePostOverride(
  slug: string,
  request: Request,
  env: Env,
  user: UserContext,
): Promise<Response> {
  const formData = await request.formData();
  const title = (formData.get("title") as string) ?? slug;
  const category = (formData.get("category") as string) === "internal" ? "internal" : "public";
  const mdContent = (formData.get("content") as string) ?? "";

  const now = new Date().toISOString();
  const prefix =
    user.role === "admin" ? `overrides/${slug}` : `editorial/pending/override-${slug.replace(/\//g, "--")}`;

  const meta: ArticleMeta = {
    slug,
    title,
    category,
    author: user.email,
    createdAt: now,
    updatedAt: now,
    status: user.role === "admin" ? "live" : "pending",
  };

  const writes: Promise<R2Object>[] = [
    env.KB_BUCKET.put(`${prefix}/index.md`, mdContent, {
      httpMetadata: { contentType: "text/markdown" },
    }),
    env.KB_BUCKET.put(`${prefix}/_meta.json`, JSON.stringify(meta, null, 2), {
      httpMetadata: { contentType: "application/json" },
    }),
  ];

  // Also write to processed/ so the Hugo public site picks up override content
  if (user.role === "admin") {
    writes.push(
      env.KB_BUCKET.put(`processed/${slug}/index.md`, mdContent, {
        httpMetadata: { contentType: "text/markdown" },
      }),
    );
  }

  await Promise.all(writes);

  if (user.role === "admin") {
    return Response.redirect(
      `https://${env.INTERNAL_KB_DOMAIN}/articles/${slug}`,
      303,
    );
  }
  // Editor: redirect to pending page
  return Response.redirect(
    `https://${env.INTERNAL_KB_DOMAIN}/.admin/pending`,
    303,
  );
}

export async function handleDeleteOverride(
  slug: string,
  env: Env,
  user: UserContext,
): Promise<Response> {
  if (user.role !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }

  await Promise.all([
    env.KB_BUCKET.delete(`overrides/${slug}/index.md`),
    env.KB_BUCKET.delete(`overrides/${slug}/_meta.json`),
  ]);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Custom articles
// ---------------------------------------------------------------------------

export async function handleGetCustomNew(
  env: Env,
  user: UserContext,
): Promise<Response> {
  const content = `
    <h1>New Custom Article</h1>
    <form method="post" action="/api/admin/custom/new" id="customForm">
      <label for="slug">Slug (e.g. "internal-guides/vpn-setup")</label>
      <input type="text" id="slug" name="slug" placeholder="category/article-name" required
             pattern="[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*">

      <label for="title">Title</label>
      <input type="text" id="title" name="title" required>

      <label for="category">Category</label>
      <select id="category" name="category">
        <option value="internal" selected>Internal</option>
        <option value="public">Public</option>
      </select>

      <label for="content">Content (Markdown)</label>
      <textarea id="content" name="content" rows="20" style="font-family:monospace;"></textarea>

      <button type="submit">Create Article</button>
    </form>
    <script>
      document.getElementById('customForm').addEventListener('submit', function(e) {
        const slug = document.getElementById('slug').value;
        this.action = '/api/admin/custom/' + encodeURIComponent(slug);
      });
    </script>`;

  return htmlResponse(
    renderLayout({
      title: "New Custom Article",
      content,
      user,
      activePath: "/.admin/custom/new",
      env,
    }),
  );
}

export async function handlePostCustom(
  slug: string,
  request: Request,
  env: Env,
  user: UserContext,
): Promise<Response> {
  const formData = await request.formData();
  const title = (formData.get("title") as string) ?? slug;
  const category = (formData.get("category") as string) === "public" ? "public" : "internal";
  const mdContent = (formData.get("content") as string) ?? "";

  const now = new Date().toISOString();
  const prefix =
    user.role === "admin"
      ? `custom-articles/${slug}`
      : `editorial/pending/custom-${slug.replace(/\//g, "--")}`;

  const meta: ArticleMeta = {
    slug,
    title,
    category,
    author: user.email,
    createdAt: now,
    updatedAt: now,
    status: user.role === "admin" ? "live" : "pending",
  };

  const writes: Promise<unknown>[] = [
    env.KB_BUCKET.put(`${prefix}/index.md`, mdContent, {
      httpMetadata: { contentType: "text/markdown" },
    }),
    env.KB_BUCKET.put(`${prefix}/_meta.json`, JSON.stringify(meta, null, 2), {
      httpMetadata: { contentType: "application/json" },
    }),
  ];

  // Admin: also write to processed/ and update site manifest
  if (user.role === "admin") {
    writes.push(
      env.KB_BUCKET.put(`processed/${slug}/index.md`, mdContent, {
        httpMetadata: { contentType: "text/markdown" },
      }),
      env.KB_BUCKET.put(
        `processed/${slug}/_meta.json`,
        JSON.stringify(meta, null, 2),
        { httpMetadata: { contentType: "application/json" } },
      ),
    );
  }

  await Promise.all(writes);

  // Update site manifest with the new article
  if (user.role === "admin") {
    await addToSiteManifest(env, meta);

    // Trigger Pages rebuild if public
    if (meta.category === "public" && env.PAGES_DEPLOY_HOOK) {
      try {
        await fetch(env.PAGES_DEPLOY_HOOK, { method: "POST" });
      } catch { /* non-fatal */ }
    }

    return Response.redirect(
      `https://${env.INTERNAL_KB_DOMAIN}/articles/${slug}`,
      303,
    );
  }
  return Response.redirect(
    `https://${env.INTERNAL_KB_DOMAIN}/.admin/pending`,
    303,
  );
}

// ---------------------------------------------------------------------------
// Pending review queue
// ---------------------------------------------------------------------------

export async function handleGetPending(
  env: Env,
  user: UserContext,
): Promise<Response> {
  if (user.role !== "admin" && user.role !== "editor") {
    return new Response("Forbidden", { status: 403 });
  }

  // List all objects in editorial/pending/
  const listed = await env.KB_BUCKET.list({ prefix: "editorial/pending/" });
  const metaFiles = listed.objects.filter((obj) =>
    obj.key.endsWith("/_meta.json"),
  );

  const items: ArticleMeta[] = [];
  for (const obj of metaFiles) {
    try {
      const data = await env.KB_BUCKET.get(obj.key);
      if (data) {
        items.push((await data.json()) as ArticleMeta);
      }
    } catch {
      /* skip broken entries */
    }
  }

  // Build preview data for each pending item
  const pendingPreviews: Array<{ meta: ArticleMeta; keyPrefix: string; html: string }> = [];
  for (const item of items) {
    const keyPrefix = metaFiles.find((f) =>
      f.key.includes(item.slug.replace(/\//g, "--")),
    )?.key.replace("/_meta.json", "") ?? "";
    let html = "";
    if (keyPrefix) {
      const mdObj = await env.KB_BUCKET.get(keyPrefix + "/index.md");
      if (mdObj) {
        html = renderMarkdown(await mdObj.text());
      }
    }
    pendingPreviews.push({ meta: item, keyPrefix, html });
  }

  const rows =
    pendingPreviews.length === 0
      ? "<p>No pending items.</p>"
      : pendingPreviews
          .map(
            ({ meta: item, keyPrefix, html: previewHtml }) => `
          <article style="border:1px solid var(--pico-muted-border-color);padding:1rem;margin-bottom:1rem;">
            <header style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">
              <div>
                <strong>${escapeHtml(item.title)}</strong>
                <span class="badge ${item.category}" style="margin-left:0.5rem;">${item.category.toUpperCase()}</span>
              </div>
              <div style="font-size:0.85rem;opacity:0.7;">
                by ${escapeHtml(item.author)} &middot; ${escapeHtml(item.slug)}
              </div>
            </header>
            <details>
              <summary style="cursor:pointer;font-size:0.9rem;">Preview content</summary>
              <div style="border-top:1px solid var(--pico-muted-border-color);margin-top:0.5rem;padding-top:0.5rem;">
                ${previewHtml || "<p><em>No content available</em></p>"}
              </div>
            </details>
            <footer style="margin-top:0.75rem;">
              ${user.role === "admin" ? `<form method="post" action="/api/admin/approve/${encodeURIComponent(item.slug)}" style="display:inline;">
                <input type="hidden" name="key_prefix" value="${escapeHtml(keyPrefix)}">
                <button type="submit" class="outline" style="font-size:0.8rem;">Approve</button>
              </form>
              <button type="button" class="outline secondary" style="font-size:0.8rem;margin-left:0.5rem;" onclick="if(confirm('Reject and delete this pending edit?'))fetch('/api/admin/reject/${encodeURIComponent(item.slug)}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key_prefix:'${escapeHtml(keyPrefix)}'})}).then(()=>location.reload())">Reject</button>` : `<span style="font-size:0.8rem;opacity:0.6;">Awaiting admin review</span>`}
            </footer>
          </article>`,
          )
          .join("\n");

  const content = `
    <h1>Pending Review</h1>
    ${rows}`;

  return htmlResponse(
    renderLayout({
      title: "Pending Review",
      content,
      user,
      activePath: "/.admin/pending",
      env,
    }),
  );
}

export async function handlePostApprove(
  slug: string,
  request: Request,
  env: Env,
  user: UserContext,
): Promise<Response> {
  if (user.role !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }

  const formData = await request.formData();
  const keyPrefix = formData.get("key_prefix") as string;

  if (!keyPrefix) {
    return new Response("Missing key_prefix", { status: 400 });
  }

  // Read the pending content
  const [mdObj, metaObj] = await Promise.all([
    env.KB_BUCKET.get(`${keyPrefix}/index.md`),
    env.KB_BUCKET.get(`${keyPrefix}/_meta.json`),
  ]);

  if (!mdObj || !metaObj) {
    return new Response("Pending item not found", { status: 404 });
  }

  const mdContent = await mdObj.text();
  const meta = (await metaObj.json()) as ArticleMeta;

  // Determine destination: override-* → overrides/, custom-* → custom-articles/
  const pendingName = keyPrefix.split("/").pop() ?? "";
  let destPrefix: string;
  if (pendingName.startsWith("override-")) {
    destPrefix = `overrides/${meta.slug}`;
  } else {
    destPrefix = `custom-articles/${meta.slug}`;
  }

  // Update meta to live
  meta.status = "live";
  meta.updatedAt = new Date().toISOString();

  // Write to final location and delete pending
  const writes: Promise<unknown>[] = [
    env.KB_BUCKET.put(`${destPrefix}/index.md`, mdContent, {
      httpMetadata: { contentType: "text/markdown" },
    }),
    env.KB_BUCKET.put(
      `${destPrefix}/_meta.json`,
      JSON.stringify(meta, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    ),
    env.KB_BUCKET.delete(`${keyPrefix}/index.md`),
    env.KB_BUCKET.delete(`${keyPrefix}/_meta.json`),
  ];

  // For public articles, also write to processed/ for immediate publishing
  if (meta.category === "public") {
    writes.push(
      env.KB_BUCKET.put(`processed/${meta.slug}/index.md`, mdContent, {
        httpMetadata: { contentType: "text/markdown" },
      }),
      env.KB_BUCKET.put(
        `processed/${meta.slug}/_meta.json`,
        JSON.stringify(meta, null, 2),
        { httpMetadata: { contentType: "application/json" } },
      ),
    );
  }

  await Promise.all(writes);

  // Trigger Pages rebuild for public overrides
  if (meta.category === "public" && env.PAGES_DEPLOY_HOOK) {
    try {
      await fetch(env.PAGES_DEPLOY_HOOK, { method: "POST" });
    } catch {
      // Non-fatal — the override is saved, rebuild will happen on next pipeline run
    }
  }

  return Response.redirect(
    `https://${env.INTERNAL_KB_DOMAIN}/.admin/pending`,
    303,
  );
}

export async function handlePostReject(
  slug: string,
  request: Request,
  env: Env,
  user: UserContext,
): Promise<Response> {
  if (user.role !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }

  const body = (await request.json()) as { key_prefix?: string };
  const keyPrefix = body.key_prefix;

  if (!keyPrefix) {
    return new Response("Missing key_prefix", { status: 400 });
  }

  // Delete the pending content
  await Promise.all([
    env.KB_BUCKET.delete(`${keyPrefix}/index.md`),
    env.KB_BUCKET.delete(`${keyPrefix}/_meta.json`),
  ]);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Category / metadata editing
// ---------------------------------------------------------------------------

export async function handleGetEditMeta(
  slug: string,
  env: Env,
  user: UserContext,
): Promise<Response> {
  // Load current metadata from processed, override, or custom
  let meta: ArticleMeta | null = null;
  for (const prefix of [`overrides/${slug}`, `custom-articles/${slug}`, `processed/${slug}`]) {
    const obj = await env.KB_BUCKET.get(`${prefix}/_meta.json`);
    if (obj) {
      meta = (await obj.json()) as ArticleMeta;
      break;
    }
  }

  if (!meta) {
    return htmlResponse(
      renderLayout({
        title: "Not Found",
        content: `<h1>Article not found</h1><p>No metadata for <code>${escapeHtml(slug)}</code>.</p>`,
        user,
        env,
      }),
      404,
    );
  }

  const currentCategory = meta.displayCategory as string
    || (Array.isArray(meta.breadcrumb) && meta.breadcrumb.length > 0
      ? meta.breadcrumb[0]
      : "General");

  const content = `
    <h1>Edit Article Metadata</h1>
    <form method="post" action="/api/admin/edit-meta/${escapeHtml(slug)}">
      <label>Article Path</label>
      <input type="text" value="${escapeHtml(slug)}" disabled style="opacity:0.7;">

      <label for="title">Title</label>
      <input type="text" id="title" name="title" value="${escapeHtml(meta.title)}" required>

      <label for="displayCategory">Display Category</label>
      <input type="text" id="displayCategory" name="displayCategory" value="${escapeHtml(currentCategory)}" required>
      <small>Changes which category this article appears under on the home page.</small>

      <label for="category">Visibility</label>
      <select id="category" name="category">
        <option value="public"${meta.category === "public" ? " selected" : ""}>Public</option>
        <option value="internal"${meta.category === "internal" ? " selected" : ""}>Internal</option>
      </select>

      <button type="submit">Save Metadata</button>
    </form>`;

  return htmlResponse(
    renderLayout({
      title: `Edit Metadata: ${slug}`,
      content,
      user,
      activePath: "/.admin/",
      env,
    }),
  );
}

export async function handlePostEditMeta(
  slug: string,
  request: Request,
  env: Env,
  user: UserContext,
): Promise<Response> {
  if (user.role !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }

  const formData = await request.formData();
  const title = (formData.get("title") as string) ?? "";
  const displayCategory = (formData.get("displayCategory") as string) ?? "General";
  const category = (formData.get("category") as string) === "public" ? "public" : "internal";

  // Load existing meta from any source
  let existingMeta: Record<string, unknown> = {};
  for (const prefix of [`overrides/${slug}`, `custom-articles/${slug}`, `processed/${slug}`]) {
    const obj = await env.KB_BUCKET.get(`${prefix}/_meta.json`);
    if (obj) {
      existingMeta = (await obj.json()) as Record<string, unknown>;
      break;
    }
  }

  // Update metadata
  const updatedMeta = {
    ...existingMeta,
    slug,
    title: title || existingMeta.title || slug,
    category,
    breadcrumb: [displayCategory, ...(
      Array.isArray(existingMeta.breadcrumb) && existingMeta.breadcrumb.length > 1
        ? (existingMeta.breadcrumb as string[]).slice(1)
        : [title || slug]
    )],
    displayCategory,
    updatedAt: new Date().toISOString(),
  };

  const metaJson = JSON.stringify(updatedMeta, null, 2);

  // Write to processed/ (affects both sites)
  await env.KB_BUCKET.put(`processed/${slug}/_meta.json`, metaJson, {
    httpMetadata: { contentType: "application/json" },
  });

  // Always persist metadata to overrides/ so it survives pipeline re-runs.
  // The pipeline worker checks overrides/_meta.json and merges category,
  // displayCategory, and breadcrumb from it when building metadata.
  await env.KB_BUCKET.put(`overrides/${slug}/_meta.json`, metaJson, {
    httpMetadata: { contentType: "application/json" },
  });

  // Also update custom-articles meta if it exists
  const customMeta = await env.KB_BUCKET.head(`custom-articles/${slug}/_meta.json`);
  if (customMeta) {
    await env.KB_BUCKET.put(`custom-articles/${slug}/_meta.json`, metaJson, {
      httpMetadata: { contentType: "application/json" },
    });
  }

  // Update site manifest
  await updateSiteManifest(env, slug, updatedMeta as unknown as ArticleMeta);

  // Trigger Pages rebuild if visibility changed or article is public
  const wasPublic = existingMeta.category === "public";
  const isPublic = category === "public";
  if ((wasPublic || isPublic) && env.PAGES_DEPLOY_HOOK) {
    try {
      await fetch(env.PAGES_DEPLOY_HOOK, { method: "POST" });
    } catch { /* non-fatal */ }
  }

  return Response.redirect(
    `https://${env.INTERNAL_KB_DOMAIN}/articles/${slug}`,
    303,
  );
}

// ---------------------------------------------------------------------------
// Site manifest helpers
// ---------------------------------------------------------------------------

/** Add a new article to the site manifest. */
async function addToSiteManifest(env: Env, meta: ArticleMeta): Promise<void> {
  const manifest = await loadSiteManifest(env);
  const filtered = manifest.filter((a) => a.slug !== meta.slug);
  // Ensure breadcrumb exists
  if (!meta.breadcrumb || meta.breadcrumb.length === 0) {
    if (meta.displayCategory) {
      meta.breadcrumb = [meta.displayCategory];
    } else {
      meta.breadcrumb = meta.slug.split("/").filter(Boolean).map((s) => {
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
  }
  filtered.push(meta);
  await env.KB_BUCKET.put(
    "processed/_site-manifest.json",
    JSON.stringify(filtered, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );
}

/** Update an existing article's metadata in the site manifest. */
async function updateSiteManifest(
  env: Env,
  slug: string,
  meta: ArticleMeta,
): Promise<void> {
  const manifest = await loadSiteManifest(env);
  const idx = manifest.findIndex((a) => a.slug === slug);
  if (idx >= 0) {
    manifest[idx] = { ...manifest[idx], ...meta };
  } else {
    manifest.push(meta);
  }
  await env.KB_BUCKET.put(
    "processed/_site-manifest.json",
    JSON.stringify(manifest, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );
}

/** Load the site manifest array from R2. */
async function loadSiteManifest(env: Env): Promise<ArticleMeta[]> {
  try {
    const obj = await env.KB_BUCKET.get("processed/_site-manifest.json");
    if (!obj) return [];
    const data = await obj.json();
    return Array.isArray(data) ? (data as ArticleMeta[]) : [];
  } catch {
    return [];
  }
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
