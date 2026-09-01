import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, posix } from "node:path";

const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [name, ...value] = argument.replace(/^--/, "").split("=");
    return [name, value.join("=")];
  }),
);

if (!options.slug || !options.url || !options.output) {
  console.error("Usage: node capture-site.mjs --slug=name --url=https://example.com/ --output=/absolute/path");
  process.exit(1);
}

const slug = options.slug;
const sourceUrl = new URL(options.url);
const output = options.output;
const debugPort = 9400 + Math.floor(Math.random() * 400);
const profile = await mkdtemp(join(tmpdir(), `portomatic-capture-${slug}-`));
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    this.socket.close();
  }
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response.json();
}

async function waitForChrome() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      return await getJson(`http://127.0.0.1:${debugPort}/json/version`);
    } catch {
      await wait(200);
    }
  }
  throw new Error("Chrome debugging endpoint did not start");
}

function safePath(pathname) {
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .map((segment) => segment.replace(/[\0<>:"|?*]/g, "_").replace(/^\.+$/, "_"));
  return segments.join("/");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function safeExtension(pathname) {
  const extension = extname(pathname);
  return /^\.[a-z0-9]{1,12}$/i.test(extension) ? extension : ".__capture";
}

function localPathFor(record, primaryOrigins) {
  const url = new URL(record.url);
  const isPrimary = primaryOrigins.has(url.origin);
  let pathname = safePath(url.pathname);
  const contentType = record.mimeType || record.contentType || "application/octet-stream";
  const isHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);

  if (!pathname || url.pathname.endsWith("/")) pathname = posix.join(pathname, "index.html");
  else if (isHtml && !extname(pathname)) pathname = posix.join(pathname, "index.html");
  else if (!extname(pathname)) pathname = `${pathname}.__capture`;

  if (pathname.length > 180 || pathname.split("/").some((segment) => segment.length > 100)) {
    const extension = safeExtension(pathname);
    pathname = posix.join("__long", `${hash(record.url)}${extension}`);
  }

  if (!isPrimary) {
    const extension = safeExtension(pathname);
    return posix.join("__external", url.host, "__files", `${hash(record.url)}${extension}`);
  }
  return pathname;
}

function rewriteDocument(text, slugName) {
  let rewritten = text;
  rewritten = rewritten.replace(
    /<meta\b[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi,
    "",
  );
  rewritten = rewritten.replace(/\s+integrity=(?:"[^"]*"|'[^']*')/gi, "");
  rewritten = rewritten.replace(/<base\b[^>]*>/gi, "");
  if (/<head[^>]*>/i.test(rewritten)) {
    rewritten = rewritten.replace(
      /<head([^>]*)>/i,
      `<head$1><base href="/"><meta name="portomatic-capture" content="${slugName}">`,
    );
  }
  return rewritten;
}

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
});

let client;
try {
  await waitForChrome();
  const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
  const target = targets.find((candidate) => candidate.type === "page");
  if (!target) throw new Error("Chrome did not create a page target");

  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Network.enable", {
      maxTotalBufferSize: 512 * 1024 * 1024,
      maxResourceBufferSize: 64 * 1024 * 1024,
      maxPostDataSize: 2 * 1024 * 1024,
    }),
    client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    }),
  ]);
  await client.send("Network.setCacheDisabled", { cacheDisabled: true });

  const responses = new Map();
  const bodyTasks = new Set();
  let mainRequestId;
  let loadedResolve;
  const loaded = new Promise((resolve) => {
    loadedResolve = resolve;
  });

  client.on("Page.loadEventFired", loadedResolve);
  client.on("Network.responseReceived", ({ requestId, response, type }) => {
    if (!/^https?:/i.test(response.url) || response.status < 200 || response.status >= 400) return;
    responses.set(requestId, {
      requestId,
      url: response.url,
      status: response.status,
      mimeType: response.mimeType,
      contentType: response.headers?.["content-type"] ?? response.headers?.["Content-Type"] ?? response.mimeType,
      type,
    });
    if (type === "Document" && !mainRequestId) mainRequestId = requestId;
  });
  client.on("Network.loadingFinished", ({ requestId }) => {
    const record = responses.get(requestId);
    if (!record || record.body) return;
    const task = client
      .send("Network.getResponseBody", { requestId })
      .then(({ body, base64Encoded }) => {
        record.body = base64Encoded ? Buffer.from(body, "base64") : Buffer.from(body);
      })
      .catch((error) => {
        record.bodyError = error.message;
      })
      .finally(() => bodyTasks.delete(task));
    bodyTasks.add(task);
  });

  await client.send("Page.navigate", { url: sourceUrl.href });
  await Promise.race([loaded, wait(30_000)]);
  await wait(5_000);
  await client.send("Runtime.evaluate", {
    expression: `new Promise((resolve) => {
      const step = Math.max(500, Math.floor(innerHeight * 0.75));
      let position = 0;
      const timer = setInterval(() => {
        position += step;
        scrollTo(0, position);
        if (position >= document.documentElement.scrollHeight) {
          clearInterval(timer);
          setTimeout(() => { scrollTo(0, 0); resolve(true); }, 1200);
        }
      }, 180);
      setTimeout(() => { clearInterval(timer); scrollTo(0, 0); resolve(false); }, 25000);
    })`,
    awaitPromise: true,
    returnByValue: true,
  }).catch((error) => console.error(`Scroll pass warning: ${error.message}`));
  await client.send("Runtime.evaluate", {
    expression: `Promise.allSettled(
      [...document.querySelectorAll('script[src], link[href], img[src], source[src], video[src], audio[src]')]
        .map((element) => element.src || element.href)
        .filter((url) => url && new URL(url, location.href).origin === location.origin)
        .map((url) => Promise.race([
          fetch(url, { credentials: 'include' }).then((response) => response.arrayBuffer()),
          new Promise((resolve) => setTimeout(resolve, 8000))
        ]))
    ).then(() => true)`,
    awaitPromise: true,
    returnByValue: true,
  }).catch((error) => console.error(`Asset warmup warning: ${error.message}`));
  await wait(8_000);

  const [domSnapshot, screenshot] = await Promise.all([
    client.send("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    }).catch((error) => {
      console.error(`DOM snapshot warning: ${error.message}`);
      return { result: { value: "" } };
    }),
    client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    }).catch((error) => {
      console.error(`Screenshot warning: ${error.message}`);
      return { data: "" };
    }),
  ]);
  await Promise.allSettled([...bodyTasks]);

  const records = [...responses.values()].filter((record) => record.body?.length);
  let mainRecord = responses.get(mainRequestId);
  if (!mainRecord?.body?.length) {
    if (!domSnapshot.result.value) throw new Error("The main document body was not captured");
    mainRecord = {
      requestId: "rendered-document-fallback",
      url: sourceUrl.href,
      status: 200,
      mimeType: "text/html",
      contentType: "text/html; charset=utf-8",
      type: "Document",
      body: Buffer.from(domSnapshot.result.value),
    };
    records.unshift(mainRecord);
  }

  const finalSource = new URL(mainRecord.url);
  const primaryOrigins = new Set([sourceUrl.origin, finalSource.origin]);
  const seenPaths = new Map();
  for (const record of records) {
    const recordUrl = new URL(record.url);
    let localPath = localPathFor(record, primaryOrigins);
    const previous = seenPaths.get(localPath);
    if (previous && !previous.body.equals(record.body)) {
      const extension = extname(localPath);
      localPath = extension
        ? `${localPath.slice(0, -extension.length)}.__${hash(record.url)}${extension}`
        : `${localPath}.__${hash(record.url)}`;
    }
    record.localPath = localPath;
    record.localUrl = primaryOrigins.has(recordUrl.origin)
      ? `${recordUrl.pathname}${recordUrl.search}`
      : `/__external/${recordUrl.host}${recordUrl.pathname}${recordUrl.search}`;
    seenPaths.set(localPath, record);
  }

  await mkdir(output, { recursive: true });
  const manifest = {};
  for (const record of records) {
    let body = record.body;
    if (/^(?:text\/html|application\/xhtml\+xml)/i.test(record.contentType ?? record.mimeType ?? "")) {
      body = Buffer.from(rewriteDocument(body.toString("utf8"), slug));
    }
    const destination = join(output, record.localPath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, body);
    manifest[record.localUrl] = {
      file: record.localPath,
      contentType: record.contentType || record.mimeType || "application/octet-stream",
      source: record.url,
    };
  }

  const renderedHtml = rewriteDocument(
    domSnapshot.result.value || mainRecord.body.toString("utf8"),
    slug,
  );
  await writeFile(join(output, "rendered.html"), renderedHtml);
  if (screenshot.data) {
    await writeFile(join(output, "reference.png"), Buffer.from(screenshot.data, "base64"));
  }
  await writeFile(
    join(output, "capture.json"),
    JSON.stringify(
      {
        slug,
        source: sourceUrl.href,
        finalSource: mainRecord.url,
        capturedAt: new Date().toISOString(),
        resources: manifest,
        failures: [...responses.values()]
          .filter((record) => record.bodyError)
          .map(({ url, type, bodyError }) => ({ url, type, error: bodyError })),
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify({
      slug,
      resources: records.length,
      bytes: records.reduce((sum, record) => sum + record.body.length, 0),
      failures: [...responses.values()].filter((record) => record.bodyError).length,
      output,
    }),
  );
} catch (error) {
  console.error(error.stack ?? error.message);
  if (stderr) console.error(stderr.slice(-4000));
  process.exitCode = 1;
} finally {
  client?.close();
  if (chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await Promise.race([exited, wait(2_000)]);
  }
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
