/* mod-suite.js — how the mõd apps hand work to each other. v1.
 *
 * The canonical copy lives in modriff-site/suite/mod-suite.js; each app carries an identical
 * copy (mõdScore js/suite.js, Music Playground js/suite.js; mõdRïff inlines the send half).
 * Change it here, then copy it. SUITE.md describes the format.
 *
 * A handoff travels in the URL fragment of the receiving app:
 *   https://modriff.com/score/#mod=1&kind=midi&from=playground&title=My%20tune&data=<base64url>
 * The fragment never reaches a server, so a song stays on the device, and the link works
 * from anywhere — the iPhone app included, which can't see the browser's storage. Sending is
 * synchronous on purpose: Safari blocks a new tab opened after an await.
 *
 * kinds: "midi" (data = .mid bytes), "musicxml" (data = UTF-8 MusicXML text).
 */
(function (root) {
  'use strict';
  var VERSION = '1';
  var APPS = { play: 'mõdRïff', score: 'mõdScore', playground: 'Music Playground' };
  // Fragments beyond a couple of megabytes are cut by some browsers; refuse well before that.
  var MAX_URL = 1500000;

  function b64url(u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function utf8(s) { return new TextEncoder().encode(s); }

  // Where the apps live. Same origin when we are already on modriff.com (or a test server
  // that sets window.MOD_SUITE_BASE); otherwise the public site.
  function base() {
    if (root.MOD_SUITE_BASE) return root.MOD_SUITE_BASE;
    try { if (root.location && /(^|\.)modriff\.com$/.test(root.location.hostname)) return root.location.origin + '/'; } catch (e) {}
    return 'https://modriff.com/';
  }

  function url(target, item) {
    if (!APPS[target]) throw new Error('unknown mõd app: ' + target);
    var bytes = item.data instanceof Uint8Array ? item.data : utf8(String(item.data));
    var q = new URLSearchParams();
    q.set('mod', VERSION);
    q.set('kind', item.kind);
    if (item.from) q.set('from', item.from);
    if (item.title) q.set('title', String(item.title).slice(0, 120));
    q.set('data', b64url(bytes));
    var u = base() + target + '/#' + q.toString();
    if (u.length > MAX_URL) throw new Error('too big to hand over by link');
    return u;
  }

  // Opens the target app in a new tab with the item. Call it straight from a click handler.
  function send(target, item) {
    var u = url(target, item);
    var a = document.createElement('a');
    a.href = u; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    return u;
  }

  // Reads a handoff from this page's fragment, once: the fragment is cleared so a reload or
  // a bookmark doesn't import it again. Returns null when there is nothing (or nothing valid).
  function receive() {
    var h = (root.location && root.location.hash) || '';
    if (h.indexOf('mod=') < 0) return null;
    var q = new URLSearchParams(h.slice(1));
    if (q.get('mod') !== VERSION || !q.get('data')) return null;
    // root.history, not history: an app may have a global of its own by that name (mõdScore's
    // undo history is one), and the bare name would find that instead.
    try { root.history.replaceState(null, '', root.location.pathname + root.location.search); } catch (e) {}
    try {
      var data = unb64url(q.get('data'));
      var kind = q.get('kind');
      return {
        kind: kind, from: q.get('from') || '', fromName: APPS[q.get('from')] || '',
        title: q.get('title') || '',
        data: kind === 'musicxml' ? new TextDecoder().decode(data) : data
      };
    } catch (e) { return null; }
  }

  // A minimal Standard MIDI File (format 1, one track) from notes:
  //   notes: [{ midi, start, dur, vel? }] with start/dur in quarter notes.
  //   opts:  { bpm, title, num, den, program }
  function midi(notes, opts) {
    opts = opts || {};
    var TPQ = 480, ev = [];
    notes.forEach(function (n) {
      var on = Math.round(n.start * TPQ), off = Math.round((n.start + n.dur) * TPQ);
      ev.push({ t: on, b: [0x90, n.midi & 127, (n.vel || 90) & 127] });
      ev.push({ t: off, b: [0x80, n.midi & 127, 0] });
    });
    // Note-offs before note-ons at the same tick, so repeated pitches don't cut each other.
    ev.sort(function (a, b) { return a.t - b.t || (a.b[0] - b.b[0]); });
    function vlq(n) { var out = [n & 127]; while ((n >>= 7)) out.unshift((n & 127) | 128); return out; }
    var trk = [];
    function meta(type, bytes) { trk.push(0, 0xff, type); trk.push.apply(trk, vlq(bytes.length)); trk.push.apply(trk, bytes); }
    if (opts.title) meta(0x03, Array.from(utf8(opts.title)));
    var tempo = Math.round(60000000 / (opts.bpm || 120));
    meta(0x51, [(tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255]);
    meta(0x58, [opts.num || 4, Math.round(Math.log2(opts.den || 4)), 24, 8]);
    trk.push(0, 0xc0, (opts.program || 0) & 127);
    var last = 0;
    ev.forEach(function (e) { trk.push.apply(trk, vlq(e.t - last)); trk.push.apply(trk, e.b); last = e.t; });
    trk.push(0, 0xff, 0x2f, 0);
    var len = trk.length;
    var head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, (TPQ >> 8) & 255, TPQ & 255,
                0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255];
    return new Uint8Array(head.concat(trk));
  }

  // "C4" / "F#3" / "Bb5" -> MIDI number (C4 = 60).
  function noteNumber(name) {
    var m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name);
    if (!m) return null;
    var pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
    return pc + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (parseInt(m[3], 10) + 1) * 12;
  }

  root.ModSuite = { version: VERSION, apps: APPS, url: url, send: send, receive: receive, midi: midi, noteNumber: noteNumber };
})(typeof window !== 'undefined' ? window : this);
