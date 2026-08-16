import { test } from "node:test";
import assert from "node:assert/strict";

import { GitHub, GitHubError } from "../lib/github.js";

function reply(status, body, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("requests carry auth and the API version", async () => {
  let seen;
  const gh = new GitHub("tok", {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return reply(200, { login: "you" });
    },
  });
  assert.deepEqual(await gh.whoami(), { login: "you" });
  assert.match(seen.url, /\/user$/);
  assert.equal(seen.init.headers.authorization, "Bearer tok");
  assert.equal(seen.init.headers["x-github-api-version"], "2022-11-28");
});

test("404 becomes null for the things that may not exist yet", async () => {
  const gh = new GitHub("tok", { fetchImpl: async () => reply(404, { message: "Not Found" }) });
  assert.equal(await gh.getRepo("me", "site"), null);
  assert.equal(await gh.getPages("me", "site"), null);
});

test("other failures surface with GitHub's own message", async () => {
  const gh = new GitHub("tok", { fetchImpl: async () => reply(422, { message: "name exists" }) });
  await assert.rejects(() => gh.createRepo({ owner: "me", repo: "site", login: "me" }), (err) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.status, 422);
    assert.match(err.message, /name exists/);
    return true;
  });
});

test("server errors are retried, then given up on", async () => {
  let calls = 0;
  const gh = new GitHub("tok", {
    fetchImpl: async () => {
      calls++;
      return calls < 3 ? reply(500, "boom") : reply(200, { ok: true });
    },
  });
  assert.deepEqual(await gh.whoami(), { ok: true });
  assert.equal(calls, 3);
});

test("a token is required up front", () => {
  assert.throws(() => new GitHub(""), /token is required/);
});
