interface Env {
  KB_BUCKET: R2Bucket;
  IMAGE_BUCKET: R2Bucket;
  IMAGE_DOMAIN: string;
  SOURCE_IMAGE_CDN: string;
  REVALIDATE_HOURS: string;
  MAX_CONCURRENT: string;
  CRAWL_SECRET: string;
  ADDITIONAL_IMAGE_SOURCES?: string;
}

interface ImageSource {
  hostname: string;
  pathPrefix: string;
}

interface SyncResult {
  scannedArticles: number;
  uniqueImages: number;
  alreadyCached: number;
  downloaded: number;
  failed: number;
  revalidated: number;
  duration: string;
  errors: string[];
}

interface ImageMeta {
  etag?: string;
  contentLength?: number;
  contentType?: string;
  lastSynced: string;
  sourceUrl: string;
}

function parseImageSources(env: Env): ImageSource[] {
  const sources: ImageSource[] = [{ hostname: env.SOURCE_IMAGE_CDN, pathPrefix: "" }];
  if (env.ADDITIONAL_IMAGE_SOURCES) {
    try {
      const additional = JSON.parse(env.ADDITIONAL_IMAGE_SOURCES) as ImageSource[];
      sources.push(...additional);
    } catch {
      console.error("Failed to parse ADDITIONAL_IMAGE_SOURCES");
    }
  }
  return sources;
}

function buildCdnPattern(hostname: string): RegExp {
  const escaped = hostname.replace(/\./g, "\\.").replace(/\//g, "\\/");
  return new RegExp(
    `https?:\\/\\/${escaped}\\/[^\\s)"'>]+\\.(png|jpg|jpeg|gif|svg|webp|wav|mp3|pdf)`,
    "gi"
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/sync" && request.method === "POST") {
      const secret = request.headers.get("X-Crawl-Secret");
      if (secret !== env.CRAWL_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const start = Date.now();
      const result = await syncImages(env);
      result.duration = ((Date.now() - start) / 1000).toFixed(1) + "s";
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          ok: true,
          imageDomain: env.IMAGE_DOMAIN,
          sourceCdn: env.SOURCE_IMAGE_CDN,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Use POST /sync to trigger image sync", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function syncImages(env: Env): Promise<SyncResult> {
  const result: SyncResult = {
    scannedArticles: 0,
    uniqueImages: 0,
    alreadyCached: 0,
    downloaded: 0,
    failed: 0,
    revalidated: 0,
    duration: "",
    errors: [],
  };

  const revalidateMs = parseInt(env.REVALIDATE_HOURS || "24", 10) * 60 * 60 * 1000;
  const maxConcurrent = parseInt(env.MAX_CONCURRENT || "5", 10);
  const imageSources = parseImageSources(env);
  const imageDomain = env.IMAGE_DOMAIN;

  const imageUrls = new Set<string>();
  let cursor: string | undefined;

  do {
    const list = await env.KB_BUCKET.list({ prefix: "processed/", cursor, limit: 500 });

    for (const obj of list.objects) {
      if (!obj.key.endsWith("/index.md")) continue;

      result.scannedArticles++;
      const mdObj = await env.KB_BUCKET.get(obj.key);
      if (!mdObj) continue;

      const md = await mdObj.text();

      // Match image URLs from all configured upstream CDNs
      for (const source of imageSources) {
        const pattern = buildCdnPattern(source.hostname);
        let match;
        while ((match = pattern.exec(md)) !== null) {
          imageUrls.add(match[0]);
        }
      }

      // Also match already-rewritten URLs and convert back to primary source
      const rewrittenPattern = new RegExp(
        "https?://" +
          imageDomain.replace(/\./g, "\\.") +
          "/[^\\s)\"'>]+\\.(png|jpg|jpeg|gif|svg|webp|wav|mp3|pdf)",
        "gi",
      );
      let match;
      while ((match = rewrittenPattern.exec(md)) !== null) {
        const path = match[0].replace(
          new RegExp("https?://" + imageDomain.replace(/\./g, "\\."), "i"),
          "",
        );
        const decodedForCheck = decodeURIComponent(path);

        // Reverse-map based on path prefix to find original CDN
        let mapped = false;
        for (const source of imageSources) {
          if (source.pathPrefix && decodedForCheck.startsWith("/" + source.pathPrefix)) {
            imageUrls.add("https://" + source.hostname + path.slice(("/" + source.pathPrefix).length));
            mapped = true;
            break;
          }
          if (decodedForCheck.includes("helpjuice_production")) {
            imageUrls.add("https://" + source.hostname + path);
            mapped = true;
            break;
          }
        }
        if (!mapped) {
          // Default: map to primary source CDN
          imageUrls.add("https://" + env.SOURCE_IMAGE_CDN + path);
        }
      }
    }

    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  result.uniqueImages = imageUrls.size;

  // Process images with concurrency limiting
  const urls = Array.from(imageUrls);
  for (let i = 0; i < urls.length; i += maxConcurrent) {
    const batch = urls.slice(i, i + maxConcurrent);
    const promises = batch.map((imageUrl) =>
      processImage(imageUrl, env, imageSources, revalidateMs, result),
    );
    await Promise.all(promises);
  }

  return result;
}

async function processImage(
  sourceUrl: string,
  env: Env,
  imageSources: ImageSource[],
  revalidateMs: number,
  result: SyncResult,
): Promise<void> {
  try {
    // Determine R2 key from source URL
    let r2Key = sourceUrl;
    for (const source of imageSources) {
      const pattern = new RegExp(`^https?:\\/\\/${source.hostname.replace(/\./g, "\\.")}\\/(.*)`);
      const m = r2Key.match(pattern);
      if (m) {
        r2Key = source.pathPrefix ? source.pathPrefix + m[1] : m[1];
        break;
      }
    }
    // Fallback: strip protocol and hostname
    if (r2Key.startsWith("http")) {
      r2Key = r2Key.replace(/^https?:\/\/[^/]+\//, "");
    }

    const existing = await env.IMAGE_BUCKET.head(r2Key);

    if (existing) {
      const metaJson = existing.customMetadata?.imageMeta;
      if (metaJson) {
        try {
          const meta: ImageMeta = JSON.parse(metaJson);
          const lastSynced = new Date(meta.lastSynced).getTime();
          const now = Date.now();

          if (revalidateMs > 0 && now - lastSynced < revalidateMs) {
            result.alreadyCached++;
            return;
          }

          const headResp = await fetch(sourceUrl, { method: "HEAD" });
          if (headResp.ok) {
            const upstreamEtag = headResp.headers.get("etag");
            if (upstreamEtag && upstreamEtag === meta.etag) {
              const updatedMeta: ImageMeta = { ...meta, lastSynced: new Date().toISOString() };
              const body = await env.IMAGE_BUCKET.get(r2Key);
              if (body) {
                await env.IMAGE_BUCKET.put(r2Key, body.body, {
                  httpMetadata: existing.httpMetadata,
                  customMetadata: { imageMeta: JSON.stringify(updatedMeta) },
                });
              }
              result.revalidated++;
              return;
            }
          }
        } catch {
          // Metadata parse error — fall through to re-download
        }
      } else {
        result.alreadyCached++;
        return;
      }
    }

    const resp = await fetch(sourceUrl);
    if (!resp.ok) {
      result.failed++;
      if (result.errors.length < 50) result.errors.push(resp.status + " for " + sourceUrl);
      return;
    }

    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const etag = resp.headers.get("etag") || undefined;
    const contentLength = resp.headers.get("content-length");

    const meta: ImageMeta = {
      etag,
      contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
      contentType,
      lastSynced: new Date().toISOString(),
      sourceUrl,
    };

    await env.IMAGE_BUCKET.put(r2Key, resp.body, {
      httpMetadata: { contentType },
      customMetadata: { imageMeta: JSON.stringify(meta) },
    });

    result.downloaded++;
  } catch (err) {
    result.failed++;
    if (result.errors.length < 50) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push("Error: " + sourceUrl + " - " + msg);
    }
  }
}
