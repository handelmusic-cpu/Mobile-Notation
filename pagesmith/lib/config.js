// Where Pagesmith keeps its state: one JSON file under the user's home
// directory. It holds a GitHub token, so the file is created with 0600 and the
// directory with 0700 — this is the only secret the app ever handles, and it
// never leaves the machine except as an Authorization header to api.github.com.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const DIR = process.env.PAGESMITH_HOME || join(homedir(), ".pagesmith");
const FILE = join(DIR, "config.json");

const EMPTY = { token: null, login: null, sites: [] };

export function configPath() {
  return FILE;
}

export async function load() {
  try {
    const raw = await readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    // Merge onto EMPTY so a config written by an older version still loads.
    return { ...structuredClone(EMPTY), ...parsed };
  } catch (err) {
    if (err.code === "ENOENT") return structuredClone(EMPTY);
    throw new Error(`Could not read ${FILE}: ${err.message}`);
  }
}

export async function save(config) {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  // Write-then-rename: a crash mid-write leaves the previous config intact
  // rather than a truncated file that would lose the token.
  const tmp = join(DIR, `.config.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, FILE);
  await chmod(FILE, 0o600);
  return config;
}

// The dashboard must never receive the token itself — only whether one is set.
export function redact(config) {
  const { token, ...rest } = config;
  return { ...rest, hasToken: Boolean(token) };
}

export function newSite({ name, dir, owner, repo, domain, branch = "main" }) {
  return {
    id: randomUUID(),
    name,
    dir,
    owner,
    repo,
    domain: domain || null,
    branch,
    createdAt: new Date().toISOString(),
    lastDeploy: null,
  };
}
