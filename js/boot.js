// ═══════════════════════════════════════════════════════════════════════
// MōdScore — Keyboard entry, the guided tour, and starting the app
// ═══════════════════════════════════════════════════════════════════════
// Part of a single shared script, split across files so a change to one
// concern is not a change inside a five-thousand-line file. These load as
// ordinary scripts, in the order index.html lists them, and share one global
// scope exactly as they did when they were one block — see js/README.md for
// why it is not ES modules.

// ═══════════════════════════════════════════════════════
// Computer-keyboard entry (Sibelius-style, for laptop/desktop use)
// ═══════════════════════════════════════════════════════
// A–G enter pitches, number keys pick note lengths, and the usual editing keys
// (arrows, backspace, dot, rest, undo/redo, space=play) all work — while never
// hijacking real text fields (lyrics, BPM, song name) or the guided tour.
const KEY_DUR={'1':'w','2':'h','3':'q','4':'8','5':'16','6':'32'};
document.addEventListener('keydown', e=>{
  const t=e.target;
  if(t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
  if(typeof tourActive!=='undefined' && tourActive) return;
  // A dialog is in front; its own handler owns Enter and Escape, and a letter
  // key must not quietly write a note onto the staff behind it.
  if(document.getElementById('app-sheet')?.classList.contains('on')) return;

  const k=e.key, mod=e.ctrlKey||e.metaKey;

  if(mod && (k==='z'||k==='Z')){ e.preventDefault(); e.shiftKey?redo():undo(); return; }
  if(mod && (k==='y'||k==='Y')){ e.preventDefault(); redo(); return; }
  if(mod) return; // leave native Ctrl/Cmd shortcuts (copy, save, reload…) alone

  if(/^[a-gA-G]$/.test(k)){ e.preventDefault(); enterLetterKey(k.toUpperCase()); return; }
  if(KEY_DUR[k]){ e.preventDefault(); setDur(KEY_DUR[k]); return; }
  if(k==='r'||k==='R'||k==='0'){ e.preventDefault(); addRest(); return; }
  if(k==='.'){ e.preventDefault(); toggleDot(); return; }
  if(k==='t'||k==='T'){ e.preventDefault(); toggleTuplet(); return; }
  if(k==='Backspace'||k==='Delete'){ e.preventDefault(); selectedNote?removeSelected():deleteLastNote(); return; }
  if(k===' '){ e.preventDefault(); playing?stopScore():playScore(); return; }
  if(k==='ArrowUp'){ e.preventDefault(); if(selectedNote) moveSelNote(e.shiftKey?12:1); return; }
  if(k==='ArrowDown'){ e.preventDefault(); if(selectedNote) moveSelNote(e.shiftKey?-12:-1); return; }
  if(k==='ArrowRight'){ e.preventDefault(); moveSelection(1); return; }
  if(k==='ArrowLeft'){ e.preventDefault(); moveSelection(-1); return; }
});

// ═══════════════════════════════════════════════════════
// Guided tour (hybrid walkthrough + spotlight on the real controls)
// ═══════════════════════════════════════════════════════
const TOUR=[
  {title:'Welcome to MōdScore 🎵', text:'A quick tour of everything the app can do. Tap Next to step through — or Skip anytime. You can reopen this later with the “?” button.'},
  {tab:'notes', sel:'#note-grid', title:'Write notes', text:'Tap a letter (C–B) to add that note. Each one lands in the octave closest to the note before it, so melodies flow naturally. The last button adds a rest.'},
  {tab:'notes', sel:'#score-wrap', title:'The cursor', text:'Tap a note on the staff to select it (it turns blue). New notes insert right after it — so you can add music in the middle, not just the end. Tap an empty spot to drop the blue cursor where the next note will go.'},
  {tab:'notes', sel:'#quick-edit-bar', title:'Change or delete a note', text:'Select a note and this bar appears above the staff with everything for it: lengths, ↑½ ↓½ and ♯ ♭ ♮ for pitch, ↑8va ↓8va for octaves, ⇢Rest to turn it into a rest, and 🗑 to delete it.'},
  {tab:'notes', sel:'#dur-row', title:'Note length & octave', text:'Pick whole, half, quarter, 8th, 16th, 32nd — and the dot for dotted rhythms. With a note selected, tapping a length changes that note. “Nudge” shifts a note up or down an octave.'},
  {tab:'notes', sel:'#acc-row', title:'Sharps & flats', text:'“Key” follows the key signature automatically; ♯ ♭ ♮ force an accidental on the notes you enter.'},
  {tab:'markings', sel:'#panel-markings', title:'Markings', text:'Lyrics, dynamics (p, f, cresc.), articulations (accent, staccato), tempo words, and drumline rudiments (rolls, flams, stickings). They apply to a selected note, or attach to your next note.'},
  {tab:'parts', sel:'#panel-parts', title:'Instruments & parts', text:'Each staff is a part — tap one to make it active for writing. Add instruments: strings, brass, voices, and percussion including single-line snare/bass drum, 5-line marching tenors & basses, and a 5-line drum set.'},
  {tab:'score', sel:'#panel-score', title:'Key, time & repeats', text:'Set the key and time signature, and add repeats — repeat barlines and “repeat previous measure” (%) symbols that actually play back.'},
  {tab:'notes', sel:'#chord-palette', title:'Chords', text:'Tap a chord to drop the whole thing in at once. “7th” adds the seventh; “Build” lets you stack a custom chord note by note.'},
  {tab:'notes', sel:'#copy-toggle-btn', title:'Copy & paste', text:'Tap the scissors, then tap the first and last note of a range, Copy, switch to another part, and Paste — it replaces the music at the paste point. Great for repeating sections across staves.'},
  {sel:'.tb.play', title:'Play it back', text:'Play and stop your song here. The staff scrolls to follow along as it plays.'},
  {sel:'#collapse-btn', title:'More room', text:'Collapse the controls to give the music most of the screen — especially handy in landscape. Tap again to bring them back.'},
  {tab:'proj', sel:'#panel-proj', title:'Songs, import & print', text:'Your songs auto-save here. Import MIDI or MusicXML, and print or export a PDF — the full score or one part at a time.'},
  {sel:'#help-btn', title:'That’s it! 🎉', text:'Tap “?” anytime to see this tour again. Now go make some music.'}
];
let tourIdx=0, tourActive=false;
function startTour(){
  tourActive=true; tourIdx=0;
  document.body.classList.remove('controls-collapsed');
  document.getElementById('collapse-btn').textContent='▼';
  if(parts[apIdx]&&parts[apIdx].notes.length){ selectedNote={partIdx:apIdx,noteIdx:0}; caretGap=null; render(); updateSelectionUI(); }
  buildTourDom();
  tourStep(0);
  safeStore.set('mn_tutorial_seen','1');
}
function buildTourDom(){
  if(document.getElementById('tour-overlay'))return;
  const ov=document.createElement('div'); ov.id='tour-overlay';
  ov.innerHTML='<div id="tour-hole"></div><div id="tour-card">'
    +'<div id="tour-title"></div><div id="tour-text"></div><div id="tour-dots"></div>'
    +'<div id="tour-btns"><button id="tour-skip">Skip</button><span style="flex:1"></span><button id="tour-back">Back</button><button id="tour-next">Next ›</button></div>'
    +'</div>';
  document.body.appendChild(ov);
  document.getElementById('tour-skip').onclick=endTour;
  document.getElementById('tour-back').onclick=()=>{ if(tourIdx>0) tourStep(tourIdx-1); };
  document.getElementById('tour-next').onclick=()=>{ if(tourIdx<TOUR.length-1) tourStep(tourIdx+1); else endTour(); };
  window.addEventListener('resize', tourReposition);
}
function tourStep(i){
  tourIdx=i; const step=TOUR[i];
  if(step.tab) switchTab(step.tab);
  requestAnimationFrame(()=>positionTour(step,i));
}
function positionTour(step,i){
  document.getElementById('tour-title').textContent=step.title;
  document.getElementById('tour-text').textContent=step.text;
  document.getElementById('tour-dots').innerHTML=TOUR.map((_,k)=>'<span style="width:6px;height:6px;border-radius:50%;display:inline-block;margin:0 3px;background:'+(k===i?'var(--accent)':'var(--muted2)')+'"></span>').join('');
  document.getElementById('tour-back').style.visibility=(i===0)?'hidden':'visible';
  document.getElementById('tour-next').textContent=(i===TOUR.length-1)?'Done ✓':'Next ›';
  const hole=document.getElementById('tour-hole'), card=document.getElementById('tour-card');
  const el=step.sel?document.querySelector(step.sel):null;
  const r=el?el.getBoundingClientRect():null;
  const vh=window.innerHeight, margin=8;
  // Cap how tall the card can ever get before measuring anything below — on a
  // short phone screen this forces the description to scroll internally
  // instead of the card (and its Next/Skip buttons) growing past the edge.
  card.style.maxHeight=(vh-margin*2)+'px';
  card.style.transform='translateX(-50%)'; // horizontal-only from here on, so pixel top/bottom math below isn't fighting a translateY too
  if(r && r.width>0 && r.height>0){
    const pad=6;
    hole.style.display='block';
    hole.style.left=(r.left-pad)+'px'; hole.style.top=(r.top-pad)+'px';
    hole.style.width=(r.width+pad*2)+'px'; hole.style.height=(r.height+pad*2)+'px';
    card.style.maxWidth='340px'; card.style.width='calc(100% - 24px)';
    // Put the card in the roomy staff area when the target is low; below it when high.
    if(r.top < vh*0.42){ card.style.top=(r.bottom+14)+'px'; card.style.bottom='auto'; }
    else { card.style.top='auto'; card.style.bottom=(vh-r.top+14)+'px'; }
    card.style.left='50%';
  } else {
    hole.style.display='none';
    card.style.maxWidth='340px'; card.style.width='calc(100% - 24px)';
    card.style.left='50%'; card.style.top='50%'; card.style.bottom='auto';
  }
  // Safety net: whatever the branch above computed, make sure the card ends
  // up fully on-screen. A spotlighted control near the top/bottom edge of a
  // short phone (plus a longer description) could otherwise push the
  // Next/Skip/Back buttons past the viewport with no scroll (body is
  // overflow:hidden) and no pinch-zoom (viewport is pinned) to reach them —
  // silently bricking the tour until the page is reloaded. Do not remove.
  const cr=card.getBoundingClientRect();
  let top = (!r||!(r.width>0&&r.height>0)) ? (vh-cr.height)/2 : cr.top;
  top=Math.max(margin, Math.min(top, vh-margin-cr.height));
  card.style.top=top+'px'; card.style.bottom='auto';
}
function tourReposition(){ if(tourActive) positionTour(TOUR[tourIdx],tourIdx); }
function endTour(){
  tourActive=false;
  const ov=document.getElementById('tour-overlay'); if(ov)ov.remove();
  window.removeEventListener('resize', tourReposition);
  selectedNote=null; caretGap=null; render(); updateSelectionUI();
  safeStore.set('mn_tutorial_seen','1');
}

// ═══════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════
// ── Accessible names ────────────────────────────────────
// 19 controls were glyph-only or a bare SVG with no text, title or label, so
// a screen reader announced them as "button" and nothing else. Applied here
// rather than inline so the wording stays in one place — several of these
// buttons have their visible glyph rewritten by refreshDurIcons().
const ARIA_LABELS={
  'd-w':'Whole note','d-h':'Half note','d-q':'Quarter note','d-8':'Eighth note',
  'd-16':'Sixteenth note','d-32':'Thirty-second note','d-dot':'Dotted note',
  'qe-d-w':'Whole note','qe-d-h':'Half note','qe-d-q':'Quarter note','qe-d-8':'Eighth note',
  'qe-d-16':'Sixteenth note','qe-d-32':'Thirty-second note','qe-d-dot':'Dotted note',
  'rest-btn':'Add a rest',
  'a-key':'Follow the key signature','a-n':'Natural','a-s':'Sharp','a-f':'Flat',
  'a-ss':'Double sharp','a-ff':'Double flat',
  'd-tuplet':'Toggle tuplet','help-btn':'Help and guided tour',
  'copy-toggle-btn':'Copy and paste a range of notes',
  'btn-chord7':'Add sevenths to the chord buttons','btn-chord-mode':'Build a chord note by note',
  'theme-btn':'Switch between light and dark interface',
};
const ARIA_BY_SELECTOR=[
  ['.tb.play','Play the score'],
  ['.tb.stop','Stop playback'],
];
function applyAriaLabels(){
  for(const [id,label] of Object.entries(ARIA_LABELS)){
    const el=document.getElementById(id);
    if(el && !el.getAttribute('aria-label')) el.setAttribute('aria-label',label);
  }
  for(const [sel,label] of ARIA_BY_SELECTOR){
    const el=document.querySelector(sel);
    if(el && !el.getAttribute('aria-label')) el.setAttribute('aria-label',label);
  }
  // The accidental buttons appear twice (quick-edit bar and the Selected
  // panel) and carry no id, so name them by what they do.
  document.querySelectorAll('[onclick^="setSelAcc"]').forEach(el=>{
    if(el.getAttribute('aria-label'))return;
    const t=(el.textContent||'').trim();
    el.setAttribute('aria-label', t==='♯'?'Make this note sharp':t==='♭'?'Make this note flat':'Make this note natural');
  });
  // The octave/tuplet steppers are bare − and + next to their own labels;
  // sighted users get that from proximity, screen readers need it said.
  document.querySelectorAll('#dur-row .chip').forEach(el=>{
    const t=(el.textContent||'').trim();
    if(el.getAttribute('aria-label')||el.getAttribute('title')) return;
    if(t==='−') el.setAttribute('aria-label','Nudge down an octave');
    if(t==='+') el.setAttribute('aria-label','Nudge up an octave');
  });
}

initTheme();
pitchView=safeStore.get('mn_pitchview')==='concert'?'concert':'written';
{ const z=parseFloat(safeStore.get('mn_zoom')); if(z && z>=MIN_ZOOM && z<=MAX_ZOOM) scoreZoom=z; }
setAcc('key');clearArts();setDyn(null);setTempo(null);
refreshDurIcons();
relabelNoteButtons();
renderDiatonicChords();
initProjects();
applyKeyHue();   // initProjects() may have loaded a song in another key
applyAriaLabels();
applyPitchView(pitchView);
render();
initMidi();
document.getElementById('bpm-inp').addEventListener('change',scheduleAutosave);
if(!safeStore.get('mn_tutorial_seen')) setTimeout(startTour, 500);

// Register the worker last, so a failure here can never hold up the app.
// Opened straight off disk there is no worker (and no origin to scope one
// to) — the app still runs, it just isn't installable.
if('serviceWorker' in navigator && location.protocol.startsWith('http')){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
