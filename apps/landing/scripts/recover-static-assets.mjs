import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

const captureRoot = process.argv[2];
if (!captureRoot) {
  console.error("Usage: node recover-static-assets.mjs /absolute/path/to/capture");
  process.exit(1);
}

const capturePath = join(captureRoot, "capture.json");
const capture = JSON.parse(await readFile(capturePath, "utf8"));
const source = new URL(capture.finalSource || capture.source);
const primaryOrigins = new Set([new URL(capture.source).origin, source.origin]);
const resources = capture.resources ?? {};
const queued = new Map();
const failures = [];

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 14);
}

function routeFor(url) {
  return `${url.pathname || "/"}${url.search}`;
}

function queue(rawUrl, base = source) {
  if (!rawUrl || /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(rawUrl)) return;
  let url;
  try {
    url = new URL(rawUrl.replaceAll("&amp;", "&"), base);
  } catch {
    return;
  }
  if (!primaryOrigins.has(url.origin)) return;
  const route = routeFor(url);
  if (!resources[route] && !queued.has(route)) queued.set(route, url);
}

function queueHtml(html) {
  for (const match of html.matchAll(/\b(?:src|poster|data-src)\s*=\s*["']([^"']+)["']/gi)) {
    queue(match[1]);
  }
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = tag[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href) queue(href[1]);
  }
  for (const match of html.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const candidate of match[1].split(",")) queue(candidate.trim().split(/\s+/)[0]);
  }
}

function extensionFor(url, contentType) {
  const fromPath = extname(url.pathname);
  if (fromPath && fromPath.length <= 10) return fromPath;
  const types = {
    "application/javascript": ".js",
    "application/json": ".json",
    "font/woff2": ".woff2",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "text/css": ".css",
    "text/javascript": ".js",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  const bareType = contentType.split(";")[0].trim().toLowerCase();
  return types[bareType] ?? ".bin";
}

async function fetchQueued() {
  let recovered = 0;
  for (const [route, url] of [...queued]) {
    queued.delete(route);
    try {
      const response = await fetch(url, {
        headers: {
          accept: "*/*",
          referer: source.href,
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const file = join("__recovered", `${hash(url.href)}${extensionFor(url, contentType)}`);
      const body = Buffer.from(await response.arrayBuffer());
      const destination = join(captureRoot, file);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, body);
      resources[route] = { file, contentType, source: url.href };
      recovered += 1;
    } catch (error) {
      failures.push({ url: url.href, error: error.message });
    }
  }
  return recovered;
}

const indexHtml = await readFile(join(captureRoot, "index.html"), "utf8");
queueHtml(indexHtml);
let recovered = await fetchQueued();

// A second pass follows CSS url() and @import references after missing stylesheets arrive.
for (let pass = 0; pass < 2; pass += 1) {
  for (const resource of Object.values(resources)) {
    if (!/^text\/css/i.test(resource.contentType ?? "")) continue;
    let css;
    try {
      css = await readFile(join(captureRoot, resource.file), "utf8");
    } catch {
      continue;
    }
    const base = new URL(resource.source);
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) queue(match[1], base);
    for (const match of css.matchAll(/@import\s+["']([^"']+)["']/gi)) queue(match[1], base);
  }
  if (!queued.size) break;
  recovered += await fetchQueued();
}

capture.resources = resources;
capture.recoveredAt = new Date().toISOString();
capture.recoveryFailures = failures;
await writeFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`);
console.log(JSON.stringify({ slug: capture.slug, recovered, resources: Object.keys(resources).length, failures }));
