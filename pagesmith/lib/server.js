// The local dashboard: a JSON API plus the static files in public/.
//
// It binds to 127.0.0.1 only, and every API call must carry the session key
// printed at startup. That key is what stops another page in the same browser
// (or anything that resolves a hostname to 127.0.0.1) from driving your GitHub
// token through this server.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { load, save, redact, newSite } from "./config.js";
import { GitHub, GitHubError } from "./github.js";
import { deploySite, rollbackSite } from "./deploy.js";
import { checkDomain, requiredRecords } from "./dns.js";
import { serveFile, createPreviewServer } from "./static.js";
import { SiteError } from "./site.js";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export function createApp({ previewPort = 4321 } = {}) {
  const key = randomBytes(24).toString("hex");
  const preview = createPreviewServer(previewPort);

  const server = createServer((req, res) => {
    handle(req, res, { key, preview, previewPort }).catch((err) => {
      send(res, statusFor(err), { error: message(err) });
    });
  });

  return { server, key, preview };
}

async function handle(req, res, ctx) {
  // DNS rebinding defence: a browser that reached us via some attacker-owned
  // hostname will send that hostname in Host. Only loopback names are ours.
  const host = (req.headers.host || "").split(":")[0];
  if (host && !["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    return send(res, 403, { error: "Unexpected Host header." });
  }

  const url = new URL(req.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/")) {
    return serveFile(res, PUBLIC, url.pathname === "/" ? "/index.html" : url.pathname);
  }

  const provided = req.headers["x-pagesmith-key"] || url.searchParams.get("key") || "";
  if (!sameKey(provided, ctx.key)) return send(res, 401, { error: "Bad or missing session key." });

  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
  const body = await readBody(req);
  const config = await load();

  // ---- session / account -------------------------------------------------
  if (parts[0] === "state" && req.method === "GET") {
    return send(res, 200, {
      ...redact(config),
      preview: { port: ctx.previewPort, root: ctx.preview.root },
      home: homedir(),
    });
  }

  if (parts[0] === "token") {
    if (req.method === "POST") {
      const token = String(body.token || "").trim();
      if (!token) return send(res, 400, { error: "Paste a token first." });
      const gh = new GitHub(token);
      const me = await gh.whoami(); // Fails loudly here rather than mid-deploy.
      config.token = token;
      config.login = me.login;
      await save(config);
      return send(res, 200, redact(config));
    }
    if (req.method === "DELETE") {
      config.token = null;
      config.login = null;
      await save(config);
      return send(res, 200, redact(config));
    }
  }

  // ---- folder picker -----------------------------------------------------
  if (parts[0] === "browse" && req.method === "GET") {
    const path = url.searchParams.get("path") || homedir();
    return send(res, 200, await browse(path));
  }

  // ---- sites -------------------------------------------------------------
  if (parts[0] === "sites" && req.method === "POST" && parts.length === 1) {
    const site = await buildSite(body, config);
    config.sites.push(site);
    await save(config);
    return send(res, 201, site);
  }

  if (parts[0] === "sites" && parts.length >= 2) {
    const site = config.sites.find((s) => s.id === parts[1]);
    if (!site) return send(res, 404, { error: "No such site." });
    const action = parts[2];

    if (!action && req.method === "DELETE") {
      config.sites = config.sites.filter((s) => s.id !== site.id);
      await save(config);
      // Deliberately does not touch the GitHub repo: removing a card here
      // should never be able to delete a published site.
      return send(res, 200, { removed: site.id });
    }

    if (!action && req.method === "PATCH") {
      Object.assign(site, pickEditable(body));
      await save(config);
      return send(res, 200, site);
    }

    if (action === "preview" && req.method === "POST") {
      await assertFolder(site.dir);
      ctx.preview.setRoot(site.dir);
      return send(res, 200, { url: `http://127.0.0.1:${ctx.previewPort}/` });
    }

    if (action === "deploy" && req.method === "POST") {
      const gh = requireGitHub(config);
      const log = [];
      const result = await deploySite(gh, site, {
        login: config.login,
        onProgress: (m) => log.push(m),
      });
      site.lastDeploy = {
        at: new Date().toISOString(),
        sha: result.sha,
        files: result.files,
        bytes: result.bytes,
        changed: result.changed,
      };
      await save(config);
      return send(res, 200, { ...result, log, site });
    }

    if (action === "deployments" && req.method === "GET") {
      const gh = requireGitHub(config);
      const commits = await gh
        .listCommits(site.owner, site.repo, site.branch)
        .catch((err) => (err.status === 404 || err.status === 409 ? [] : Promise.reject(err)));
      return send(
        res,
        200,
        commits.map((c) => ({
          sha: c.sha,
          message: c.commit.message.split("\n")[0],
          at: c.commit.author?.date || c.commit.committer?.date,
        })),
      );
    }

    if (action === "rollback" && req.method === "POST") {
      const gh = requireGitHub(config);
      const sha = String(body.sha || "");
      if (!/^[0-9a-f]{7,40}$/.test(sha)) return send(res, 400, { error: "Bad commit id." });
      const result = await rollbackSite(gh, site, sha);
      return send(res, 200, result);
    }

    if (action === "dns" && req.method === "GET") {
      if (!site.domain) return send(res, 200, { domain: null });
      const login = config.login || site.owner;
      const [check, pages] = await Promise.all([
        checkDomain(site.domain, login),
        config.token ? requireGitHub(config).getPages(site.owner, site.repo) : null,
      ]);
      return send(res, 200, {
        ...check,
        records: requiredRecords(site.domain, login),
        pages: pages && {
          cname: pages.cname,
          status: pages.status,
          https: pages.https_enforced,
          certificate: pages.https_certificate?.state || null,
          url: pages.html_url,
        },
      });
    }

    if (action === "status" && req.method === "GET") {
      const gh = requireGitHub(config);
      const [repo, pages] = await Promise.all([
        gh.getRepo(site.owner, site.repo),
        gh.getPages(site.owner, site.repo),
      ]);
      return send(res, 200, {
        repo: repo && { url: repo.html_url, pushedAt: repo.pushed_at },
        pages: pages && {
          url: pages.html_url,
          status: pages.status,
          cname: pages.cname,
          https: pages.https_enforced,
          certificate: pages.https_certificate?.state || null,
        },
      });
    }
  }

  return send(res, 404, { error: "No such endpoint." });
}

function pickEditable(body) {
  const out = {};
  for (const field of ["name", "dir", "owner", "repo", "domain", "branch"]) {
    if (body[field] !== undefined) out[field] = body[field] || null;
  }
  if (out.dir) out.dir = expand(out.dir);
  return out;
}

async function buildSite(body, config) {
  const dir = expand(String(body.dir || "").trim());
  if (!dir) throw new HttpError(400, "Pick the folder that holds your site.");
  await assertFolder(dir);
  const repo = String(body.repo || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new HttpError(400, "Repository name can only use letters, numbers, dot, dash, underscore.");
  }
  const owner = String(body.owner || config.login || "").trim();
  if (!owner) throw new HttpError(400, "Connect your GitHub account first.");
  const domain = String(body.domain || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw new HttpError(400, `"${domain}" does not look like a domain name.`);
  }
  return newSite({
    name: String(body.name || repo).trim() || repo,
    dir,
    owner,
    repo,
    domain,
    branch: String(body.branch || "main").trim() || "main",
  });
}

function expand(path) {
  if (!path) return path;
  const full = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
  return isAbsolute(full) ? resolve(full) : resolve(process.cwd(), full);
}

async function assertFolder(dir) {
  const info = await stat(dir).catch(() => null);
  if (!info) throw new HttpError(400, `There is no folder at ${dir}.`);
  if (!info.isDirectory()) throw new HttpError(400, `${dir} is a file, not a folder.`);
}

async function browse(path) {
  const dir = expand(path);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) throw new HttpError(400, `Cannot open ${dir}.`);
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const hasIndex = entries.some((e) => e.isFile() && e.name === "index.html");
  return { path: dir, parent: dirname(dir) === dir ? null : dirname(dir), folders, hasIndex };
}

function requireGitHub(config) {
  if (!config.token) throw new HttpError(400, "Connect your GitHub account first.");
  return new GitHub(config.token);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function statusFor(err) {
  if (err instanceof HttpError) return err.status;
  if (err instanceof SiteError) return 400;
  if (err instanceof GitHubError) return err.status === 401 ? 401 : 502;
  return 500;
}

function message(err) {
  if (err instanceof GitHubError && err.status === 401) {
    return "GitHub rejected the token. It may have expired — paste a fresh one.";
  }
  return err.message || "Something went wrong.";
}

function sameKey(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "DELETE") return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "Request too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Malformed JSON.");
  }
}

function send(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}
