// Dashboard front end. Plain modules, no build step — the whole point of this
// app is that hosting a site should not require a toolchain.

// The session key arrives in the URL fragment, which browsers never send to a
// server, and is kept for this tab only. Reloading the page keeps you signed
// in; opening the dashboard from a stale bookmark asks for a fresh launch.
const KEY = readKey();

function readKey() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("key");
  if (fromHash) {
    sessionStorage.setItem("pagesmith-key", fromHash);
    history.replaceState(null, "", location.pathname);
    return fromHash;
  }
  return sessionStorage.getItem("pagesmith-key") || "";
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "x-pagesmith-key": KEY,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const el = (id) => document.getElementById(id);
let state = null;

// ---- rendering -------------------------------------------------------------

async function refresh() {
  state = await api("/state");
  el("account").replaceChildren(...accountBar());
  el("connect").hidden = state.hasToken;
  el("add").hidden = !state.hasToken;
  el("sites").hidden = !state.hasToken;
  el("sites").replaceChildren(...state.sites.map(siteCard));
}

function accountBar() {
  if (!state.hasToken) return [text("span", "not connected", "muted")];
  const who = text("span", `signed in as ${state.login}`);
  const out = document.createElement("button");
  out.textContent = "Disconnect";
  out.onclick = async () => {
    await api("/token", { method: "DELETE" });
    await refresh();
  };
  return [who, out];
}

function siteCard(site) {
  const card = document.createElement("section");
  card.className = "card site";
  card.dataset.id = site.id;

  const head = document.createElement("header");
  head.append(text("h2", site.name));
  const live = site.domain
    ? link(`https://${site.domain}`, site.domain)
    : link(`https://${site.owner}.github.io/${site.repo}/`, `${site.owner}.github.io/${site.repo}`);
  live.className = "live";
  head.append(live);
  card.append(head);

  card.append(text("p", `${site.dir}  →  ${site.owner}/${site.repo}`, "where"));
  card.append(
    text(
      "p",
      site.lastDeploy
        ? `Last deploy ${new Date(site.lastDeploy.at).toLocaleString()} · ${site.lastDeploy.files} files`
        : "Never deployed.",
      "muted",
    ),
  );

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    button("Deploy", () => deploy(site, card), "primary"),
    button("Preview locally", () => preview(site, card)),
    button("History", () => history_(site, card)),
    ...(site.domain ? [button("Check domain", () => dns(site, card))] : []),
    button("Remove", () => remove(site)),
  );
  card.append(actions);

  const log = document.createElement("div");
  log.className = "log";
  log.hidden = true;
  card.append(log);
  return card;
}

// ---- actions ---------------------------------------------------------------

async function deploy(site, card) {
  await run(card, "Deploying…", async (write) => {
    const result = await api(`/sites/${site.id}/deploy`, { method: "POST" });
    write(result.log.join("\n"));
    for (const warning of result.warnings) write(`! ${warning}`, "warn");
    write(
      result.changed
        ? `Done. ${result.files} files published as ${result.sha.slice(0, 7)}.`
        : "Already up to date.",
    );
    if (result.pages?.url) write(`GitHub Pages: ${result.pages.url}`);
    if (site.domain) {
      write(
        `Your site will be live at https://${site.domain} once DNS points at GitHub — use "Check domain" for the exact records.`,
      );
    }
    await refresh();
  });
}

async function preview(site, card) {
  await run(card, "Starting preview…", async (write) => {
    const { url } = await api(`/sites/${site.id}/preview`, { method: "POST" });
    write(`Serving ${site.dir} at ${url}`);
    window.open(url, "_blank", "noopener");
  });
}

async function history_(site, card) {
  await run(card, "Loading history…", async (write, log) => {
    const commits = await api(`/sites/${site.id}/deployments`);
    if (commits.length === 0) return write("Nothing deployed yet.");
    log.replaceChildren();
    const list = document.createElement("ul");
    list.className = "history";
    for (const [index, commit] of commits.entries()) {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.append(
        document.createTextNode(`${new Date(commit.at).toLocaleString()} — ${commit.message} `),
      );
      const sha = document.createElement("code");
      sha.textContent = commit.sha.slice(0, 7);
      label.append(sha);
      row.append(label);
      // The newest commit is what is already live; only older ones are targets.
      if (index > 0) {
        row.append(
          button("Roll back to this", async () => {
            if (!confirm(`Put the site back to ${commit.sha.slice(0, 7)}?`)) return;
            await api(`/sites/${site.id}/rollback`, {
              method: "POST",
              body: { sha: commit.sha },
            });
            toast("Rolled back. GitHub takes a minute to rebuild.");
          }),
        );
      }
      list.append(row);
    }
    log.append(list);
  });
}

async function dns(site, card) {
  await run(card, "Checking DNS…", async (write, log) => {
    const info = await api(`/sites/${site.id}/dns`);
    log.replaceChildren();

    const status = document.createElement("p");
    status.className = `status ${info.ok ? "ok" : "pending"}`;
    status.textContent = info.ok
      ? `${info.domain} points at GitHub.`
      : `${info.domain} is not pointing at GitHub yet.`;
    log.append(status);

    const table = document.createElement("table");
    table.className = "records";
    table.append(rowOf("th", ["Type", "Name", "Value"]));
    for (const record of info.records) {
      table.append(
        rowOf("td", [
          record.type,
          record.name,
          record.value + (record.optional ? "  (optional)" : ""),
        ]),
      );
    }
    log.append(table);

    log.append(text("p", info.advice, "muted"));
    if (info.found?.length) log.append(text("p", `Currently resolving to: ${info.found.join(", ")}`, "muted"));
    if (info.error) log.append(text("p", `Lookup said: ${info.error}`, "muted"));
    if (info.pages) {
      const cert = info.pages.certificate;
      log.append(
        text(
          "p",
          `GitHub Pages: ${info.pages.status || "building"}` +
            `, domain ${info.pages.cname || "not set"}` +
            `, certificate ${cert || "not issued yet"}` +
            `, HTTPS ${info.pages.https ? "enforced" : "off"}.`,
          "muted",
        ),
      );
    }
  });
}

async function remove(site) {
  if (!confirm(`Remove "${site.name}" from Pagesmith? The published site stays online.`)) return;
  await api(`/sites/${site.id}`, { method: "DELETE" });
  await refresh();
}

// Runs an action with the card's log open, its buttons disabled, and any error
// shown in place — errors here are things like "DNS not set" that the user is
// meant to read and act on, not console noise.
async function run(card, starting, fn) {
  const log = card.querySelector(".log");
  const buttons = [...card.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  log.hidden = false;
  log.className = "log";
  log.textContent = starting;

  const write = (line, className) => {
    if (className) {
      const span = document.createElement("span");
      span.className = className;
      span.textContent = `${line}\n`;
      log.append(span);
    } else {
      log.append(document.createTextNode(`${line}\n`));
    }
    log.scrollTop = log.scrollHeight;
  };

  try {
    log.textContent = "";
    write(starting);
    await fn(write, log);
  } catch (err) {
    log.className = "log bad";
    write(err.message);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---- forms -----------------------------------------------------------------

el("token-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/token", { method: "POST", body: { token: el("token").value.trim() } });
    el("token").value = "";
    await refresh();
    toast(`Connected as ${state.login}.`);
  } catch (err) {
    toast(err.message);
  }
};

el("site-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/sites", {
      method: "POST",
      body: {
        name: el("f-name").value,
        dir: el("f-dir").value,
        repo: el("f-repo").value,
        domain: el("f-domain").value,
      },
    });
    for (const id of ["f-name", "f-dir", "f-repo", "f-domain"]) el(id).value = "";
    await refresh();
    toast("Site added. Deploy when you are ready.");
  } catch (err) {
    toast(err.message);
  }
};

// ---- folder picker ---------------------------------------------------------

let pickerPath = null;

async function openPicker(start) {
  const dialog = el("picker");
  await showFolder(start || state.home);
  dialog.showModal();
}

async function showFolder(path) {
  let listing;
  try {
    listing = await api(`/browse?path=${encodeURIComponent(path)}`);
  } catch (err) {
    return toast(err.message);
  }
  pickerPath = listing.path;
  el("picker-path").textContent = listing.hasIndex
    ? `${listing.path}  ✓ contains index.html`
    : listing.path;
  const list = el("picker-list");
  list.replaceChildren();
  if (listing.parent) {
    list.append(pickerRow("⬑ up one level", listing.parent));
  }
  for (const folder of listing.folders) list.append(pickerRow(folder.name, folder.path));
}

function pickerRow(label, path) {
  const item = document.createElement("li");
  item.append(button(label, () => showFolder(path)));
  return item;
}

el("browse").onclick = () => openPicker(el("f-dir").value || null);
el("picker-cancel").onclick = () => el("picker").close();
el("picker-choose").onclick = () => {
  el("f-dir").value = pickerPath;
  if (!el("f-repo").value) el("f-repo").value = pickerPath.split("/").pop();
  el("picker").close();
};

// ---- tiny helpers ----------------------------------------------------------

function text(tag, content, className) {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}

function link(href, label) {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = label;
  a.target = "_blank";
  a.rel = "noreferrer";
  return a;
}

function button(label, onClick, className) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (className) b.className = className;
  b.onclick = onClick;
  return b;
}

function rowOf(cell, values) {
  const tr = document.createElement("tr");
  for (const value of values) tr.append(text(cell, value));
  return tr;
}

let toastTimer;
function toast(message) {
  const node = el("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 4200);
}

refresh().catch((err) => toast(`${err.message} — restart with \`pagesmith\` and use the new link.`));
