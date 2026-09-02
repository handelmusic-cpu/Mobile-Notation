import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Playwright is not vendored; use whichever copy is installed (local or global).
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); }
catch (e) { pw = require('/opt/node22/lib/node_modules/playwright/index.js'); }
const { chromium } = pw;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.APP_URL || 'http://localhost:4821/index.html';
const only = process.argv[2] || '';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '  ok  ' : 'FAIL  '}${n}${extra ? '  — ' + extra : ''}`); };

const browser = await chromium.launch();
async function page(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...opts });
  const p = await ctx.newPage();
  p._errs = []; p.on('pageerror', e => p._errs.push(e.message));
  return p;
}
async function boot(p) {
  await p.goto(APP_URL, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  // Measure what boot alone drew, BEFORE any helper touches the page —
  // endTour() calls render(), which would paint over a failed boot.
  p._bootSvgs = await p.evaluate(() => document.querySelectorAll('#score-div svg').length);
  await p.evaluate(() => { try { if (typeof endTour === 'function') endTour(); } catch (e) {}
    document.getElementById('tour-overlay')?.remove(); });
  await p.waitForTimeout(150);
  return p;
}
const run = (name, fn) => (!only || name.includes(only)) ? fn() : null;

// ── 1. Clean boot ────────────────────────────────────────────────────────
await run('boot', async () => {
  const p = await boot(await page());
  ok('boots with no page errors', p._errs.length === 0, p._errs[0] || '');
  ok('draws the staff', p._bootSvgs > 0, `svgs=${p._bootSvgs}`);
  await p.context().close();
});

// ── 2. Storage blocked (item 1) ──────────────────────────────────────────
await run('storage', async () => {
  const p = await page();
  await p.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('The operation is insecure.', 'SecurityError'); }
    });
  });
  await boot(p);
  ok('boots with localStorage blocked', p._errs.length === 0, p._errs[0] || '');
  ok('draws the staff with storage blocked', p._bootSvgs > 0, `svgs=${p._bootSvgs}`);
  const survives = await p.evaluate(() => {
    handleScaleBtn(0); handleScaleBtn(1);
    return parts[apIdx].notes.length;
  });
  ok('still accepts note entry with storage blocked', survives === 2, `notes=${survives}`);
  await p.context().close();
});

// ── 3. Name injection (item 2) ───────────────────────────────────────────
await run('injection', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(async () => {
    const payload = '<img src=x onerror="window.__pwned=1">';
    projects.push({ id: 'pX', name: payload, data: serializeProject(), updated: Date.now() });
    parts[0].name = payload;
    renderProjectsList(); renderPartsList(); renderPrintButtons();
    await new Promise(r => setTimeout(r, 250));
    return {
      pwned: !!window.__pwned,
      shown: (document.querySelector('#proj-list .pname')?.textContent || '').includes('onerror'),
      partShown: (document.querySelector('#parts-list .pname')?.textContent || '').includes('onerror'),
    };
  });
  ok('song/part names cannot run script', r.pwned === false);
  ok('song name still displays as text', r.shown === true);
  ok('part name still displays as text', r.partShown === true);
  await p.context().close();
});

// ── 4. Autosave flush (item 3) ───────────────────────────────────────────
await run('autosave', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(async () => {
    await new Promise(res => setTimeout(res, 600));            // let the store settle
    // Read from whichever store the app is actually using.
    const stored = async () => {
      if (idbUsable) {
        const rec = (await idbGetAll() || []).find(x => x.id === currentProjId);
        return rec ? rec.data.parts[apIdx].notes.length : -1;
      }
      return JSON.parse(localStorage.getItem('mn_projects') || '[]')
        .find(x => x.id === currentProjId)?.data.parts[apIdx].notes.length ?? -1;
    };
    handleScaleBtn(0); handleScaleBtn(2); handleScaleBtn(4);
    const before = await stored();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    // The synchronous recovery record is what has to be right the instant the
    // page goes away — the database write may not get to commit.
    const sync = idbUsable
      ? (JSON.parse(localStorage.getItem('mn_pending') || 'null')?.data.parts[apIdx].notes.length ?? -1)
      : null;
    await new Promise(res => setTimeout(res, 300));
    return { before, after: await stored(), sync, live: parts[apIdx].notes.length, idb: idbUsable };
  });
  // visibilityState is 'visible' in the test, so pagehide is what must save.
  ok('pagehide flushes pending edits', r.after === r.live, `stored=${r.after} live=${r.live} (was ${r.before})`);
  if (r.idb) ok('pagehide writes a synchronous recovery record', r.sync === r.live,
                `recovery=${r.sync} live=${r.live}`);
  await p.context().close();
});

// ── 5. Deleting a part (item 4) ──────────────────────────────────────────
await run('deletepart', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(() => {
    apIdx = 1; handleScaleBtn(0); handleScaleBtn(1);            // notes on the 2nd part
    selectedNote = { partIdx: 1, noteIdx: 1 };
    deletePart(0);                                              // remove the part above it
    const stale = selectedNote && selectedNote.partIdx >= parts.length;
    return { parts: parts.length, sel: selectedNote, caret: caretGap, stale, apIdx };
  });
  ok('deleting a part clears the stale selection', r.sel === null && r.caret === null,
     `sel=${JSON.stringify(r.sel)} caret=${JSON.stringify(r.caret)}`);
  await p.context().close();
});

// ── 6. Transposing instruments (item 7) ──────────────────────────────────
await run('transpose', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(() => {
    setKey('C');
    parts[0].instId = 'trumpet'; parts[0].transpose = 2;
    apIdx = 0;
    applyPitchView('written');
    // Tap the first scale degree; in written view on a Bb part that button is D.
    const buttonLetter = document.querySelectorAll('#note-grid .np')[0].textContent;
    handleScaleBtn(0);
    const n = parts[0].notes[0];
    const written = displayKeys(n, parts[0]);
    const sigWritten = partVfSig(parts[0]);
    applyPitchView('concert');
    const concert = displayKeys(n, parts[0]);
    const sigConcert = partVfSig(parts[0]);
    return { buttonLetter, sounding: n.midiVals[0], written: written.keys[0], concert: concert.keys[0], sigWritten, sigConcert };
  });
  ok('note grid shows the written key', r.buttonLetter === 'D', `got "${r.buttonLetter}"`);
  ok('written view draws the transposed pitch', r.written.startsWith('D/'), `written=${r.written}`);
  ok('the stored pitch is what sounds', r.concert.startsWith('C/'), `concert=${r.concert}`);
  ok('written key signature is D for a Bb part in C', r.sigWritten === 'D', `sig=${r.sigWritten}`);
  ok('concert view keeps the concert signature', r.sigConcert === 'C', `sig=${r.sigConcert}`);
  ok('no page errors while transposing', p._errs.length === 0, p._errs[0] || '');
  await p.context().close();
});

// ── 6b. Minor keys keep their degree order when transposed ───────────────
await run('transpose-minor', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(() => {
    const out = {};
    parts[0].instId = 'trumpet'; parts[0].transpose = 2; apIdx = 0;
    setKey('Am');
    applyPitchView('concert');
    out.concert = partScale(parts[0]).map(x => x[0] + (x[1] || '')).join(' ');
    applyPitchView('written');
    out.written = partScale(parts[0]).map(x => x[0] + (x[1] || '')).join(' ');
    out.sig = partVfSig(parts[0]);
    // Tapping the tonic degree must give the written tonic.
    parts[0].notes = [];
    handleScaleBtn(0);
    out.firstTap = displayKeys(parts[0].notes[0], parts[0]).keys[0];
    out.sounds = parts[0].notes[0].midiVals[0] % 12;
    return out;
  });
  // Bb trumpet in concert A minor reads B minor: B C# D E F# G A, 2 sharps.
  ok('a transposed minor key starts on its own tonic', r.written.startsWith('B C#'),
     `written scale = ${r.written}`);
  ok('concert view is unchanged for minor', r.concert.startsWith('A B C'), `concert scale = ${r.concert}`);
  ok('the signature is still the relative major of the written key', r.sig === 'D', `sig=${r.sig}`);
  ok('tapping degree 1 writes the written tonic', /^B\//.test(r.firstTap), `wrote ${r.firstTap}`);
  ok('and it sounds the concert tonic', r.sounds === 9, `pitch class ${r.sounds}, expected 9 (A)`);
  await p.context().close();
});

// ── 7. Round trip through every key and transposition ────────────────────
await run('transpose-sweep', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(() => {
    const bad = [];
    for (const k of KEYS_DATA.map(x => x.id)) {
      for (const semis of [0, 2, 3, 7, 9, 12, 14, -12]) {
        setKey(k);
        parts[0].transpose = semis; apIdx = 0;
        applyPitchView('written');
        for (let midi = 36; midi <= 84; midi++) {
          const sp = spellInScale(midi + semis, partScale(parts[0]), partFifths(parts[0]) < 0);
          const back = noteToMidi(sp.name, sp.acc, sp.oct);
          if (back !== midi + semis) bad.push({ k, semis, midi, got: back, spell: sp });
        }
        if (!FIFTHS_TO_MAJOR[String(partFifths(parts[0]))]) bad.push({ k, semis, err: 'no signature' });
      }
    }
    return { bad: bad.slice(0, 5), count: bad.length };
  });
  ok('every key x transposition spells back to the right pitch', r.count === 0,
     r.count ? `${r.count} mismatches, e.g. ${JSON.stringify(r.bad[0])}` : '');
  await p.context().close();
});

// ── 8. Mid-score key and metre changes, pickup bars (item 8) ─────────────
await run('changes', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(() => {
    const q = () => ({ keys: ['C/4'], dur: 'q', vfAccs: [null], midiVals: [60], rest: false,
      lyric: null, dyn: null, arts: [], tempo: null, rud: null, grace: [], sticking: null });
    parts[0].notes = []; apIdx = 0;
    setKey('C'); setTimeSig('4/4');
    keyChanges = {}; sigChanges = {}; pickupBeats = 0;
    for (let i = 0; i < 20; i++) parts[0].notes.push(q());   // 20 quarters = 5 bars of 4/4
    const barsPlain = toMeasures(parts[0].notes).length;

    // 3/4 from bar 3 -> 2 bars of 4/4 (8 quarters) then 12 quarters of 3/4 = 4 bars
    sigChanges = { 2: '3/4' };
    const bars34 = toMeasures(parts[0].notes).map(m => m.reduce((s, n) => s + noteBeats(n), 0));

    // A 1-beat pickup shortens bar 1 only
    sigChanges = {}; pickupBeats = 1;
    const barsPickup = toMeasures(parts[0].notes).map(m => m.reduce((s, n) => s + noteBeats(n), 0));

    // Key change from bar 3
    pickupBeats = 0; keyChanges = { 2: 'D' };
    const k = [keyAt(0), keyAt(1), keyAt(2), keyAt(4)];
    const sigs = [partVfSig(parts[0], 0), partVfSig(parts[0], 2)];
    const drawsChange = keyChangeAt(2) && !keyChangeAt(1);
    keyChanges = {};
    render();
    return { barsPlain, bars34, barsPickup, k, sigs, drawsChange };
  });
  ok('a plain 4/4 score still bars as before', r.barsPlain === 5, `bars=${r.barsPlain}`);
  ok('a metre change resizes later bars', JSON.stringify(r.bars34) === JSON.stringify([4, 4, 3, 3, 3, 3]),
     `bars=${JSON.stringify(r.bars34)}`);
  ok('a pickup shortens only the first bar', r.barsPickup[0] === 1 && r.barsPickup[1] === 4,
     `bars=${JSON.stringify(r.barsPickup)}`);
  ok('the key in force follows the change', JSON.stringify(r.k) === JSON.stringify(['C', 'C', 'D', 'D']),
     `keys=${JSON.stringify(r.k)}`);
  ok('the signature is redrawn only where it changes', r.drawsChange === true);
  ok('no page errors with changes in play', p._errs.length === 0, p._errs[0] || '');
  await p.context().close();
});

// ── 9. Markings are audible (item 10) ────────────────────────────────────
await run('markings', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(() => {
    const q = (dyn, arts) => ({ keys: ['C/4'], dur: 'q', vfAccs: [null], midiVals: [60], rest: false,
      lyric: null, dyn: dyn || null, arts: arts || [], tempo: null, rud: null, grace: [], sticking: null });
    parts[0].notes = [q('pp'), q(), q('ff'), q(), q(null, ['a.']), q(null, ['a>']), q(null, ['ao'])];
    parts[0].hairpins = [];
    const v = velocityMap(parts[0]);
    const holds = parts[0].notes.map(n => articulationHold(n));

    // A crescendo across notes 0..3 should rise monotonically.
    parts[0].notes = [q('pp'), q(), q(), q('ff')];
    parts[0].hairpins = [{ type: 'cresc', start: 0, end: 3 }];
    const cres = velocityMap(parts[0]);

    // A tempo word must bend the timeline.
    const allM = parts.map(x => toMeasures(x.notes));
    const order = buildPlayOrder(Math.max(...allM.map(m => m.length), 1));
    const flat = buildTempoMap(order, allM, 100);
    parts[0].notes[2].tempo = 'Presto';
    const allM2 = parts.map(x => toMeasures(x.notes));
    const fast = buildTempoMap(order, allM2, 100);
    const secFlat = beatToSec(flat, 4), secFast = beatToSec(fast, 4);
    parts[0].notes[2].tempo = null;
    return { v, holds, cres, secFlat, secFast, tempoPts: fast.length };
  });
  ok('pp is quieter than ff', r.v[0] < r.v[2], `pp=${r.v[0]} ff=${r.v[2]}`);
  ok('an accent is louder than the note before it', r.v[5] > r.v[4], `plain=${r.v[4]} accent=${r.v[5]}`);
  ok('staccato shortens the note', r.holds[4] < 0.6, `hold=${r.holds[4]}`);
  ok('a fermata lengthens it', r.holds[6] > 1.5, `hold=${r.holds[6]}`);
  ok('a crescendo rises note by note',
     r.cres[0] < r.cres[1] && r.cres[1] < r.cres[2] && r.cres[2] < r.cres[3],
     JSON.stringify(r.cres.map(x => +x.toFixed(2))));
  ok('a tempo word speeds the music up', r.secFast < r.secFlat * 0.95,
     `flat=${r.secFlat.toFixed(2)}s fast=${r.secFast.toFixed(2)}s`);
  await p.context().close();
});

// ── 10. MIDI export matches playback (item 13) ───────────────────────────
await run('midi', async () => {
  const p = await boot(await page());
  const bytes = await p.evaluate(() => {
    const q = (dyn) => ({ keys: ['C/4'], dur: 'q', vfAccs: [null], midiVals: [60], rest: false,
      lyric: null, dyn: dyn || null, arts: [], tempo: null, rud: null, grace: [], sticking: null });
    parts.length = 0; pid = 1;
    parts.push(mkPart('Flute', 'flute', 'treble'));
    parts.push(mkPart('Snare', 'snare', 'percussion'));
    parts[0].notes = [q('pp'), q('pp'), q('pp'), q('pp'), q('fff'), q('fff'), q('fff'), q('fff')];
    parts[1].notes = [q(), q(), q(), q()];
    repeatStartMeasures = [0]; repeatEndMeasures = [0];    // bar 1 repeats
    keyChanges = {}; sigChanges = {}; pickupBeats = 0;
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = b => { captured = b; return 'blob:stub'; };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    exportMIDI();
    URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick;
    return captured.arrayBuffer().then(ab => Array.from(new Uint8Array(ab)));
  });
  const u8 = Uint8Array.from(bytes);
  // Walk note-on events out of the raw file.
  const ons = [];
  for (let i = 0; i < u8.length - 2; i++) {
    const st = u8[i];
    if ((st & 0xf0) === 0x90 && u8[i + 2] > 0) ons.push({ ch: st & 0x0f, note: u8[i + 1], vel: u8[i + 2] });
  }
  const vels = [...new Set(ons.map(o => o.vel))];
  ok('MIDI export produces a valid header', u8[0] === 0x4d && u8[1] === 0x54 && u8[2] === 0x68,
     `first bytes ${u8.slice(0, 4)}`);
  ok('exported velocities follow the dynamics', vels.length > 1, `velocities=${JSON.stringify(vels)}`);
  ok('percussion is exported on channel 10', ons.some(o => o.ch === 9), `channels=${JSON.stringify([...new Set(ons.map(o => o.ch))])}`);
  // 8 flute notes = 2 bars; bar 1 repeats, so the repeated bar's 4 notes appear twice.
  const fluteOns = ons.filter(o => o.ch !== 9).length;
  ok('repeats are expanded in the export like they are in playback', fluteOns === 12,
     `flute note-ons=${fluteOns}, expected 12 (4 + 4 repeated + 4)`);
  await p.context().close();
});

// ── 11. MusicXML: two voices on one staff, and .mxl (items 11, 12) ───────
await run('musicxml', async () => {
  const fs = await import('node:fs/promises');
  const xml = await fs.readFile(path.join(HERE,'twovoice.xml'), 'utf8');
  const mxl = await fs.readFile(path.join(HERE,'twovoice.mxl'));
  const p = await boot(await page());
  const r = await p.evaluate(async ({ xml, mxlB64 }) => {
    const d = parseMusicXML(xml);
    // Same file, compressed.
    const bin = Uint8Array.from(atob(mxlB64), c => c.charCodeAt(0));
    let mxlText = null, mxlErr = null;
    try { mxlText = await unzipMXL(bin.buffer); } catch (e) { mxlErr = e.message; }
    const dz = mxlText ? parseMusicXML(mxlText) : null;
    return {
      parts: d.parts.map(pt => ({ n: pt.notes.length, name: pt.name,
        beats: pt.notes.reduce((s, x) => s + durBeats(x.dur), 0),
        first: pt.notes[0] && pt.notes[0].keys[0] })),
      mxlErr,
      mxlParts: dz ? dz.parts.length : -1,
      mxlSame: dz ? JSON.stringify(dz.parts.map(x => x.notes.length)) === JSON.stringify(d.parts.map(x => x.notes.length)) : false,
    };
  }, { xml, mxlB64: mxl.toString('base64') });

  ok('two voices import as two lines, not one', r.parts.length === 2, `parts=${JSON.stringify(r.parts)}`);
  ok('each voice keeps its own length (4 beats, not 8)',
     r.parts.every(x => Math.abs(x.beats - 4) < 0.01), JSON.stringify(r.parts.map(x => x.beats)));
  ok('voice 1 has 2 notes and voice 2 has 4', r.parts[0] && r.parts[0].n === 2 && r.parts[1] && r.parts[1].n === 4,
     JSON.stringify(r.parts.map(x => x.n)));
  ok('the part name from the file is kept', /Piano/.test(r.parts[0].name || ''), `name=${r.parts[0].name}`);
  ok('a compressed .mxl opens', r.mxlErr === null, r.mxlErr || '');
  ok('.mxl parses to the same score as the .xml', r.mxlSame === true, `parts=${r.mxlParts}`);
  await p.context().close();
});

// ── 12. MusicXML export, and a round trip back in (item 9) ───────────────
await run('xmlexport', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(() => {
    const mk = (midi, dur, extra) => Object.assign({ keys: ['C/4'], dur, vfAccs: [null], midiVals: [midi],
      rest: false, lyric: null, dyn: null, arts: [], tempo: null, rud: null, grace: [], sticking: null }, extra || {});
    parts.length = 0; pid = 1;
    parts.push(mkPart('Trumpet', 'trumpet', 'treble'));   // Bb, +2
    parts.push(mkPart('Piano', 'piano', 'treble'));
    apIdx = 0;
    setKey('Bb'); setTimeSig('4/4');
    keyChanges = {}; sigChanges = {}; pickupBeats = 0;
    repeatStartMeasures = []; repeatEndMeasures = [];
    // Concert Bb3, C4, D4, Eb4 on both parts; a lyric and a dynamic and a staccato.
    [58, 60, 62, 63].forEach((m, i) => {
      const sp = spellConcert(m);
      parts[0].notes.push(mk(m, 'q', { keys: [sp.name + '/' + sp.oct], vfAccs: [sp.vfAcc],
        dyn: i === 0 ? 'mf' : null, arts: i === 3 ? ['a.'] : [], lyric: i === 0 ? 'la' : null }));
      parts[1].notes.push(mk(m, 'q', { keys: [sp.name + '/' + sp.oct], vfAccs: [sp.vfAcc] }));
    });
    const xml = buildMusicXML();
    const back = parseMusicXML(xml);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const err = doc.querySelector('parsererror') ? 'parse error' : null;
    const tpParts = [...doc.querySelectorAll('part')];
    const trumpetFifths = tpParts[0].querySelector('key fifths')?.textContent;
    const pianoFifths = tpParts[1].querySelector('key fifths')?.textContent;
    const tr = tpParts[0].querySelector('transpose');
    const firstStep = tpParts[0].querySelector('note pitch step')?.textContent;
    const firstOct = tpParts[0].querySelector('note pitch octave')?.textContent;
    return {
      err,
      trumpetFifths, pianoFifths,
      transpose: tr ? { d: tr.querySelector('diatonic').textContent, c: tr.querySelector('chromatic').textContent } : null,
      firstStep, firstOct,
      hasLyric: /<text>la<\/text>/.test(xml),
      hasDyn: /<dynamics><mf\/><\/dynamics>/.test(xml),
      hasStacc: /<staccato\/>/.test(xml),
      backParts: back.parts.length,
      backNotes: back.parts.map(x => x.notes.length),
      backKey: back.keyId,
      size: xml.length,
    };
  });
  ok('the exported MusicXML is well-formed', r.err === null, r.err || '');
  ok('a Bb trumpet part is written in C', r.trumpetFifths === '0', `fifths=${r.trumpetFifths}`);
  ok('the concert part keeps two flats', r.pianoFifths === '-2', `fifths=${r.pianoFifths}`);
  ok('<transpose> says how to get back to concert',
     r.transpose && r.transpose.c === '-2' && r.transpose.d === '-1', JSON.stringify(r.transpose));
  ok('the trumpet reads C where the score sounds Bb', r.firstStep === 'C' && r.firstOct === '4',
     `${r.firstStep}${r.firstOct}`);
  ok('lyrics, dynamics and articulations survive', r.hasLyric && r.hasDyn && r.hasStacc,
     `lyric=${r.hasLyric} dyn=${r.hasDyn} staccato=${r.hasStacc}`);
  ok('the export reads back through our own importer',
     r.backParts === 2 && JSON.stringify(r.backNotes) === '[4,4]',
     `parts=${r.backParts} notes=${JSON.stringify(r.backNotes)}`);
  await p.context().close();
});

// ── 13. Playhead, mute/solo, loop (item 14) ──────────────────────────────
await run('transport', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(() => {
    parts.length = 0; pid = 1;
    parts.push(mkPart('A', 'piano', 'treble'));
    parts.push(mkPart('B', 'piano', 'bass'));
    parts.push(mkPart('C', 'piano', 'bass'));
    renderPartsList();
    const btns = document.querySelectorAll('#parts-list .pmix').length;
    // Mute lives on the part and solo is keyed by part id, so neither can
    // slide onto a neighbour when a part is removed.
    parts.forEach(x => { x.muted = false; }); soloParts = new Set();
    parts[1].muted = true;
    const withMute = [0, 1, 2].map(partMuted);
    soloParts = new Set([parts[2].id]);
    const withSolo = [0, 1, 2].map(partMuted);
    parts.forEach(x => { x.muted = false; }); soloParts = new Set();
    toggleLoop();
    const loopOn = loopPlayback && document.getElementById('loop-btn').classList.contains('on');
    toggleLoop();
    return { btns, withMute, withSolo, loopOn, loopOff: loopPlayback,
             hasPlayheadFn: typeof startPlayhead === 'function' };
  });
  ok('every part row gets mute and solo', r.btns === 6, `buttons=${r.btns}`);
  ok('mute silences only that part', JSON.stringify(r.withMute) === '[false,true,false]', JSON.stringify(r.withMute));
  ok('solo silences everything else', JSON.stringify(r.withSolo) === '[true,true,false]', JSON.stringify(r.withSolo));
  ok('loop toggles on and off', r.loopOn === true && r.loopOff === false);
  ok('the playhead is wired up', r.hasPlayheadFn === true);
  ok('no page errors in the transport UI', p._errs.length === 0, p._errs[0] || '');
  await p.context().close();
});

// ── 14. History is bounded and entry stays cheap (item 15) ───────────────
await run('history', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(() => {
    const out = {};
    const bench = () => { const t0 = performance.now(); for (let i = 0; i < 20; i++) handleScaleBtn(i % 7); return (performance.now() - t0) / 20; };
    parts[0].notes = []; apIdx = 0; resetHistory();
    out.at0 = bench();
    const src = JSON.stringify(parts[apIdx].notes[0]);
    for (let i = 0; i < 1200; i++) parts[apIdx].notes.push(JSON.parse(src));
    render();
    out.at1200 = bench();
    out.snapshotKB = Math.round(currentStateStr().length / 1024);
    // Hammer history until the cap has to bite.
    for (let i = 0; i < 60; i++) { parts[apIdx].notes.push(JSON.parse(src)); render(); }
    out.entries = history.length;
    out.trackedMB = +(historyBytes / 1048576).toFixed(2);
    out.actualMB = +(history.reduce((s, x) => s + x.length, 0) / 1048576).toFixed(2);
    // Undo/redo must still work after trimming.
    const before = parts[apIdx].notes.length;
    undo(); const afterUndo = parts[apIdx].notes.length;
    redo(); const afterRedo = parts[apIdx].notes.length;
    out.undoWorks = afterUndo === before - 1 && afterRedo === before;
    return out;
  });
  ok('history stays under its byte cap', r.trackedMB <= 4.01, `${r.trackedMB} MB across ${r.entries} entries`);
  ok('the byte count matches what is really held', Math.abs(r.trackedMB - r.actualMB) < 0.01,
     `tracked=${r.trackedMB} actual=${r.actualMB}`);
  ok('undo and redo still work after trimming', r.undoWorks === true);
  // Measured against this machine's own baseline rather than a fixed
  // millisecond bound: absolute timings swing by 2x on a loaded CI box, and
  // what matters is that cost does not run away with the length of the piece.
  ok('note entry does not slow down sharply on a long score',
     r.at1200 < Math.max(r.at0 * 3, 6) && r.at1200 < 30,
     `${r.at0.toFixed(1)}ms empty -> ${r.at1200.toFixed(1)}ms at 1200 notes (snapshot ${r.snapshotKB} KB)`);
  await p.context().close();
});

// ── 15. IndexedDB song store (item 16) ───────────────────────────────────
await run('idb', async () => {
  const p = await boot(await page());
  // First boot migrates whatever localStorage held.
  const migrated = await p.evaluate(async () => {
    await new Promise(r => setTimeout(r, 600));
    const db = await idbOpen();
    const all = await idbGetAll();
    return { usable: idbUsable, count: all ? all.length : -1, names: (all || []).map(x => x.name) };
  });
  ok('IndexedDB opens and takes over', migrated.usable === true);
  ok('existing localStorage songs are migrated', migrated.count >= 1, `records=${migrated.count} ${JSON.stringify(migrated.names)}`);

  // Well past the old ~5MB localStorage ceiling.
  const big = await p.evaluate(async () => {
    const src = { keys: ['C/4'], dur: 'q', vfAccs: [null], midiVals: [60], rest: false,
      lyric: 'syllable', dyn: null, arts: [], tempo: null, rud: null, grace: [], sticking: null };
    let lsErr = null;
    for (let s = 0; s < 20; s++) {
      newProject('Big song ' + s);
      parts[0].notes = Array.from({ length: 2500 }, () => JSON.parse(JSON.stringify(src)));
      writeCurrentProject();
      await new Promise(r => setTimeout(r, 120));
    }
    try { localStorage.setItem('mn_probe', JSON.stringify(projects)); localStorage.removeItem('mn_probe'); }
    catch (e) { lsErr = e.name; }
    const all = await idbGetAll();
    const bytes = JSON.stringify(projects).length;
    return { records: all ? all.length : -1, mb: +(bytes / 1048576).toFixed(2), lsErr, saveFailed };
  });
  ok('many large songs are stored without failing',
     big.records >= 20 && big.saveFailed === false, `records=${big.records} totalling ${big.mb} MB, saveFailed=${big.saveFailed}`);
  ok('the same data would have blown the localStorage quota',
     big.lsErr !== null, big.lsErr ? `localStorage threw ${big.lsErr} at ${big.mb} MB` : `no quota error at ${big.mb} MB — ceiling not demonstrated`);

  // Songs survive a reload.
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  const after = await p.evaluate(() => ({ n: projects.length, notes: parts[apIdx]?.notes.length ?? -1, name: projects.find(x=>x.id===currentProjId)?.name }));
  ok('songs come back after a reload', after.n >= 20, `songs=${after.n}, current part has ${after.notes} notes`);
  ok('the song that was open is the one restored', after.notes === 2500, `"${after.name}" has ${after.notes} notes, expected 2500`);
  ok('no page errors from the store', p._errs.length === 0, p._errs[0] || '');
  await p.context().close();
});

// ── 16. The score in words (item 17) ─────────────────────────────────────
await run('a11y', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(async () => {
    parts.length = 0; pid = 1;
    parts.push(mkPart('Trumpet', 'trumpet', 'treble'));
    apIdx = 0; setKey('C'); setTimeSig('4/4');
    keyChanges = {}; sigChanges = {}; pickupBeats = 0;
    const mk = (midi, dur, extra) => { const sp = spellConcert(midi);
      return Object.assign({ keys: [sp.name + '/' + sp.oct], dur, vfAccs: [sp.vfAcc], midiVals: [midi],
        rest: false, lyric: null, dyn: null, arts: [], tempo: null, rud: null, grace: [], sticking: null }, extra || {}); };
    parts[0].notes = [
      mk(60, 'q', { dyn: 'mf', lyric: 'la' }),
      mk(62, 'h', { arts: ['a.'] }),
      { keys: ['b/4'], dur: 'qr', vfAccs: [null], midiVals: [], rest: true, lyric: null, dyn: null,
        arts: [], tempo: null, rud: null, grace: [], sticking: null },
      mk(66, 'q'),
    ];
    applyPitchView('written');
    render();
    selectedNote = { partIdx: 0, noteIdx: 0 }; updateSelectionUI();
    const first = document.getElementById('score-live').textContent;
    selectedNote = { partIdx: 0, noteIdx: 3 }; updateSelectionUI();
    const fourth = document.getElementById('score-live').textContent;
    // The outline is deliberately rebuilt off the critical path, so wait for it.
    await new Promise(res => setTimeout(res, 900));
    const outline = document.getElementById('score-outline').textContent;
    const live = document.getElementById('score-live');
    return {
      first, fourth, outline,
      liveRole: live.getAttribute('role'), livePolite: live.getAttribute('aria-live'),
      bars: document.querySelectorAll('#score-outline li').length,
      offscreen: getComputedStyle(document.getElementById('score-outline')).clipPath !== 'none',
    };
  });
  ok('the selected note is announced with bar, beat, pitch and length',
     /bar 1 beat 1/.test(r.first) && /D 4/.test(r.first) && /quarter note/.test(r.first),
     `"${r.first}"`);
  ok('its markings are announced too', /mf/.test(r.first) && /lyric la/.test(r.first), `"${r.first}"`);
  // quarter + half + quarter rest fills bar 1 exactly, so the 4th note opens bar 2.
  ok('a later note reports the right bar and beat', /bar 2 beat 1/.test(r.fourth), `"${r.fourth}"`);
  ok('the announcement follows the written pitch of a transposing part',
     /G. 4|G sharp 4/.test(r.fourth), `"${r.fourth}"`);
  ok('the live region is set up to be spoken', r.liveRole === 'status' && r.livePolite === 'polite');
  ok('the part is also readable as a list of bars', r.bars >= 2 && /Bar 1:/.test(r.outline),
     `${r.bars} bars`);
  ok('rests are named', /rest/.test(r.outline), '');
  ok('none of it is visible on screen', r.offscreen === true);
  await p.context().close();
});

// ── 17. Dialogs and toasts in the app's own clothes (item 19) ────────────
await run('dialogs', async () => {
  const p = await boot(await page());
  // Anything reaching a native dialog would hang the test rather than fail it.
  await p.evaluate(() => {
    window.__native = 0;
    window.alert = () => { window.__native++; };
    window.confirm = () => { window.__native++; return true; };
    window.prompt = () => { window.__native++; return 'x'; };
  });
  const r = await p.evaluate(async () => {
    const out = {};
    // A nudge is a toast, not a modal.
    selectedNote = null; toggleRepeatStart();
    out.toast = document.querySelector('#toast-host .toast')?.textContent || '';
    out.noModalForNudge = !document.getElementById('app-sheet').classList.contains('on');

    // Confirm: open, cancel, and check nothing happened.
    parts[0].notes = [{ keys: ['C/4'], dur: 'q', vfAccs: [null], midiVals: [60], rest: false,
      lyric: null, dyn: null, arts: [], tempo: null, rud: null, grace: [], sticking: null }];
    const pending = clearAll();
    await new Promise(r => setTimeout(r, 60));
    out.confirmOpen = document.getElementById('app-sheet').classList.contains('on');
    out.confirmTitle = document.getElementById('app-sheet-title').textContent;
    [...document.querySelectorAll('#app-sheet-btns button')].find(b => b.textContent === 'Cancel').click();
    await pending;
    out.cancelKeptNotes = parts[0].notes.length === 1;

    // Confirm: accept.
    const p2 = clearAll();
    await new Promise(r => setTimeout(r, 60));
    [...document.querySelectorAll('#app-sheet-btns button')].find(b => b.textContent === 'Clear all').click();
    await p2;
    out.acceptCleared = parts[0].notes.length === 0;

    // Prompt: type a name and save.
    const before = projects.length;
    const p3 = newProjectPrompt();
    await new Promise(r => setTimeout(r, 60));
    out.promptHasInput = document.getElementById('app-sheet-input').style.display !== 'none';
    document.getElementById('app-sheet-input').value = 'Test song from a sheet';
    [...document.querySelectorAll('#app-sheet-btns button')].find(b => b.textContent === 'Save').click();
    await p3;
    out.named = projects.find(x => x.id === currentProjId)?.name;
    out.added = projects.length === before + 1;

    // Escape dismisses without acting.
    const p4 = deleteProject(currentProjId);
    await new Promise(r => setTimeout(r, 60));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p4;
    out.escapeKept = projects.some(x => x.id === currentProjId);
    out.closed = !document.getElementById('app-sheet').classList.contains('on');
    out.natives = window.__native;
    return out;
  });
  ok('a nudge is a toast, not a modal', /Select a note first/.test(r.toast) && r.noModalForNudge, `toast="${r.toast}"`);
  ok('confirm opens an in-app sheet', r.confirmOpen && /Clear this song/.test(r.confirmTitle), `title="${r.confirmTitle}"`);
  ok('cancelling a confirm changes nothing', r.cancelKeptNotes === true);
  ok('accepting a confirm goes through', r.acceptCleared === true);
  ok('naming a song uses a text field in the sheet', r.promptHasInput && r.added, `added=${r.added}`);
  ok('the typed name is what gets saved', r.named === 'Test song from a sheet', `got "${r.named}"`);
  ok('Escape dismisses without acting', r.escapeKept === true && r.closed === true);
  ok('no native alert/confirm/prompt is reached', r.natives === 0, `${r.natives} native calls`);
  await p.context().close();
});

// ── 18. Sharing and printing (item 20) ───────────────────────────────────
await run('share', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(async () => {
    const out = {};
    parts[0].notes = [{ keys: ['C/4'], dur: 'q', vfAccs: [null], midiVals: [60], rest: false,
      lyric: null, dyn: null, arts: [], tempo: null, rud: null, grace: [], sticking: null }];

    // With a share sheet that takes files, that is the route taken.
    let shared = null;
    navigator.canShare = d => !!(d && d.files);
    navigator.share = async d => { shared = { name: d.files[0].name, size: d.files[0].size, title: d.title }; };
    let downloaded = 0;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) downloaded++; };
    await deliverFile(new Blob(['x'], { type: 'audio/midi' }), 'song.mid', 'Song');
    out.shared = shared; out.downloadsWhenShared = downloaded;

    // A cancelled share must not then force a download.
    navigator.share = async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; };
    const how = await deliverFile(new Blob(['x'], { type: 'audio/midi' }), 'song.mid', 'Song');
    out.cancelled = how; out.downloadsAfterCancel = downloaded;

    // Without a usable share sheet, it falls back to a download.
    navigator.canShare = () => false;
    const how2 = await deliverFile(new Blob(['x'], { type: 'audio/midi' }), 'song.mid', 'Song');
    out.fallback = how2; out.downloadsAfterFallback = downloaded;
    HTMLAnchorElement.prototype.click = realClick;

    // Printing must not reach window.open.
    let opened = 0; const realOpen = window.open;
    window.open = () => { opened++; return null; };
    exportPDF('all');
    await new Promise(r => setTimeout(r, 700));
    window.open = realOpen;
    const f = document.getElementById('print-frame');
    out.windowOpens = opened;
    out.framePrinted = !!f;
    out.frameHasMusic = !!(f && f.contentDocument && f.contentDocument.querySelector('svg'));
    out.frameHidden = !!(f && getComputedStyle(f).opacity === '0');
    return out;
  });
  ok('a file goes to the share sheet when one can take it',
     r.shared && r.shared.name === 'song.mid' && r.downloadsWhenShared === 0,
     `shared=${JSON.stringify(r.shared)} downloads=${r.downloadsWhenShared}`);
  ok('cancelling a share does not force a download',
     r.cancelled === 'cancelled' && r.downloadsAfterCancel === 0, `${r.cancelled}, ${r.downloadsAfterCancel} downloads`);
  ok('without a share sheet it still downloads',
     r.fallback === 'downloaded' && r.downloadsAfterFallback === 1, `${r.fallback}, ${r.downloadsAfterFallback} downloads`);
  ok('printing never opens a pop-up window', r.windowOpens === 0, `${r.windowOpens} window.open calls`);
  ok('printing renders the music into a hidden frame',
     r.framePrinted && r.frameHasMusic && r.frameHidden,
     `frame=${r.framePrinted} music=${r.frameHasMusic} hidden=${r.frameHidden}`);
  await p.context().close();
});

// ── 19. Zoom is remembered (item 21) ─────────────────────────────────────
await run('zoom', async () => {
  const p = await boot(await page());
  await p.evaluate(() => { stepZoom(1); stepZoom(1); });
  const before = await p.evaluate(() => scoreZoom);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  const after = await p.evaluate(() => scoreZoom);
  ok('the staff zoom survives a reload', after === before && after !== 1, `${before} -> ${after}`);
  await p.context().close();
});

// ── 20. The split files still add up to one working app (item 18) ────────
await run('split', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(path.join(HERE, '..', 'index.html'), 'utf8');
  // Every function named by an on*="..." attribute in the markup. These resolve
  // from global scope at click time, so a name lost or reordered in the split
  // fails silently on a button nobody presses until it matters.
  const names = new Set();
  for (const m of html.matchAll(/\bon(?:click|change|input|submit)="([^"]+)"/g)) {
    for (const f of m[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) names.add(f[1]);
  }
  const known = new Set(['location', 'event', 'alert', 'confirm', 'prompt', 'reload']);
  const wanted = [...names].filter(n => !known.has(n));

  const p = await boot(await page());
  const r = await p.evaluate(list => {
    const missing = list.filter(n => {
      try { return typeof eval(n) !== 'function'; } catch (e) { return true; }
    });
    return { missing, checked: list.length };
  }, wanted);
  ok(`all ${r.checked} inline handlers resolve to a function`, r.missing.length === 0,
     r.missing.length ? 'missing: ' + r.missing.join(', ') : '');

  // The service worker has to precache every script the page loads, or the app
  // opens offline with half of itself.
  const sw = await fs.readFile(path.join(HERE, '..', 'sw.js'), 'utf8');
  const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  const unprecached = srcs.filter(s => !sw.includes(s));
  ok(`all ${srcs.length} scripts are precached for offline`, unprecached.length === 0,
     unprecached.length ? 'missing from sw.js: ' + unprecached.join(', ') : '');
  await p.context().close();
});

// ── 21. Per-part volume and mute ─────────────────────────────────────────
await run('mixer', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(async () => {
    const out = {};
    parts.length = 0; pid = 1;
    parts.push(mkPart('A', 'piano', 'treble'));
    parts.push(mkPart('B', 'piano', 'bass'));
    parts.push(mkPart('C', 'flute', 'treble'));
    apIdx = 0; soloParts = new Set();
    renderPartsList();

    // Bb trumpet, Eb alto, F horn, Bb tenor, double bass, xylophone.
    out.labels = [0, 2, 9, 7, 14, 12, -12].map(transposeLabel);
    out.defaults = parts.map(x => [x.volume, x.muted]);
    out.faders = document.querySelectorAll('#parts-list .pvol-slider').length;

    // A fader moves only its own part.
    setPartVolume(1, 40);
    out.afterSet = parts.map(x => x.volume);
    out.gain = [partGain(0), partGain(1)].map(g => +g.toFixed(3));

    // Mute silences without touching the notes.
    parts[2].notes = [{ keys: ['C/4'], dur: 'q', vfAccs: [null], midiVals: [60], rest: false,
      lyric: null, dyn: null, arts: [], tempo: null, rud: null, grace: [], sticking: null }];
    toggleMute(2);
    out.mutedFlags = parts.map(x => !!x.muted);
    out.muted = [0, 1, 2].map(partMuted);
    out.notesKept = parts[2].notes.length;

    // Volume 0 counts as muted for playback purposes.
    setPartVolume(0, 0);
    out.zeroIsMuted = partMuted(0);
    setPartVolume(0, 100);

    // Solo overrides mute, and is keyed by part id, not index.
    toggleSolo(2);
    out.soloed = [0, 1, 2].map(partMuted);
    toggleSolo(2);

    // Deleting a part must not slide the mute onto its neighbour — the bug
    // the index-keyed Set had.
    parts[0].muted = true; parts[1].muted = false; parts[2].muted = false;
    deletePart(0);
    out.afterDelete = parts.map(x => [x.name, !!x.muted]);

    // The mix is saved with the song.
    parts[0].muted = true; setPartVolume(1, 25);
    writeCurrentProject();
    await new Promise(r => setTimeout(r, 200));
    const saved = idbUsable
      ? (await idbGetAll() || []).find(x => x.id === currentProjId)
      : JSON.parse(localStorage.getItem('mn_projects') || '[]').find(x => x.id === currentProjId);
    out.persisted = saved ? saved.data.parts.map(x => [x.muted, x.volume]) : null;
    return out;
  });
  ok('an instrument is named for the pitch it sounds, not its inversion',
     JSON.stringify(r.labels) === JSON.stringify(['C (concert)','B\u266d','E\u266d','F','B\u266d (8vb)','C (8vb)','C (8va)']),
     JSON.stringify(r.labels));
  ok('new parts start at full volume, unmuted',
     JSON.stringify(r.defaults) === '[[100,false],[100,false],[100,false]]', JSON.stringify(r.defaults));
  ok('every part row gets its own fader', r.faders === 3, `${r.faders} faders`);
  ok('a fader moves only its own part', JSON.stringify(r.afterSet) === '[100,40,100]', JSON.stringify(r.afterSet));
  ok('the fader curve is not linear gain', r.gain[0] === 1 && r.gain[1] < 0.4 && r.gain[1] > 0.1, JSON.stringify(r.gain));
  ok('mute silences the part but keeps its notes',
     r.muted[2] === true && r.muted[0] === false && r.notesKept === 1,
     `muted=${JSON.stringify(r.muted)} notes=${r.notesKept}`);
  ok('a volume of zero counts as silent', r.zeroIsMuted === true);
  ok('solo overrides mute', JSON.stringify(r.soloed) === '[true,true,false]', JSON.stringify(r.soloed));
  ok('deleting a part does not move the mute onto its neighbour',
     JSON.stringify(r.afterDelete) === '[["B",false],["C",false]]', JSON.stringify(r.afterDelete));
  ok('the mix is saved with the song',
     r.persisted && r.persisted[0][0] === true && r.persisted[1][1] === 25, JSON.stringify(r.persisted));
  await p.context().close();
});

// ── 22. The mix reaches the audio and the exported file ──────────────────
await run('mixer-audio', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(async () => {
    const q = () => ({ keys: ['C/4'], dur: 'q', vfAccs: [null], midiVals: [60], rest: false,
      lyric: null, dyn: null, arts: [], tempo: null, rud: null, grace: [], sticking: null });
    parts.length = 0; pid = 1;
    parts.push(mkPart('Loud', 'flute', 'treble'));
    parts.push(mkPart('Quiet', 'flute', 'treble'));
    parts.push(mkPart('Muted', 'flute', 'treble'));
    parts.forEach(x => { x.notes = [q(), q(), q(), q()]; });
    apIdx = 0; soloParts = new Set();
    setPartVolume(1, 50); parts[2].muted = true;
    repeatStartMeasures = []; repeatEndMeasures = [];
    keyChanges = {}; sigChanges = {}; pickupBeats = 0;

    // Capture what actually reaches a voice, rather than any intermediate:
    // stand a recording voice in for the sampler and let the transport run.
    const hits = [];
    const realSampler = window.getSampler;
    window.getSampler = () => ({
      triggerAttackRelease: (n, d, t, v) => { hits.push(+v.toFixed(3)); },
      releaseAll: () => {},
    });
    document.getElementById('bpm-inp').value = 400;   // 4 quarters ≈ 0.6s
    await playScore();
    await new Promise(r => setTimeout(r, 1400));
    stopScore();
    window.getSampler = realSampler;
    const seen = hits;

    // And what the exported file carries.
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = b => { captured = b; return 'blob:stub'; };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    exportMIDI();
    URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick;
    const bytes = Array.from(new Uint8Array(await captured.arrayBuffer()));
    return { seen, bytes };
  });
  // Two unmuted parts of 4 notes each — the muted third contributes nothing.
  const levels = [...new Set(r.seen)].sort((a, b) => b - a);
  ok('a muted part never reaches the audio', r.seen.length === 8,
     `${r.seen.length} notes sounded, expected 8 (two parts of four)`);
  ok('a quieter part sounds at a lower level',
     levels.length === 2 && levels[1] < levels[0] * 0.6,
     `levels heard: ${JSON.stringify(levels)}`);
  // CC 7 (channel volume) events in the exported file.
  const u8 = Uint8Array.from(r.bytes);
  const cc7 = [];
  for (let i = 0; i < u8.length - 2; i++) {
    if ((u8[i] & 0xf0) === 0xb0 && u8[i + 1] === 7) cc7.push(u8[i + 2]);
  }
  ok('the exported file carries the mix as channel volume',
     cc7.length === 3 && cc7[0] === 127 && cc7[1] === 64, `CC7 values: ${JSON.stringify(cc7)}`);
  ok('a muted part is still exported, not dropped', cc7.length === 3, `${cc7.length} parts in the file`);
  await p.context().close();
});

// ── 22. The instrument picker ────────────────────────────────────────────
await run('picker', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(async () => {
    switchTab('parts');
    // Every family opened, so the whole catalogue is on the page at once.
    openFamilies = new Set(CATS); instQuery = ''; pickedInsts.clear();
    buildInstrumentPicker();
    const listed = [...document.querySelectorAll('.iname')].map(e => e.textContent);

    // Search by a word that is not in the label.
    searchInstruments('chiptune');
    const byAlias = [...document.querySelectorAll('.iname')].map(e => e.textContent);
    searchInstruments('nothinghere');
    const empty = document.querySelectorAll('.irow').length;
    searchInstruments('');

    // Tick three from two different families, then add them in one pass.
    parts.length = 0; pid = 1; parts.push(mkPart('Piano', 'piano', 'treble')); apIdx = 0;
    pickedInsts.clear();
    ['ukulele', 'guitar', 'musicbox'].forEach(toggleInstPick);
    const footer = document.getElementById('inst-count').textContent;
    confirmAddPart();
    const added = parts.map(x => `${x.instId}:${x.clef}:${x.transpose}`);

    // Preview has to survive every instrument shape — sampled, synth-only,
    // unpitched, pitched drum and the drum set all take different paths.
    let threw = null;
    for (const inst of INSTRUMENTS) {
      try { await previewInstrument(inst.id); } catch (e) { threw = inst.id + ': ' + e.message; break; }
    }

    // Preview voices are the same cached objects playback uses, so previewing
    // mid-playback would release a note the transport is still holding.
    let sounded = 0;
    const spy = Tone.PolySynth.prototype.triggerAttackRelease;
    Tone.PolySynth.prototype.triggerAttackRelease = function (...a) { sounded++; try { return spy.apply(this, a); } catch (e) { return this; } };
    playing = true;
    await previewInstrument('musicbox');
    const duringPlayback = sounded;
    playing = false;
    await previewInstrument('musicbox');
    const whenIdle = sounded - duringPlayback;
    Tone.PolySynth.prototype.triggerAttackRelease = spy;

    // getSampler()'s fallback for an unmapped instrument is the piano sample
    // set, so a synthesised instrument that reached it would sound like a
    // piano — and share one cached voice with every other one.
    const synthy = INSTRUMENTS.filter(i => i.synthOnly).map(i => i.id);
    const voices = synthy.map(id => getSampler(id));
    const pianoish = synthy.filter((id, i) => voices[i].sampleKey !== undefined);
    const shared = new Set(voices).size !== voices.length;

    return {
      listed, byAlias, empty, footer, added, threw, duringPlayback, whenIdle,
      synthy: synthy.length, pianoish, shared,
      total: INSTRUMENTS.length,
      // An instrument whose cat is a typo would render in no family at all.
      orphans: INSTRUMENTS.filter(i => !CATS.includes(i.cat)).map(i => i.id),
      picked: pickedInsts.size,
      expanded: document.querySelector('.ifam-head')?.getAttribute('aria-expanded'),
      labelled: [...document.querySelectorAll('.ipreview, .iadd')].every(b => b.getAttribute('aria-label')),
    };
  });
  ok('every instrument is reachable in a family', r.listed.length === r.total && r.orphans.length === 0,
     `${r.listed.length} of ${r.total} listed, orphans: ${JSON.stringify(r.orphans)}`);
  ok('search matches words that are not in the label', r.byAlias.length === 1 && r.byAlias[0] === 'Retro Game',
     JSON.stringify(r.byAlias));
  ok('a search with no match lists nothing', r.empty === 0, `${r.empty} rows`);
  ok('the footer counts what is ticked', r.footer === '3 selected', `"${r.footer}"`);
  ok('one Add adds every ticked instrument, in catalogue order',
     r.added.length === 4 && r.added[1] === 'guitar:treble:12' && r.added[2] === 'ukulele:treble:0'
     && r.added[3] === 'musicbox:treble:0', JSON.stringify(r.added));
  ok('adding clears the selection for the next pass', r.picked === 0, `${r.picked} still ticked`);
  ok('preview handles every instrument shape without throwing', r.threw === null, r.threw || '');
  ok('a synthesised instrument never falls back to the piano sample set',
     r.synthy > 0 && r.pianoish.length === 0 && r.shared === false,
     `${r.synthy} synth-only, on the sample path: ${JSON.stringify(r.pianoish)}, sharing a voice: ${r.shared}`);
  ok('preview stays silent during playback, and sounds when idle',
     r.duringPlayback === 0 && r.whenIdle > 0,
     `playing=${r.duringPlayback} idle=${r.whenIdle}`);
  ok('families say whether they are open, and the buttons are named',
     r.expanded === 'true' && r.labelled === true, `expanded=${r.expanded} labelled=${r.labelled}`);
  await p.context().close();
});

// ── 23. Notehead colour and letters ──────────────────────────────────────
await run('notecolor', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(async () => {
    parts.length = 0; pid = 1; parts.push(mkPart('Scale', 'piano', 'treble')); apIdx = 0;
    setKey('C'); setTimeSig('4/4'); keyChanges = {}; sigChanges = {}; pickupBeats = 0;
    parts[0].notes = [60, 62, 64, 65, 67, 69, 71].map(m => { const sp = spellConcert(m);
      return { keys: [sp.name + '/' + sp.oct], dur: 'q', vfAccs: [sp.vfAcc], midiVals: [m], rest: false,
        lyric: null, dyn: null, arts: [], tempo: null, rud: null, grace: [], sticking: null }; });
    selectedNote = null; caretGap = null;

    const heads = () => [...document.querySelectorAll('#score-div svg g.vf-notehead')]
      .map(e => e.getAttribute('fill')).filter(Boolean);

    setNoteColorMode('off'); await new Promise(r => setTimeout(r, 250));
    const offHeads = heads();

    setNoteColorMode('boom'); await new Promise(r => setTimeout(r, 250));
    const boomHeads = heads();

    // Degree colouring has to move with the key; Boomwhackers must not.
    keyChanges[0] = 'G';
    const degreeTonicInG = (setNoteColorMode('degree'), noteheadColor('G/4', 0));
    const degreeTonicInC = (keyChanges = {}, noteheadColor('C/4', 0));
    setNoteColorMode('boom');
    const boomGwhateverKey = [noteheadColor('G/4', 0), (keyChanges[0] = 'G', noteheadColor('G/4', 0))];
    keyChanges = {};

    // A selected note keeps the selection colour rather than its pitch colour,
    // or "which note am I editing" stops being answerable.
    setNoteColorMode('boom');
    selectedNote = { partIdx: 0, noteIdx: 0 }; render(); updateSelectionUI();
    await new Promise(r => setTimeout(r, 250));
    const withSelection = heads();
    selectedNote = null;

    // Letters: drawn through the same context, so print gets them too.
    noteLetters = true; setNoteColorMode('boom'); render();
    await new Promise(r => setTimeout(r, 250));
    const texts = [...document.querySelectorAll('#score-div svg text')]
      .filter(t => /^[A-G]$/.test(t.textContent.trim()));
    const letters = texts.map(t => t.textContent.trim());
    const inks = texts.map(t => t.getAttribute('fill'));
    // Every letter must sit on its own notehead, not beside it.
    const headBoxes = [...document.querySelectorAll('#score-div svg g.vf-notehead')].map(h => h.getBBox());
    const offCentre = texts.map((t, i) => {
      const b = headBoxes[i]; if (!b) return 99;
      return Math.max(Math.abs(+t.getAttribute('x') - (b.x + b.width / 2)),
                      Math.abs(+t.getAttribute('y') - (b.y + b.height / 2)));
    });

    noteLetters = false; setNoteColorMode('off'); render();
    return {
      offHeads, boomHeads, degreeTonicInG, degreeTonicInC, boomGwhateverKey,
      withSelection, letters, inks, offCentre,
      expectBoom: [0, 2, 4, 5, 7, 9, 11].map(pc => BOOMWHACKER[pc]),
      red: DEGREE_COLORS[0], selBlue: '#2980b9',
      inkOnYellow: readableInk(BOOMWHACKER[4]), inkOnPurple: readableInk(BOOMWHACKER[9]),
    };
  });
  ok('with colour off the noteheads carry no fill of their own', r.offHeads.length === 0,
     JSON.stringify(r.offHeads));
  ok('Boomwhackers paints each pitch its tube colour',
     JSON.stringify(r.boomHeads) === JSON.stringify(r.expectBoom),
     `${JSON.stringify(r.boomHeads)} vs ${JSON.stringify(r.expectBoom)}`);
  ok('scale degree puts red on the tonic, whichever key that is',
     r.degreeTonicInG === r.red && r.degreeTonicInC === r.red,
     `G-in-G=${r.degreeTonicInG} C-in-C=${r.degreeTonicInC} red=${r.red}`);
  ok('Boomwhackers ignores the key, which is the difference between the two',
     r.boomGwhateverKey[0] === r.boomGwhateverKey[1], JSON.stringify(r.boomGwhateverKey));
  ok('the selected note stays the selection colour, not its pitch colour',
     r.withSelection[0] === undefined || r.withSelection[0] !== r.expectBoom[0],
     `first head=${r.withSelection[0]}`);
  ok('every notehead gets its letter', JSON.stringify(r.letters) === JSON.stringify(['C','D','E','F','G','A','B']),
     JSON.stringify(r.letters));
  ok('each letter is centred on its own notehead', r.offCentre.every(d => d < 1.5),
     `worst offset ${Math.max(...r.offCentre).toFixed(2)}px`);
  ok('the letter ink is chosen for contrast, not fixed',
     r.inkOnYellow === '#000' && r.inkOnPurple === '#fff',
     `yellow->${r.inkOnYellow} purple->${r.inkOnPurple}`);
  await p.context().close();
});

// ── 24. Inserting and removing whole measures ────────────────────────────
await run('measures', async () => {
  const p = await boot(await page());
  const r = await p.evaluate(() => {
    const mk = (m, dur) => { const sp = spellConcert(m);
      return { keys: [sp.name + '/' + sp.oct], dur, vfAccs: [sp.vfAcc], midiVals: [m], rest: false,
        lyric: null, dyn: null, arts: [], tempo: null, rud: null, grace: [], sticking: null }; };
    const reset = (a, b) => { parts.length = 0; pid = 1;
      parts.push(mkPart('A', 'piano', 'treble')); parts.push(mkPart('B', 'piano', 'bass'));
      apIdx = 0; setKey('C'); setTimeSig('4/4'); keyChanges = {}; sigChanges = {}; pickupBeats = 0;
      repeatStartMeasures = []; repeatEndMeasures = []; selectedNote = null; caretGap = null;
      parts[0].notes = [...Array(a)].map((_, i) => mk(60 + (i % 12), 'q'));
      parts[1].notes = [...Array(b)].map((_, i) => mk(48 + (i % 12), 'q'));
      render(); };
    const barsOf = () => parts.map(x => toMeasures(x.notes).length);
    const out = {};

    // Everything keyed by measure has to travel with the music.
    reset(16, 16);
    keyChanges[2] = 'G'; sigChanges[3] = '3/4';
    repeatStartMeasures = [1]; repeatEndMeasures = [3];
    parts[0].hairpins = [{ type: 'cresc', start: 8, end: 11 }];
    render();
    insertMeasureAt(1);
    out.marks = { key: { ...keyChanges }, sig: { ...sigChanges },
      rs: [...repeatStartMeasures], re: [...repeatEndMeasures],
      hp: parts[0].hairpins.map(h => [h.start, h.end]),
      newBarSilent: toMeasures(parts[0].notes)[1].every(n => n.rest),
      newBarBeats: toMeasures(parts[0].notes)[1].reduce((s, n) => s + noteBeats(n), 0),
      bothParts: parts.map(x => x.notes.length) };
    // Undo has to restore the markings too, not just the notes.
    undo();
    out.undone = { key: { ...keyChanges }, rs: [...repeatStartMeasures],
      notes: parts[0].notes.length, hp: parts[0].hairpins.map(h => [h.start, h.end]) };
    redo();
    removeMeasureAt(1);
    out.removed = { key: { ...keyChanges }, sig: { ...sigChanges },
      rs: [...repeatStartMeasures], re: [...repeatEndMeasures],
      hp: parts[0].hairpins.map(h => [h.start, h.end]),
      notes: parts.map(x => x.notes.length) };

    // A part whose music stops before the new barline must not collect rests.
    reset(16, 8);
    insertMeasureAt(3);
    out.uneven = { bars: barsOf(), notes: parts.map(x => x.notes.length) };

    // Appending grows every part, so they stay the same length.
    reset(16, 8);
    insertMeasureAt(measureCount());
    out.append = { notes: parts.map(x => x.notes.length) };

    // The new bar takes the metre in force there, not the song's opening one.
    reset(16, 16); sigChanges[1] = '3/4'; render();
    insertMeasureAt(2);
    out.metre = toMeasures(parts[0].notes)[2].reduce((s, n) => s + noteBeats(n), 0);

    // And the pickup's short bar 0 stays short.
    reset(16, 16); pickupBeats = 1; render();
    insertMeasureAt(0);
    out.pickup = toMeasures(parts[0].notes)[0].reduce((s, n) => s + noteBeats(n), 0);

    // A note sounding across the barline is refused, with the part named.
    reset(8, 8);
    parts[0].notes = [mk(60, 'q'), mk(62, 'q'), mk(64, 'q'), mk(65, 'h'), mk(67, 'q')];
    parts[0].name = 'Violin'; render();
    document.getElementById('toast-host').innerHTML = '';
    const n = parts[0].notes.length;
    insertMeasureAt(1);
    out.unclean = { refused: parts[0].notes.length === n,
      msg: (document.querySelector('#toast-host .toast') || {}).textContent || '' };

    // The last remaining bar cannot be removed out from under the song.
    reset(4, 4);
    const n2 = parts[0].notes.length;
    removeMeasureAt(0);
    out.lastBar = parts[0].notes.length === n2;
    return out;
  });
  ok('an inserted bar pushes key and metre changes along with the music',
     r.marks.key['3'] === 'G' && r.marks.sig['4'] === '3/4', JSON.stringify([r.marks.key, r.marks.sig]));
  ok('repeat barlines move too', JSON.stringify(r.marks.rs) === '[2]' && JSON.stringify(r.marks.re) === '[4]',
     `${JSON.stringify(r.marks.rs)} ${JSON.stringify(r.marks.re)}`);
  ok('hairpins follow their own part’s note indices', JSON.stringify(r.marks.hp) === '[[9,12]]',
     JSON.stringify(r.marks.hp));
  ok('the new bar is silent and exactly one bar long',
     r.marks.newBarSilent && Math.abs(r.marks.newBarBeats - 4) < 1e-6,
     `silent=${r.marks.newBarSilent} beats=${r.marks.newBarBeats}`);
  ok('every part gets the bar, so the staves stay in step',
     JSON.stringify(r.marks.bothParts) === '[17,17]', JSON.stringify(r.marks.bothParts));
  ok('undo restores the markings, not just the notes',
     r.undone.key['2'] === 'G' && JSON.stringify(r.undone.rs) === '[1]' && r.undone.notes === 16
     && JSON.stringify(r.undone.hp) === '[[8,11]]', JSON.stringify(r.undone));
  ok('removing a bar puts everything back where it was',
     r.removed.key['2'] === 'G' && r.removed.sig['3'] === '3/4'
     && JSON.stringify(r.removed.rs) === '[1]' && JSON.stringify(r.removed.hp) === '[[8,11]]'
     && JSON.stringify(r.removed.notes) === '[16,16]', JSON.stringify(r.removed));
  ok('a part whose music ends earlier collects no stray rests',
     JSON.stringify(r.uneven.bars) === '[5,2]' && JSON.stringify(r.uneven.notes) === '[17,8]',
     `${JSON.stringify(r.uneven.bars)} ${JSON.stringify(r.uneven.notes)}`);
  ok('appending past the end grows every part', JSON.stringify(r.append.notes) === '[17,9]',
     JSON.stringify(r.append.notes));
  ok('the new bar takes the metre in force at that point, not the opening one',
     Math.abs(r.metre - 3) < 1e-6, `${r.metre} beats`);
  ok('inserting at a pickup keeps the short bar short', Math.abs(r.pickup - 1) < 1e-6, `${r.pickup} beats`);
  ok('a note held across the barline is refused, and says which part',
     r.unclean.refused && /Violin/.test(r.unclean.msg) && /Bar 2/.test(r.unclean.msg),
     `refused=${r.unclean.refused} "${r.unclean.msg}"`);
  ok('the last remaining bar cannot be removed', r.lastBar === true);
  await p.context().close();
});

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
