import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectFiles, withGeneratedFiles, findMissingIndex, SiteError } from "../lib/site.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pagesmith-"));
  await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
  await mkdir(join(dir, "_assets"));
  await writeFile(join(dir, "_assets", "app.css"), "body{}");
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main");
  await writeFile(join(dir, ".DS_Store"), "junk");
  return dir;
}

test("collects files and skips repository and OS litter", async () => {
  const dir = await fixture();
  const files = await collectFiles(dir);
  assert.deepEqual(
    files.map((f) => f.path),
    ["_assets/app.css", "index.html"],
  );
});

test("missing folders are reported as site errors, not crashes", async () => {
  await assert.rejects(() => collectFiles(join(tmpdir(), "pagesmith-nope-12345")), SiteError);
});

test("adds CNAME and .nojekyll, and never overwrites the user's own", async () => {
  const files = [{ path: "index.html" }, { path: "CNAME", content: "mine.example\n" }];
  const out = withGeneratedFiles(files, { domain: "dutdutrecords.com" });
  const cname = out.find((f) => f.path === "CNAME");
  assert.equal(cname.content, "mine.example\n");
  assert.ok(out.some((f) => f.path === ".nojekyll" && f.generated));
});

test("no domain means no CNAME file", () => {
  const out = withGeneratedFiles([{ path: "index.html" }], { domain: null });
  assert.ok(!out.some((f) => f.path === "CNAME"));
});

test("a site without a root index.html is flagged", () => {
  assert.equal(findMissingIndex([{ path: "about.html" }]), "index.html");
  assert.equal(findMissingIndex([{ path: "index.html" }]), null);
});
