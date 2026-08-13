# Checks

A headless browser walk-through of the behaviours that are easy to break and
hard to notice: booting when the browser refuses storage, a song file that
tries to run code, edits surviving the app being backgrounded, transposition
across every key, bar capacity under a metre change, what the exported MIDI and
MusicXML actually contain, and what a screen reader would hear.

Each check drives the real app in a real browser rather than a stub, because
most of what it covers only goes wrong in a browser.

## Running

Needs [Playwright](https://playwright.dev) and a Chromium for it:

```sh
npm install playwright && npx playwright install chromium
```

Serve the app and run the checks against it:

```sh
python3 -m http.server 4821 &
node test/check.mjs
```

Point them somewhere else with `APP_URL`, and narrow to one group by passing
part of its name:

```sh
node test/check.mjs transpose
APP_URL=https://example.com/index.html node test/check.mjs
```

Exit status is non-zero if anything fails.
