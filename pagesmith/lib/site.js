// Reading a site folder off disk and turning it into the list of files that
// should end up in the repository.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep, posix } from "node:path";

// Things that are never part of a published site. `.git` would be a repository
// inside a repository; the rest are editor and OS litter.
const SKIP = new Set([".git", ".gitignore", "node_modules", ".DS_Store", "Thumbs.db", ".pagesmith"]);

// GitHub Pages hard limits: 1 GB per site, 100 MB per file. Catching this here
// gives a clear message instead of a rejected push halfway through an upload.
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_SITE_BYTES = 1024 * 1024 * 1024;

export class SiteError extends Error {}

// Walks `dir` and returns [{ path, abs, size }] with POSIX-style repo paths,
// sorted so a deploy of unchanged content produces an identical tree.
export async function collectFiles(dir) {
  const out = [];
  let total = 0;

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") throw new SiteError(`Folder not found: ${dir}`);
      if (err.code === "ENOTDIR") throw new SiteError(`Not a folder: ${dir}`);
      throw err;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const abs = join(current, entry.name);
      // Symlinks are followed as whatever they point at, and ignored when they
      // dangle — a broken link should not fail an otherwise fine deploy.
      let info;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!info.isFile()) continue;
      if (info.size > MAX_FILE_BYTES) {
        throw new SiteError(
          `${relative(dir, abs)} is ${mib(info.size)} — GitHub Pages refuses files over 100 MB.`,
        );
      }
      total += info.size;
      if (total > MAX_SITE_BYTES) {
        throw new SiteError("This folder is over the 1 GB GitHub Pages site limit.");
      }
      out.push({ path: relative(dir, abs).split(sep).join(posix.sep), abs, size: info.size });
    }
  }

  await walk(dir);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Two files Pages needs that nobody wants to maintain by hand:
//
//   CNAME     — the custom domain. Without it every deploy resets the domain
//               setting, which is the classic "my site went back to
//               user.github.io" surprise.
//   .nojekyll — stops Pages running Jekyll, which silently drops any folder
//               whose name starts with an underscore (_next, _assets…).
//
// A CNAME or .nojekyll the user wrote themselves wins; theirs is the intent.
export function withGeneratedFiles(files, { domain }) {
  const result = [...files];
  const have = new Set(files.map((f) => f.path));
  if (domain && !have.has("CNAME")) {
    result.push({ path: "CNAME", content: `${domain}\n`, generated: true });
  }
  if (!have.has(".nojekyll")) {
    result.push({ path: ".nojekyll", content: "", generated: true });
  }
  result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}

export async function readContent(file) {
  if (file.content !== undefined) return Buffer.from(file.content);
  return readFile(file.abs);
}

// A site with no index.html at the root serves a 404 at the domain apex. That
// is almost always a mistake — usually the wrong folder was picked, or the
// build output lives one level down.
export function findMissingIndex(files) {
  return files.some((f) => f.path === "index.html") ? null : "index.html";
}
