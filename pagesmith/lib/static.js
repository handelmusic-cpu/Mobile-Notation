// A static file server, used twice: for the dashboard's own assets and for the
// local preview of a site before it is published.

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, extname, resolve, sep } from "node:path";

const TYPES = new Map(
  Object.entries({
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
  }),
);

export function contentType(path) {
  return TYPES.get(extname(path).toLowerCase()) || "application/octet-stream";
}

// Resolves a URL path inside `root`, or null if it escapes — "/../../etc/passwd"
// must not be reachable, and on the preview server that is a real risk because
// the root is a folder the user picked, not one we control.
export function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }
  const target = resolve(join(root, normalize(decoded)));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

export async function serveFile(res, root, urlPath) {
  const target = safeJoin(root, urlPath);
  if (!target) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let path = target;
  let info = await stat(path).catch(() => null);
  if (info?.isDirectory()) {
    path = join(path, "index.html");
    info = await stat(path).catch(() => null);
  }
  if (!info?.isFile()) {
    // Mirror what GitHub Pages does: a custom 404.html if the site has one.
    const notFound = join(root, "404.html");
    const custom = await stat(notFound).catch(() => null);
    if (custom?.isFile()) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      createReadStream(notFound).pipe(res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404 Not Found");
    return;
  }

  res.writeHead(200, {
    "content-type": contentType(path),
    "content-length": info.size,
    // Preview must always show the newest edit; caching here only causes
    // "I saved the file and nothing changed" confusion.
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(res);
}

// One preview server at a time. Starting a preview for another site swaps the
// root out from under the same port, so the browser tab the user already has
// open keeps working.
export function createPreviewServer(port) {
  let root = null;
  const server = createServer((req, res) => {
    if (!root) {
      res.writeHead(503, { "content-type": "text/plain" }).end("No site is being previewed.");
      return;
    }
    serveFile(res, root, req.url).catch(() => {
      if (!res.headersSent) res.writeHead(500).end("Preview error");
    });
  });

  return {
    server,
    listen: () =>
      new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(port, "127.0.0.1", ok);
      }),
    setRoot(dir) {
      root = dir;
    },
    get root() {
      return root;
    },
    port,
  };
}
