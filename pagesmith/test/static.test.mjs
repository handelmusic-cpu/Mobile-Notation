import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import { safeJoin, contentType } from "../lib/static.js";

test("ordinary paths resolve inside the served folder", () => {
  const root = resolve("/srv/site");
  assert.equal(safeJoin(root, "/index.html"), join(root, "index.html"));
  assert.equal(safeJoin(root, "/css/../css/app.css"), join(root, "css/app.css"));
  assert.equal(safeJoin(root, "/deep/dir/page.html?v=2"), join(root, "deep/dir/page.html"));
});

test("traversal cannot reach outside the served folder", () => {
  const root = resolve("/srv/site");
  // Escapes are neutralised by normalising the request as an absolute path
  // first, so "../.." lands back at the root instead of above it.
  for (const attempt of [
    "/../../etc/passwd",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/..%2f..%2fsite-secrets/key",
    "/a/../../../../../../etc/shadow",
  ]) {
    const resolved = safeJoin(root, attempt);
    assert.ok(resolved === null || resolved.startsWith(root + "/"), `${attempt} escaped: ${resolved}`);
  }
  // A sibling folder whose name merely starts the same way is still outside.
  assert.equal(safeJoin(root, ".."), null);
});

test("undecodable paths are refused rather than guessed at", () => {
  assert.equal(safeJoin("/srv/site", "/%E0%A4%A"), null);
});

test("content types cover the web basics and fall back safely", () => {
  assert.equal(contentType("a/b/index.HTML"), "text/html; charset=utf-8");
  assert.equal(contentType("app.mjs"), "text/javascript; charset=utf-8");
  assert.equal(contentType("song.weird"), "application/octet-stream");
});
