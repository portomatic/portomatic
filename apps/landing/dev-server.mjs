import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const port = Number.parseInt(process.env.PORT ?? "4173", 10);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".lottie": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const mirrorManifests = new Map();

async function getMirrorManifest(mirrorRoot) {
  const capturePath = join(mirrorRoot, "capture.json");
  try {
    const captureInfo = await stat(capturePath);
    const cached = mirrorManifests.get(mirrorRoot);
    if (cached?.mtimeMs === captureInfo.mtimeMs) return cached.resources;
    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    const resources = capture.resources ?? {};
    mirrorManifests.set(mirrorRoot, { mtimeMs: captureInfo.mtimeMs, resources });
    return resources;
  } catch {
    mirrorManifests.delete(mirrorRoot);
    return {};
  }
}

async function serveStatic(request, response, pathname, serveRoot = root, manifest = {}, search = "") {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }

  let requestPath = decoded;
  if (requestPath.endsWith("/")) requestPath += "index.html";
  const mapped = manifest[`${requestPath}${search}`] ?? manifest[requestPath];
  let filePath = normalize(join(serveRoot, mapped?.file ?? requestPath));
  if (relative(serveRoot, filePath).startsWith("..")) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
    const fileInfo = await stat(filePath);
    const contentType = mapped?.contentType ?? mimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const start = range[1] ? Number.parseInt(range[1], 10) : 0;
      const end = range[2] ? Math.min(Number.parseInt(range[2], 10), fileInfo.size - 1) : fileInfo.size - 1;
      if (start > end || start >= fileInfo.size) {
        response.writeHead(416, { "content-range": `bytes */${fileInfo.size}` });
        response.end();
        return;
      }
      response.writeHead(206, {
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*",
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${fileInfo.size}`,
        "content-type": contentType,
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, {
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
      "content-length": fileInfo.size,
      "content-type": contentType,
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const hostname = (request.headers.host ?? "").split(":")[0];
  const mirrorMatch = hostname.match(/^([a-z0-9-]+)\.localhost$/i);
  if (mirrorMatch) {
    const mirrorRoot = join(root, "captures", mirrorMatch[1]);
    const manifest = await getMirrorManifest(mirrorRoot);
    await serveStatic(request, response, requestUrl.pathname, mirrorRoot, manifest, requestUrl.search);
    return;
  }
  await serveStatic(request, response, requestUrl.pathname);
});

server.listen(port, () => {
  console.log(`Portomatic landing storyboard: http://127.0.0.1:${port}/storyboard/`);
});
