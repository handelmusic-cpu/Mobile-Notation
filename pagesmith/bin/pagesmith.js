#!/usr/bin/env node
// Two ways in:
//
//   pagesmith                 open the dashboard
//   pagesmith deploy [name]   publish a site (or all of them) without the UI,
//                             which is the form you want in a cron job or a
//                             file-watcher.

import { createApp } from "../lib/server.js";
import { load, save } from "../lib/config.js";
import { GitHub } from "../lib/github.js";
import { deploySite } from "../lib/deploy.js";
import { checkDomain } from "../lib/dns.js";

const [command, ...args] = process.argv.slice(2);

try {
  if (!command || command === "serve") await serve();
  else if (command === "deploy") await deploy(args[0]);
  else if (command === "list") await list();
  else if (command === "dns") await dns(args[0]);
  else usage();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

function usage() {
  console.log(`
  pagesmith                 open the dashboard
  pagesmith deploy [name]   publish one site, or every site if no name is given
  pagesmith dns <name>      check the DNS for a site's custom domain
  pagesmith list            show configured sites
`);
  process.exit(command ? 1 : 0);
}

async function serve() {
  const port = Number(process.env.PAGESMITH_PORT) || 4320;
  const previewPort = Number(process.env.PAGESMITH_PREVIEW_PORT) || port + 1;
  const { server, key, preview } = createApp({ previewPort });

  await new Promise((ok, fail) => {
    server.once("error", (err) =>
      fail(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${port} is busy. Set PAGESMITH_PORT to something else.`)
          : err,
      ),
    );
    server.listen(port, "127.0.0.1", ok);
  });
  await preview.listen();

  const url = `http://127.0.0.1:${port}/#key=${key}`;
  console.log(`\n  Pagesmith is running.\n\n  Dashboard: ${url}\n  Preview:   http://127.0.0.1:${previewPort}/\n`);
  console.log("  Keep this window open. Ctrl-C stops it.\n");
}

async function withSites(name, fn) {
  const config = await load();
  if (!config.token) throw new Error("No GitHub token yet — run `pagesmith` and connect once.");
  const sites = name
    ? config.sites.filter((s) => s.name === name || s.repo === name || s.id === name)
    : config.sites;
  if (sites.length === 0) throw new Error(name ? `No site called "${name}".` : "No sites yet.");
  await fn(config, sites);
  await save(config);
}

async function deploy(name) {
  await withSites(name, async (config, sites) => {
    const gh = new GitHub(config.token);
    for (const site of sites) {
      console.log(`\n  ${site.name} -> ${site.owner}/${site.repo}`);
      const result = await deploySite(gh, site, {
        login: config.login,
        onProgress: (m) => console.log(`    ${m}`),
      });
      for (const warning of result.warnings) console.log(`    ! ${warning}`);
      site.lastDeploy = {
        at: new Date().toISOString(),
        sha: result.sha,
        files: result.files,
        bytes: result.bytes,
        changed: result.changed,
      };
      const live = site.domain ? `https://${site.domain}` : result.pages?.url || "(pending)";
      console.log(`    Live at ${live}`);
    }
    console.log("");
  });
}

async function dns(name) {
  if (!name) throw new Error("Which site? `pagesmith dns <name>`");
  await withSites(name, async (config, sites) => {
    for (const site of sites) {
      if (!site.domain) {
        console.log(`\n  ${site.name}: no custom domain configured.`);
        continue;
      }
      const check = await checkDomain(site.domain, config.login || site.owner);
      console.log(`\n  ${site.domain}: ${check.ok ? "OK" : "not pointing at GitHub yet"}`);
      if (check.found.length) console.log(`    found: ${check.found.join(", ")}`);
      if (check.error) console.log(`    lookup: ${check.error}`);
      console.log(`    ${check.advice}\n`);
    }
  });
}

async function list() {
  const config = await load();
  if (config.sites.length === 0) return console.log("\n  No sites yet.\n");
  console.log("");
  for (const site of config.sites) {
    const when = site.lastDeploy ? new Date(site.lastDeploy.at).toLocaleString() : "never deployed";
    console.log(`  ${site.name}\n    folder: ${site.dir}\n    repo:   ${site.owner}/${site.repo}`);
    console.log(`    domain: ${site.domain || "(github.io only)"}\n    last:   ${when}\n`);
  }
}
