import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const captureRoot = process.argv[2];
if (!captureRoot) {
  console.error("Usage: node localize-capture.mjs /absolute/path/to/capture");
  process.exit(1);
}

const capturePath = join(captureRoot, "capture.json");
const capture = JSON.parse(await readFile(capturePath, "utf8"));
const entries = Object.entries(capture.resources ?? {});
const replacements = entries
  .map(([localUrl, resource]) => [resource.source, localUrl])
  .filter(([remote, local]) => remote && local && remote !== local)
  .sort((a, b) => b[0].length - a[0].length);

function replaceKnownUrls(value) {
  let rewritten = value;
  for (const [remote, local] of replacements) {
    rewritten = rewritten.replaceAll(remote, local);
    rewritten = rewritten.replaceAll(remote.replaceAll("&", "&amp;"), local.replaceAll("&", "&amp;"));
  }
  return rewritten;
}

function localizeHtml(html) {
  return html.replace(
    /(\b(?:src|href|poster|srcset|data-src|data-href|content)\s*=\s*)(["'])(.*?)\2/gis,
    (attribute, prefix, quote, value) => `${prefix}${quote}${replaceKnownUrls(value)}${quote}`,
  );
}

let changed = 0;
for (const [, resource] of entries) {
  const contentType = resource.contentType ?? "";
  if (!/^(?:text\/html|application\/xhtml\+xml|text\/css)/i.test(contentType)) continue;
  const filePath = join(captureRoot, resource.file);
  let body;
  try {
    body = await readFile(filePath, "utf8");
  } catch {
    continue;
  }
  const localized = /css/i.test(contentType) ? replaceKnownUrls(body) : localizeHtml(body);
  if (localized !== body) {
    await writeFile(filePath, localized);
    changed += 1;
  }
}

try {
  const renderedPath = join(captureRoot, "rendered.html");
  const rendered = await readFile(renderedPath, "utf8");
  const localized = localizeHtml(rendered);
  if (localized !== rendered) await writeFile(renderedPath, localized);
} catch {
  // rendered.html is a debugging artifact and is not required at runtime.
}

capture.localizedAt = new Date().toISOString();
await writeFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`);
console.log(JSON.stringify({ slug: capture.slug, changed, resources: entries.length }));
