# Pagesmith

Host your own websites, with your own domain, without paying a hosting provider.

Pagesmith is a small app you run on your own computer. You point it at a folder
of HTML files; it publishes that folder to GitHub Pages, wires up your custom
domain, and keeps every deploy so you can roll back. GitHub Pages is free for
public repositories, including the TLS certificate for your domain — so the only
thing you keep paying for is the domain name itself.

```
pagesmith                 open the dashboard
pagesmith deploy [name]   publish a site (or all of them) from the command line
pagesmith dns <name>      check whether a domain's DNS is pointing at GitHub
pagesmith list            show what is configured
```

## What it does

- **Publish a folder.** Every deploy is one atomic commit: visitors see the old
  site or the whole new one, never a half-uploaded mix.
- **Custom domains.** Writes the `CNAME` file, sets the domain on GitHub, turns
  on HTTPS as soon as the certificate is issued, and shows you the exact DNS
  records to enter at your registrar — then checks them for you.
- **History and rollback.** Every deploy is a commit; one click puts an earlier
  version back.
- **Local preview.** Serves the folder at `127.0.0.1` exactly the way Pages will,
  including a custom `404.html`, before anything is published.
- **No build step, no dependencies.** Node 20+ and nothing else. Your GitHub
  token is stored in `~/.pagesmith/config.json` (mode 0600) and is sent only to
  `api.github.com`.

## Setup

```sh
git clone <this repo> pagesmith
cd pagesmith
node bin/pagesmith.js
```

It prints a dashboard URL — open it. Then:

1. **Connect GitHub.** Create a classic token with the `repo` scope at
   [github.com/settings/tokens](https://github.com/settings/tokens/new?scopes=repo&description=Pagesmith)
   and paste it in. (A fine-grained token works too; it needs
   Contents: read & write, Pages: read & write, and Administration: read & write
   so the repository can be created.)
2. **Add a site.** Name it, browse to the folder with your `index.html`, choose
   the repository name to publish into, and enter your domain if you have one.
3. **Deploy.** The repository is created if it does not exist, Pages is enabled,
   and your files go live.

## Putting dutdutrecords.com on it

Add the site with `dutdutrecords.com` as the custom domain and deploy once.
Then click **Check domain** — it lists the records to create at whoever you
registered the domain with, and tells you when they have taken effect:

| Type  | Name | Value                  |
| ----- | ---- | ---------------------- |
| A     | @    | 185.199.108.153        |
| A     | @    | 185.199.109.153        |
| A     | @    | 185.199.110.153        |
| A     | @    | 185.199.111.153        |
| AAAA  | @    | 2606:50c0:8000::153    |
| AAAA  | @    | 2606:50c0:8001::153    |
| AAAA  | @    | 2606:50c0:8002::153    |
| AAAA  | @    | 2606:50c0:8003::153    |
| CNAME | www  | _yourlogin_.github.io  |

Delete any existing A or ALIAS records for `@` first, or the domain will keep
resolving to wherever it points now. DNS usually takes minutes; GitHub then
needs up to an hour to issue the certificate, after which Pagesmith turns on
"enforce HTTPS" on its next deploy.

If your registrar cannot serve A records at the apex, point `www` at GitHub with
the CNAME and set the bare domain to redirect to `www`.

## What Pagesmith does not do

- **Server-side code.** Pages serves static files. Anything with a database or a
  backend needs a different host; a static site generator's *output* folder is
  fine, and so is anything that talks to an API from the browser.
- **Private sites.** Pages on a private repository is a paid GitHub feature, so
  Pagesmith creates public repositories. Do not publish a folder containing
  anything you would not put on the open web.
- **Deleting things.** Removing a site from the dashboard forgets it locally;
  the repository and the live site stay exactly as they are.

## Under the hood

| File             | What it holds                                             |
| ---------------- | --------------------------------------------------------- |
| `bin/pagesmith.js` | CLI entry point: dashboard, deploy, dns, list            |
| `lib/server.js`  | The local HTTP API the dashboard talks to                  |
| `lib/deploy.js`  | Folder → blobs → tree → commit → Pages                     |
| `lib/github.js`  | A ~150-line GitHub REST client                             |
| `lib/site.js`    | Reading the folder, generated `CNAME` / `.nojekyll`, limits |
| `lib/dns.js`     | Required records and the live DNS check                    |
| `lib/static.js`  | Static serving for the dashboard and the preview           |
| `lib/config.js`  | `~/.pagesmith/config.json`                                 |
| `public/`        | The dashboard itself                                       |

The dashboard listens on `127.0.0.1` only, every API call must carry the session
key printed at startup, and requests arriving with a non-loopback `Host` header
are refused — so no other page in your browser can reach it and use your token.

```sh
npm test   # node --test, no dependencies
```
