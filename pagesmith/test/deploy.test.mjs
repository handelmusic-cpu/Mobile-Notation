import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deploySite, rollbackSite } from "../lib/deploy.js";

// A stand-in for the GitHub side of a deploy: enough state to answer the calls
// deploySite makes, and a record of what it was asked to do.
class FakeGitHub {
  constructor({ repoExists = true, headTree = null } = {}) {
    this.repo = repoExists ? { html_url: "https://github.com/me/site" } : null;
    this.headTree = headTree;
    this.head = headTree ? "headsha" : null;
    this.blobs = [];
    this.trees = [];
    this.commits = [];
    this.pages = null;
    this.pagesUpdates = [];
    this.created = false;
  }
  async getRepo() {
    return this.repo;
  }
  async createRepo() {
    this.created = true;
    this.repo = { html_url: "https://github.com/me/site" };
    return this.repo;
  }
  async createBlob(owner, repo, base64) {
    this.blobs.push(Buffer.from(base64, "base64").toString("utf8"));
    return { sha: `blob${this.blobs.length}` };
  }
  async createTree(owner, repo, tree) {
    this.trees.push(tree);
    return { sha: tree.map((t) => t.sha).join("-") };
  }
  async getRef() {
    return this.head ? { object: { sha: this.head } } : null;
  }
  async get(path) {
    assert.match(path, /git\/commits\//);
    return { tree: { sha: this.headTree } };
  }
  async createCommit(owner, repo, { message, tree, parents }) {
    this.commits.push({ message, tree, parents });
    return { sha: `commit${this.commits.length}` };
  }
  async setRef(owner, repo, branch, sha) {
    this.head = sha;
  }
  async getPages() {
    return this.pages;
  }
  async enablePages() {
    this.pages = { html_url: "https://me.github.io/site/", cname: null, status: "building" };
    return this.pages;
  }
  async updatePages(owner, repo, body) {
    this.pagesUpdates.push(body);
    this.pages = { ...this.pages, ...body };
    return this.pages;
  }
}

async function siteFolder() {
  const dir = await mkdtemp(join(tmpdir(), "pagesmith-deploy-"));
  await writeFile(join(dir, "index.html"), "<h1>Dutdut</h1>");
  return dir;
}

function site(dir, extra = {}) {
  return {
    name: "Dutdut",
    dir,
    owner: "me",
    repo: "site",
    branch: "main",
    domain: "dutdutrecords.com",
    ...extra,
  };
}

test("a first deploy creates the repo, commits every file, and enables Pages", async () => {
  const dir = await siteFolder();
  const gh = new FakeGitHub({ repoExists: false });
  const result = await deploySite(gh, site(dir), { login: "me" });

  assert.ok(gh.created);
  assert.equal(result.changed, true);
  // index.html plus the generated CNAME and .nojekyll.
  assert.equal(result.files, 3);
  assert.ok(gh.blobs.includes("dutdutrecords.com\n"));
  assert.deepEqual(gh.commits[0].parents, []);
  assert.deepEqual(gh.pagesUpdates[0], { cname: "dutdutrecords.com" });
});

test("an unchanged folder does not make an empty commit", async () => {
  const dir = await siteFolder();
  const gh = new FakeGitHub();
  const first = await deploySite(gh, site(dir), { login: "me" });

  const again = new FakeGitHub({ headTree: gh.trees[0].map((t) => t.sha).join("-") });
  const second = await deploySite(again, site(dir), { login: "me" });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(again.commits.length, 0);
});

test("a folder with no index.html deploys but warns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pagesmith-noindex-"));
  await writeFile(join(dir, "about.html"), "later");
  const result = await deploySite(new FakeGitHub(), site(dir), { login: "me" });
  assert.equal(result.changed, true);
  assert.match(result.warnings[0], /404/);
});

test("an empty folder is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pagesmith-empty-"));
  await assert.rejects(() => deploySite(new FakeGitHub(), site(dir), { login: "me" }), /no files/);
});

test("HTTPS is only enforced once the certificate exists", async () => {
  const dir = await siteFolder();
  const gh = new FakeGitHub();
  gh.pages = {
    html_url: "https://me.github.io/site/",
    cname: "dutdutrecords.com",
    https_certificate: { state: "approved" },
    https_enforced: false,
  };
  await deploySite(gh, site(dir), { login: "me" });
  assert.deepEqual(gh.pagesUpdates, [{ https_enforced: true }]);
});

test("rollback replays an old tree as a new commit", async () => {
  const gh = new FakeGitHub({ headTree: "current" });
  gh.get = async () => ({ tree: { sha: "oldtree" } });
  const result = await rollbackSite(gh, site("/unused"), "abc1234");
  assert.equal(result.changed, true);
  assert.equal(gh.commits[0].tree, "oldtree");
  assert.deepEqual(gh.commits[0].parents, ["headsha"]);
});
