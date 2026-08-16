# dutdutrecords.com

The Dutdut Records website: label home page, artist pages for Sklermbot, Quincy
and Jetson Handel, and a page linking the label's web apps.

Plain HTML and one stylesheet. No build step, no dependencies, nothing loaded
from another domain — open `index.html` in a browser and what you see is what
visitors get.

```
index.html                  label home: roster, apps, contact
apps/index.html             the web apps, one card each
artists/sklermbot/          artist page
artists/quincy/             artist page
artists/jetson-handel/      artist page
assets/style.css            every style on the site
assets/favicon.svg          the record mark
404.html                    served by GitHub Pages for unknown URLs
CNAME                       the custom domain
robots.txt, sitemap.xml     for search engines
```

## Editing

Every spot that needs your words is marked with an `<!-- EDIT: … -->` comment:
the label blurb, each artist's one-liner and bio, the listening links, the
release lists, and the contact address. Nothing else has to change.

- **Add a release**: copy an `<li>` inside `<ol class="releases">`.
- **Add a listening link**: copy an `<li>` inside `<ul class="links">`.
- **Add an app**: copy a card `<li>` in `apps/index.html`.
- **Add an artist**: copy an artist folder, change the name, the initial in
  `<span class="mark">`, and the `canonical`/`og:url` addresses; then add a card
  on the home page and a line in `sitemap.xml`. The `b` and `c` classes on the
  mark pick the other two colour schemes.

Photos are optional — put an image in `assets/` and reference it with
`<img src="/assets/name.jpg" alt="…" />`. The mark blocks exist so the site
looks finished without any.

## Publishing

With [Pagesmith](https://github.com/handelmusic-cpu/pagesmith):

```sh
pagesmith deploy "Dutdut Records"   # or press Deploy in the dashboard
```

Or straight from git, since this repository is what GitHub Pages serves:

```sh
git push
```

The first publish needs GitHub Pages switched on for the repository (Settings →
Pages → Deploy from a branch → `main` / root). The `CNAME` file here is what
holds `dutdutrecords.com` to the site; leave it in place.

DNS at your registrar, once:

| Type  | Name | Value                    |
| ----- | ---- | ------------------------ |
| A     | @    | 185.199.108.153          |
| A     | @    | 185.199.109.153          |
| A     | @    | 185.199.110.153          |
| A     | @    | 185.199.111.153          |
| AAAA  | @    | 2606:50c0:8000::153      |
| AAAA  | @    | 2606:50c0:8001::153      |
| AAAA  | @    | 2606:50c0:8002::153      |
| AAAA  | @    | 2606:50c0:8003::153      |
| CNAME | www  | handelmusic-cpu.github.io |

`pagesmith dns "Dutdut Records"` checks those for you and says what is missing.
