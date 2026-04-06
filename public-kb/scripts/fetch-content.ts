/**
 * Pre-build script: Fetches processed articles from R2 and writes them
 * as Hugo content files with frontmatter.
 *
 * Environment variables required:
 *   R2_ACCESS_KEY_ID — R2 API token access key
 *   R2_SECRET_ACCESS_KEY — R2 API token secret
 *   R2_ENDPOINT — https://{account_id}.r2.cloudflarestorage.com
 *   R2_BUCKET — your R2 bucket name
 */
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

const CONTENT_DIR = join(process.cwd(), "content", "articles");

interface ArticleMeta {
  slug: string;
  title: string;
  category: "public" | "internal";
  sourceUrl?: string;
  lastCrawled?: string;
  isOverride?: boolean;
  breadcrumb?: string[];
}

interface SiteManifestEntry extends ArticleMeta {}

async function main() {
  if (!process.env.R2_BUCKET) {
    console.error("R2_BUCKET environment variable is required");
    process.exit(1);
  }
  if (!process.env.R2_ENDPOINT) {
    console.error("R2_ENDPOINT environment variable is required");
    process.exit(1);
  }

  const client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });

  const bucket = process.env.R2_BUCKET;

  // 1. Read site manifest
  console.log("Fetching site manifest...");
  const manifestRes = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: "processed/_site-manifest.json",
  }));
  const manifestBody = await manifestRes.Body!.transformToString();
  const manifest: SiteManifestEntry[] = JSON.parse(manifestBody);

  // 2. Filter to public articles only
  const publicArticles = manifest.filter((a) => a.category === "public");
  console.log(`Found ${manifest.length} total articles, ${publicArticles.length} public`);

  // 3. Fetch each public article and write as Hugo content
  let written = 0;
  for (const article of publicArticles) {
    try {
      const mdRes = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: `processed/${article.slug}/index.md`,
      }));
      const markdown = await mdRes.Body!.transformToString();

      // Build Hugo frontmatter
      const frontmatter = [
        "---",
        `title: ${JSON.stringify(article.title)}`,
        `slug: ${JSON.stringify(article.slug.split("/").pop() || article.slug)}`,
        `date: ${JSON.stringify(article.lastCrawled || new Date().toISOString())}`,
        `categories: [${JSON.stringify(article.breadcrumb?.[0] || "General")}]`,
        article.sourceUrl ? `sourceUrl: ${JSON.stringify(article.sourceUrl)}` : null,
        article.isOverride ? "isOverride: true" : null,
        "---",
      ].filter(Boolean).join("\n");

      // Write to content/articles/{slug}/index.md
      const outputPath = join(CONTENT_DIR, article.slug, "index.md");
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, frontmatter + "\n\n" + markdown, "utf-8");
      written++;
    } catch (err) {
      console.error(`Failed to fetch ${article.slug}:`, err);
    }
  }

  // 4. Also fetch search index for client-side search
  try {
    const searchRes = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: "processed/_search-index.json",
    }));
    const searchBody = await searchRes.Body!.transformToString();
    // Filter to public only
    const fullIndex = JSON.parse(searchBody);
    const publicSlugs = new Set(publicArticles.map((a) => a.slug));
    const publicIndex = fullIndex.filter((entry: any) => publicSlugs.has(entry.slug));
    const searchOutputPath = join(process.cwd(), "static", "js", "search-index.json");
    writeFileSync(searchOutputPath, JSON.stringify(publicIndex), "utf-8");
    console.log(`Wrote search index with ${publicIndex.length} entries`);
  } catch (err) {
    console.error("Failed to fetch search index:", err);
  }

  console.log(`Done: wrote ${written} articles to ${CONTENT_DIR}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
