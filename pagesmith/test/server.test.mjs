import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

// The config module reads PAGESMITH_HOME at import time, so it has to be set
// before anything is imported — hence the dynamic import below.
const home = await mkdtemp(join(tmpdir(), "pagesmith-home-"));
process.env.PAGESMITH_HOME = home;
const { createApp } = await import("../lib/server.js");

let app;
let base;

before(async () => {
  app = createApp({ previewPort: 0 });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.server.close();
  app.preview.server.close();
});

const call = (path, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { "x-pagesmith-key": app.key, ...(init.headers || {}) },
  });

test("the API refuses calls without the session key", async () => {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 401);
});

test("the API refuses a wrong key of the same length", async () => {
  const res = await fetch(`${base}/api/state`, {
    headers: { "x-pagesmith-key": "0".repeat(app.key.length) },
  });
  assert.equal(res.status, 401);
});

test("a rebound hostname is refused even with the key", async () => {
  // fetch() will not let a caller forge Host, so this goes out over raw HTTP —
  // which is exactly how a DNS-rebinding attempt would reach the server.
  const status = await new Promise((ok, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: app.server.address().port,
        path: "/api/state",
        headers: { host: "evil.example", "x-pagesmith-key": app.key },
      },
      (res) => {
        res.resume();
        ok(res.statusCode);
      },
    );
    req.on("error", fail);
    req.end();
  });
  assert.equal(status, 403);
});

test("state starts empty and never contains the token", async () => {
  const state = await (await call("/api/state")).json();
  assert.equal(state.hasToken, false);
  assert.equal(state.token, undefined);
  assert.deepEqual(state.sites, []);
});

test("the dashboard itself is served without a key", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
});

test("adding a site validates the folder, repo name and domain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pagesmith-site-"));
  await writeFile(join(dir, "index.html"), "<h1>hi</h1>");

  const bad = await call("/api/sites", {
    method: "POST",
    body: JSON.stringify({ dir: join(dir, "nope"), repo: "site", owner: "me" }),
  });
  assert.equal(bad.status, 400);

  const badName = await call("/api/sites", {
    method: "POST",
    body: JSON.stringify({ dir, repo: "bad name!", owner: "me" }),
  });
  assert.equal(badName.status, 400);

  const badDomain = await call("/api/sites", {
    method: "POST",
    body: JSON.stringify({ dir, repo: "site", owner: "me", domain: "not a domain" }),
  });
  assert.equal(badDomain.status, 400);

  const ok = await call("/api/sites", {
    method: "POST",
    body: JSON.stringify({
      name: "Dutdut",
      dir,
      repo: "dutdutrecords",
      owner: "me",
      domain: "https://DutDutRecords.com/",
    }),
  });
  assert.equal(ok.status, 201);
  const site = await ok.json();
  // The domain is normalised so a pasted URL still produces a valid CNAME.
  assert.equal(site.domain, "dutdutrecords.com");

  const state = await (await call("/api/state")).json();
  assert.equal(state.sites.length, 1);

  // Deploying without a token must fail with advice, not a crash.
  const deploy = await call(`/api/sites/${site.id}/deploy`, { method: "POST" });
  assert.equal(deploy.status, 400);
  assert.match((await deploy.json()).error, /Connect your GitHub account/);

  // Removing a site leaves the published repository alone.
  const removed = await call(`/api/sites/${site.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.deepEqual((await (await call("/api/state")).json()).sites, []);
});

test("browsing lists folders and reports whether one looks like a site", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pagesmith-browse-"));
  await mkdir(join(dir, "public"));
  await writeFile(join(dir, "index.html"), "x");
  const listing = await (await call(`/api/browse?path=${encodeURIComponent(dir)}`)).json();
  assert.equal(listing.hasIndex, true);
  assert.deepEqual(
    listing.folders.map((f) => f.name),
    ["public"],
  );
});

test("a bad token is rejected before it is stored", async () => {
  const res = await call("/api/token", { method: "POST", body: JSON.stringify({ token: "" }) });
  assert.equal(res.status, 400);
  assert.equal((await (await call("/api/state")).json()).hasToken, false);
});

test("unknown endpoints answer with JSON, not a stack trace", async () => {
  const res = await call("/api/nonsense");
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /No such endpoint/);
});
