/**
 * Export one crawl's raw markdown from R2 as two zips for offline review:
 *   {upstream-host}-{date}-raw.zip    — the crawls/{date}/ objects exactly as stored
 *   {upstream-host}-{date}-clean.zip  — page chrome stripped, upstream names and links kept
 *
 * Usage:
 *   npm run export:crawl                          # latest crawl into ./exports
 *   npm run export:crawl -- --date 2026-10-11 --out ~/Downloads
 *
 * Environment:
 *   CLOUDFLARE_API_TOKEN — API token with Account > Workers R2 Storage > Read
 *   CF_ACCOUNT_ID        — account that owns the bucket
 *   R2_BUCKET            — bucket the crawl worker writes to
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stripPageChrome } from "../shared/strip-chrome.ts";

// Pages the crawler captured behind a login wall rather than real articles.
const AUTH_WALL_TITLE = /^title:\s*"Sign in to your account"/m;
const CONCURRENCY = 12;

const { values: args } = parseArgs({
  options: {
    date: { type: "string" },
    out: { type: "string", default: "exports" },
  },
});

const token = requireEnv("CLOUDFLARE_API_TOKEN");
const accountId = requireEnv("CF_ACCOUNT_ID");
const bucket = requireEnv("R2_BUCKET");
const objectsUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

async function api(path: string, query: Record<string, string> = {}): Promise<Response> {
  const url = new URL(objectsUrl + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.pathname}`);
  return res;
}

interface ListPage {
  result: { key: string }[];
  result_info?: { cursor?: string; is_truncated?: boolean; delimited?: string[] };
}

async function list(prefix: string, delimiter?: string): Promise<ListPage[]> {
  const pages: ListPage[] = [];
  let cursor: string | undefined;
  do {
    const query: Record<string, string> = { prefix, per_page: "1000" };
    if (delimiter) query.delimiter = delimiter;
    if (cursor) query.cursor = cursor;
    const page = (await (await api("", query)).json()) as ListPage;
    pages.push(page);
    cursor = page.result_info?.is_truncated ? page.result_info.cursor : undefined;
  } while (cursor);
  return pages;
}

// Object keys can contain literal "%20" (upstream URL paths), so each segment is
// encoded rather than the key passed through as a URL path.
function getObject(key: string): Promise<Response> {
  return api("/" + key.split("/").map(encodeURIComponent).join("/"));
}

async function latestCrawlDate(): Promise<string> {
  const dates = (await list("crawls/", "/"))
    .flatMap((p) => p.result_info?.delimited ?? [])
    .map((prefix) => prefix.slice("crawls/".length, -1))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (!dates.length) throw new Error(`No crawls found in ${bucket}`);
  return dates[dates.length - 1];
}

async function main() {
  const date = args.date ?? (await latestCrawlDate());
  const prefix = `crawls/${date}/`;
  const outDir = resolve(args.out!);

  const manifest = await (await getObject(`${prefix}_manifest.json`)).json() as {
    crawlUrl: string;
    writtenPages: number;
    filteredTotal: number;
    modifiedSince: string | null;
  };
  console.log(`Crawl ${date}: ${manifest.writtenPages}/${manifest.filteredTotal} pages written`);
  if (manifest.modifiedSince) {
    console.warn(
      `Warning: this was an incremental crawl (modifiedSince ${manifest.modifiedSince}). ` +
      `It holds only changed pages, not the whole KB.`,
    );
  }

  const keys = (await list(prefix)).flatMap((p) => p.result.map((o) => o.key)).filter((k) => k.endsWith("/index.md"));

  const work = mkdtempSync(join(tmpdir(), "export-crawl-"));
  const upstream = new URL(manifest.crawlUrl);
  const rawName = `${upstream.hostname.split(".")[0]}-${date}-raw`;
  const cleanName = `${upstream.hostname.split(".")[0]}-${date}-clean`;
  const skipped: string[] = [];
  let written = 0;

  const queue = [...keys];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let key = queue.shift(); key; key = queue.shift()) {
        const rel = key.slice(prefix.length);
        const md = await (await getObject(key)).text();
        if (AUTH_WALL_TITLE.test(md)) {
          skipped.push(rel);
          continue;
        }

        const articlePath = dirname(rel);
        const { markdown, title } = stripPageChrome(md, articlePath);
        const clean = `# ${title}\n\nSource: ${new URL(articlePath, upstream)}\n\n${markdown.replace(/^# .*\n+/, "")}`;

        writeFile(join(work, rawName, rel), md);
        writeFile(join(work, cleanName, rel), clean);
        written++;
      }
    }),
  );

  writeFile(join(work, rawName, "_manifest.json"), JSON.stringify(manifest, null, 2));

  mkdirSync(outDir, { recursive: true });
  for (const name of [rawName, cleanName]) {
    const zipPath = join(outDir, `${name}.zip`);
    rmSync(zipPath, { force: true });
    execFileSync("zip", ["-qr", zipPath, name], { cwd: work });
    console.log(`Wrote ${zipPath}`);
  }
  rmSync(work, { recursive: true, force: true });

  console.log(`${written} articles exported`);
  for (const rel of skipped) console.log(`Skipped auth-wall page: ${rel}`);
}

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
