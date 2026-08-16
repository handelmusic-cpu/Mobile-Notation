// The deploy itself: folder on disk -> commit on a branch -> GitHub Pages.
//
// Files are uploaded as blobs and assembled into one tree and one commit, so a
// deploy is atomic from the visitor's point of view: either the whole new site
// is live or the old one still is. Nothing is ever deleted — every deploy is a
// commit, which is what makes rollback a one-liner.

import { GitHubError } from "./github.js";
import { collectFiles, withGeneratedFiles, readContent, findMissingIndex } from "./site.js";

const UPLOAD_CONCURRENCY = 6;

export async function deploySite(gh, site, { login, onProgress = () => {} } = {}) {
  const { owner, repo, branch, dir, domain } = site;
  const log = (message) => onProgress(message);

  log(`Reading ${dir}`);
  const found = await collectFiles(dir);
  if (found.length === 0) throw new Error(`${dir} has no files to publish.`);
  const files = withGeneratedFiles(found, { domain });
  const bytes = found.reduce((sum, f) => sum + f.size, 0);
  const warnings = [];
  if (findMissingIndex(files)) {
    warnings.push(
      "No index.html at the top of the folder — the site's home page will be a 404. Check you picked the right folder.",
    );
  }
  log(`${files.length} files, ${humanSize(bytes)}`);

  let repoInfo = await gh.getRepo(owner, repo);
  if (!repoInfo) {
    log(`Creating ${owner}/${repo}`);
    repoInfo = await gh.createRepo({ owner, repo, login, description: `${site.name} — Pagesmith` });
  }

  log("Uploading files");
  const tree = await uploadTree(gh, owner, repo, files, log);

  const ref = await gh.getRef(owner, repo, branch);
  const parents = ref ? [ref.object.sha] : [];

  // An unchanged folder should not manufacture an empty commit; comparing the
  // new tree against the head commit's tree is the cheapest way to notice.
  if (ref) {
    const head = await gh.get(`/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
    if (head.tree.sha === tree.sha) {
      log("No changes since the last deploy");
      const pages = await ensurePages(gh, site, log);
      return {
        changed: false,
        sha: ref.object.sha,
        files: files.length,
        bytes,
        warnings,
        pages,
      };
    }
  }

  const commit = await gh.createCommit(owner, repo, {
    message: `Deploy ${site.name} — ${new Date().toISOString()}`,
    tree: tree.sha,
    parents,
  });
  await gh.setRef(owner, repo, branch, commit.sha, { create: !ref });
  log(`Committed ${commit.sha.slice(0, 7)}`);

  const pages = await ensurePages(gh, site, log);

  return { changed: true, sha: commit.sha, files: files.length, bytes, warnings, pages };
}

// Roll the branch back to the tree of an earlier commit. This adds a commit
// rather than moving the branch backwards, so nothing in the history is lost
// and a rollback can itself be rolled back.
export async function rollbackSite(gh, site, sha, { onProgress = () => {} } = {}) {
  const { owner, repo, branch } = site;
  const target = await gh.get(`/repos/${owner}/${repo}/git/commits/${sha}`);
  const ref = await gh.getRef(owner, repo, branch);
  if (!ref) throw new Error(`${owner}/${repo} has no ${branch} branch to roll back.`);
  if (ref.object.sha === sha) return { sha, changed: false };

  const commit = await gh.createCommit(owner, repo, {
    message: `Roll back ${site.name} to ${sha.slice(0, 7)}`,
    tree: target.tree.sha,
    parents: [ref.object.sha],
  });
  await gh.setRef(owner, repo, branch, commit.sha, { create: false });
  onProgress(`Rolled back to ${sha.slice(0, 7)}`);
  return { sha: commit.sha, changed: true };
}

async function uploadTree(gh, owner, repo, files, log) {
  const entries = new Array(files.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      const content = await readContent(file);
      const blob = await gh.createBlob(owner, repo, content.toString("base64"));
      entries[index] = { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
      done++;
      if (done % 25 === 0) log(`Uploaded ${done}/${files.length}`);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, () => worker()),
  );
  // A tree built from scratch (no base_tree) means files deleted locally
  // disappear from the site too, which is what "publish this folder" implies.
  return gh.createTree(owner, repo, entries);
}

// Turn Pages on if it is off, keep the custom domain in step with the config,
// and ask for HTTPS once GitHub is willing to issue the certificate.
async function ensurePages(gh, site, log) {
  const { owner, repo, branch, domain } = site;
  let pages = await gh.getPages(owner, repo);
  if (!pages) {
    log("Enabling GitHub Pages");
    try {
      pages = await gh.enablePages(owner, repo, branch);
    } catch (err) {
      // Pages can 409 while the first commit is still being processed. The
      // deploy has already succeeded; say so rather than failing the whole run.
      if (err instanceof GitHubError && (err.status === 409 || err.status === 422)) {
        log("Pages is still waking up — it will pick up this commit shortly.");
        return { enabled: false, note: err.message };
      }
      throw err;
    }
  }

  if (domain && pages && pages.cname !== domain) {
    log(`Setting the custom domain to ${domain}`);
    try {
      await gh.updatePages(owner, repo, { cname: domain });
      pages = (await gh.getPages(owner, repo)) || pages;
    } catch (err) {
      // The usual cause is DNS not pointing here yet, which the dashboard's DNS
      // panel already explains in detail. Keep the deploy green.
      log(`Custom domain not accepted yet: ${short(err)}`);
    }
  }

  if (pages && domain && pages.https_certificate?.state === "approved" && !pages.https_enforced) {
    try {
      await gh.updatePages(owner, repo, { https_enforced: true });
      log("HTTPS enforced");
    } catch (err) {
      log(`Could not enforce HTTPS yet: ${short(err)}`);
    }
  }

  return pages
    ? {
        enabled: true,
        url: pages.html_url,
        cname: pages.cname,
        status: pages.status,
        https: pages.https_enforced,
        certificate: pages.https_certificate?.state || null,
      }
    : { enabled: false };
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function short(err) {
  return String(err.message || err).replace(/^GitHub \d+ on \S+: /, "");
}
