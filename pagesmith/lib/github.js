// A very small GitHub REST client. No dependencies: Node's fetch does the work,
// and everything Pagesmith needs is five or six endpoints.

const API = process.env.PAGESMITH_API || "https://api.github.com";

export class GitHubError extends Error {
  constructor(status, url, body) {
    const detail =
      (body && (body.message || body.error)) || (typeof body === "string" ? body.slice(0, 200) : "");
    super(`GitHub ${status} on ${url}${detail ? `: ${detail}` : ""}`);
    this.name = "GitHubError";
    this.status = status;
    this.body = body;
  }
}

export class GitHub {
  constructor(token, { fetchImpl = fetch } = {}) {
    if (!token) throw new Error("A GitHub token is required.");
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(method, path, body, { accept = "application/vnd.github+json" } = {}) {
    const url = path.startsWith("http") ? path : `${API}${path}`;
    // Secondary rate limits are answered with 403 + Retry-After. Three tries with
    // a growing pause is enough for a one-person deploy; more would just hide a
    // real problem behind a long wait.
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept,
          "x-github-api-version": "2022-11-28",
          "user-agent": "pagesmith",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const text = await res.text();
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep the raw text; GitHub only sends non-JSON on gateway errors */
      }

      const retryable = res.status >= 500 || (res.status === 403 && res.headers.get("retry-after"));
      if (!res.ok && retryable && attempt < 2) {
        const after = Number(res.headers.get("retry-after")) || 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(after, 30) * 1000));
        continue;
      }
      if (!res.ok) throw new GitHubError(res.status, url, parsed);
      return parsed;
    }
  }

  get(path, opts) {
    return this.request("GET", path, undefined, opts);
  }
  post(path, body) {
    return this.request("POST", path, body ?? {});
  }
  put(path, body) {
    return this.request("PUT", path, body ?? {});
  }

  // Returns null rather than throwing when a thing simply does not exist yet —
  // "no repo" and "Pages not enabled" are ordinary states during first setup.
  async maybe(path) {
    try {
      return await this.get(path);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  whoami() {
    return this.get("/user");
  }

  getRepo(owner, repo) {
    return this.maybe(`/repos/${owner}/${repo}`);
  }

  // `owner` may be the authenticated user or an org they belong to; the two
  // creation endpoints differ, so pick by comparing against the login.
  async createRepo({ owner, repo, login, description }) {
    const payload = {
      name: repo,
      description: description || "Published with Pagesmith",
      private: false, // GitHub Pages on a private repo requires a paid plan.
      auto_init: false,
      has_issues: false,
      has_wiki: false,
      has_projects: false,
    };
    return owner === login
      ? this.post("/user/repos", payload)
      : this.post(`/orgs/${owner}/repos`, payload);
  }

  async getRef(owner, repo, branch) {
    return this.maybe(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  }

  createBlob(owner, repo, contentBase64) {
    return this.post(`/repos/${owner}/${repo}/git/blobs`, {
      content: contentBase64,
      encoding: "base64",
    });
  }

  createTree(owner, repo, tree) {
    return this.post(`/repos/${owner}/${repo}/git/trees`, { tree });
  }

  createCommit(owner, repo, { message, tree, parents }) {
    return this.post(`/repos/${owner}/${repo}/git/commits`, { message, tree, parents });
  }

  async setRef(owner, repo, branch, sha, { create }) {
    return create
      ? this.post(`/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha })
      : this.request("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
          sha,
          force: true, // Rollback rewrites nothing, but a re-point must not be refused.
        });
  }

  listCommits(owner, repo, branch, perPage = 20) {
    return this.get(
      `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}`,
    );
  }

  getPages(owner, repo) {
    return this.maybe(`/repos/${owner}/${repo}/pages`);
  }

  enablePages(owner, repo, branch) {
    return this.post(`/repos/${owner}/${repo}/pages`, {
      source: { branch, path: "/" },
    });
  }

  // Setting the CNAME and turning on HTTPS are the same endpoint, but GitHub
  // rejects https_enforced until it has issued the certificate — so they are
  // sent as two independent calls and the second is allowed to fail for now.
  updatePages(owner, repo, body) {
    return this.put(`/repos/${owner}/${repo}/pages`, body);
  }
}
