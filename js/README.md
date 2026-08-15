# The app, in seven files

| file | what lives here |
| --- | --- |
| `core.js` | Storage access, dialogs and toasts, instrument and key data, transposition, time signatures, shared state |
| `panels.js` | The control panels: score setup, parts, tabs, note controls, hairpins, chord palette |
| `editing.js` | Note entry, undo/redo, and everything for editing the selected note |
| `render.js` | Grouping notes into measures, drawing the score, pinch zoom |
| `audio.js` | MIDI in, live recording, the performance layer, playback, audition |
| `io.js` | Song storage, autosave, and every import and export path |
| `boot.js` | Computer-keyboard entry, the guided tour, starting the app |

They load in that order and must stay in it: each one uses names the ones above
it declare.

## Why these are ordinary scripts and not ES modules

They share one global scope, exactly as they did when they were a single
`<script>` block. That is deliberate, and it is worth knowing why before
anyone "fixes" it.

Two things stand in the way of `type="module"`:

**Shared mutable state.** `selectedNote`, `caretGap`, `parts`, `apIdx`,
`projects` and about fifty more are reassigned from all over the app — 139
assignment sites at the time of the split. An imported binding cannot be
assigned to; `import { selectedNote }` gives you a live read-only view. Doing
this properly means routing every one of those through a setter, or moving all
mutable state into one object and rewriting every read as well. Either is a
large mechanical rewrite of working code, with real regression risk and nothing
a user would ever notice.

**Inline handlers.** The markup wires 167 `onclick` attributes to 66 functions,
and those resolve from global scope. Module scope is not global, so every one
of them would need either a `window` bridge or rewiring to `addEventListener`.

Splitting the files gets the part that was actually painful — a change to
playback no longer means scrolling through engraving, and a diff shows the
concern it touches rather than a five-thousand-line file. Enforced module
boundaries would be better still, but that is a separate piece of work worth
doing on its own, not smuggled in beside a behaviour change.

Two checks in `test/check.mjs` guard the arrangement: every inline handler must
resolve to a function, and every script the page loads must be precached by the
service worker.

## Adding a file

Add the `<script src>` to `index.html` **and** the path to `SHELL_FILES` in
`sw.js`, or the app will open offline with a piece missing. The check will tell
you if you forget.
