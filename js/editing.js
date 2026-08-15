// ═══════════════════════════════════════════════════════════════════════
// MōdScore — Note entry, undo/redo, and editing the selected note
// ═══════════════════════════════════════════════════════════════════════
// Part of a single shared script, split across files so a change to one
// concern is not a change inside a five-thousand-line file. These load as
// ordinary scripts, in the order index.html lists them, and share one global
// scope exactly as they did when they were one block — see js/README.md for
// why it is not ES modules.

// ═══════════════════════════════════════════════════════
// Note entry
// ═══════════════════════════════════════════════════════
function buildDur(rest=false){return composeDur(selDur,dotted,tupletMode?tupletN:0,rest);}
function grabPending(){
  return{
    lyric:document.getElementById('lyric-inp').value.trim()||null,
    dyn:pendingDyn,arts:pendingArts.slice(),tempo:pendingTempo,rud:pendingRud,sticking:pendingSticking,
    grace:pendingGraceNotes.map(g=>({keys:[g.name+'/'+g.oct],dur:g.dur,vfAcc:g.vfAcc??g.acc}))
  };
}

// Inserts a note into the active part at the cursor: after the selected note,
// at a gap caret, or appended at the end. Advances the cursor — after an
// insert relative to a selection/gap it selects the new note so consecutive
// taps build forward; a plain append stays in append mode (cursor at the end).
function insertNoteAtCursor(noteObj){
  const notes=parts[apIdx].notes;
  let pos, fromCursor;
  if(selectedNote && selectedNote.partIdx===apIdx){ pos=Math.min(selectedNote.noteIdx+1,notes.length); fromCursor=true; }
  else if(caretGap && caretGap.partIdx===apIdx){ pos=Math.min(caretGap.index,notes.length); fromCursor=true; }
  else { pos=notes.length; fromCursor=false; }
  notes.splice(pos,0,noteObj);
  if(fromCursor){ selectedNote={partIdx:apIdx,noteIdx:pos}; caretGap=null; }
  else { selectedNote=null; caretGap=null; }
  // Tuplet mode groups exactly N notes — auto-exit once N are entered so it
  // doesn't linger and silently tuplet-ize everything after, the same trap
  // chord build mode used to leave people stuck in.
  if(tupletMode && noteObj.dur && tupletNumOf(noteObj.dur)){
    tupletCount++;
    if(tupletCount>=tupletN){ tupletMode=false; tupletCount=0; refreshDurRow(); }
  }
}
// Keep the note just entered/edited in view: scroll to the selected note if
// one is set (mid-phrase insert), otherwise to the end (append mode).
function scrollAfterEntry(){
  if(selectedNote && selectedNote.partIdx===apIdx){
    const pos=notePositions.find(p=>p.partIdx===apIdx && p.noteIdx===selectedNote.noteIdx);
    const wrap=document.getElementById('score-wrap');
    if(pos && (pos.x>wrap.scrollLeft+wrap.clientWidth-40 || pos.x<wrap.scrollLeft+40)){
      wrap.scrollTo({left:Math.max(0,pos.x-wrap.clientWidth/2),top:wrap.scrollTop,behavior:SCROLL_BEHAVIOR});
      return;
    }
    if(pos) return;
  }
  scrollToNoteEnd(apIdx);
}

// Single-line percussion (Snare, Bass Drum) has no real pitch to choose —
// every hit renders at the same fixed spot on the one visible line,
// regardless of entry path (grid button, MIDI keyboard, etc).
const SINGLE_LINE_KEY={name:'B',acc:null,oct:4};
// (name, acc, oct) arrive as the pitch the user is *reading* — which on a
// transposing part in written view is a tone or a sixth away from the pitch
// that sounds. Everything stored below is concert.
function enterPitch(name, acc, oct, vfAcc){
  const activeInst=IMAP[parts[apIdx]?.instId]||IMAP.piano;
  if(activeInst.staffLines===1){ ({name,acc,oct}=SINGLE_LINE_KEY); vfAcc=null; }
  const semis=writtenSemis(parts[apIdx]);
  const midi=noteToMidi(name,acc,oct)-semis;
  if(semis){ const sp=spellConcert(midi,editMeasureIndex()); name=sp.name; oct=sp.oct; acc=sp.acc; vfAcc=sp.vfAcc; }
  auditionPreview([midi], parts[apIdx]?.instId);
  if(chordBuildMode){
    pendingChordNotes.push({name,acc,oct,midi,vfAcc});
    updatePendingDisplay();
    return;
  }
  if(graceMode){
    pendingGraceNotes.push({name,acc,oct,midi,vfAcc,dur:graceDur});
    updateGracePendingDisplay();
    return;
  }
  const {lyric,dyn,arts,tempo,rud,grace,sticking}=grabPending();
  insertNoteAtCursor({keys:[name+'/'+oct],dur:buildDur(),vfAccs:[vfAcc],midiVals:[midi],rest:false,lyric,dyn,arts,tempo,rud,grace,sticking});
  pendingGraceNotes=[];updateGracePendingDisplay();
  render();scrollAfterEntry();
}

// Anchor for octave placement: the last real note entered in this part, or
// (if the part is still empty) the instrument's idiomatic default register.
function getEntryAnchorMidi(part){
  const prev=[...part.notes].reverse().find(n=>!n.rest&&(n.midiVals||[]).length);
  if(prev) return prev.midiVals[prev.midiVals.length-1];
  const inst=IMAP[part.instId]||IMAP.piano;
  return noteToMidi('C',null,inst.defaultOct??4);
}
// Picks whichever octave (anchor's octave, or one above/below) puts (name,acc)
// closest in pitch to the anchor — e.g. anchor=B4, next letter C -> C5, not C4.
function nearestOctaveMidi(name,acc,anchorMidi){
  const anchorOct=Math.floor(anchorMidi/12)-1;
  let bestOct=anchorOct,bestDist=Infinity;
  for(let o=anchorOct-1;o<=anchorOct+1;o++){
    const d=Math.abs(noteToMidi(name,acc,o)-anchorMidi);
    if(d<bestDist){bestDist=d;bestOct=o;}
  }
  return bestOct;
}
function relabelNoteButtons(){
  // The letters follow the active part's *written* key, so on a B♭ trumpet in
  // written view the button marked D is the D that appears on the staff.
  const scale=partScale(parts[apIdx],editMeasureIndex());
  const glyph={'#':'♯','b':'♭','##':'𝄪','bb':'𝄫'};
  // NOTE: the hidden single-line "Hit" button also carries class `np`, so this
  // selection includes an 8th element with no scale degree. Guarding on
  // kd.scale[i] is essential — without it the destructure below threw at boot
  // and aborted the whole boot sequence before initProjects()/render() ran,
  // which is what silently broke autosave persistence AND made imported music
  // never display on screen. Do not remove this guard.
  document.querySelectorAll('#note-grid .np').forEach((b,i)=>{
    const sc=scale[i]; if(!sc)return;
    const [name,acc]=sc;
    b.textContent=name+(glyph[acc]||'');
  });
}
function handleScaleBtn(deg){
  const part=parts[apIdx];
  const scale=partScale(part,editMeasureIndex());
  const sc=scale[deg]; if(!sc)return;
  const [letter, scaleAcc]=sc;
  let acc, vfAcc;
  if(selAcc==='key'){ acc=scaleAcc; vfAcc=null; }        // key sig draws it
  else if(selAcc==='n'){ acc=null; vfAcc='n'; }            // force natural
  else { acc=selAcc; vfAcc=selAcc; }                       // #, b, ##, bb
  // The anchor is a sounding pitch; the octave search happens in the register
  // the player is reading, so it must be shifted to match.
  const anchor=getEntryAnchorMidi(part)+writtenSemis(part);
  const oct=nearestOctaveMidi(letter,acc,anchor)+selOct;
  enterPitch(letter, acc, oct, vfAcc);
}
// Computer-keyboard letter entry (Sibelius-style): pressing A–G enters that
// pitch letter, taking the key signature's accidental for it (every letter maps
// to exactly one degree of a 7-note diatonic scale). Routes through the same
// path as the on-screen letter buttons so accidental overrides & octave anchor
// all apply identically.
function enterLetterKey(letter){
  let deg=partScale(parts[apIdx],editMeasureIndex()).findIndex(s=>s[0]===letter);
  if(deg<0) deg=0;
  handleScaleBtn(deg);
}
// Backspace with nothing selected removes the last note of the active part
// (the old ⌫ behavior, now reachable only from the keyboard).
function deleteLastNote(){
  const arr=parts[apIdx].notes;
  if(!arr.length) return;
  arr.pop();
  parts[apIdx].hairpins=(parts[apIdx].hairpins||[]).filter(hp=>hp.end<arr.length);
  selectedNote=null; caretGap=null;
  render(); updateSelectionUI();
}
// Arrow-key navigation: move the selection to the previous/next note in the
// active part (starting from an end if nothing is selected yet).
function moveSelection(dir){
  const arr=parts[apIdx].notes;
  if(!arr.length) return;
  let idx=(selectedNote && selectedNote.partIdx===apIdx) ? selectedNote.noteIdx+dir : (dir>0?0:arr.length-1);
  idx=Math.max(0,Math.min(arr.length-1,idx));
  selectedNote={partIdx:apIdx,noteIdx:idx}; caretGap=null;
  render(); updateSelectionUI(); scrollAfterEntry();
}

function addRest(){
  const p=parts[apIdx];
  const clef=p.clef||(IMAP[p.instId]?.clef)||'treble';
  const rk=clef==='bass'?'d/3':'b/4';
  insertNoteAtCursor({keys:[rk],dur:buildDur(true),vfAccs:[null],midiVals:[],rest:true,lyric:null,dyn:null,arts:[],tempo:null,rud:null,grace:[],sticking:null});
  render();scrollAfterEntry();
}

// ═══════════════════════════════════════════════════════
// Undo / redo — snapshot-based history
// ═══════════════════════════════════════════════════════
// Rather than instrument every mutating action, we record the serialized
// document state after each change (render() already runs once per action and
// calls maybeRecordHistory below). Consecutive identical states are skipped, so
// selection-only changes — which aren't serialized — never create an entry.
//
// A flat cap of 100 entries is the wrong unit: at ~200 KB per snapshot for a
// long piece that is 20 MB of strings held on a phone. The cap is on total
// bytes instead, so a short song keeps a deep history and a long one keeps a
// shallower one, which is the trade anyone would make.
const HISTORY_MAX=100;
const HISTORY_MAX_BYTES=4*1024*1024;
let history=[], histIndex=-1, historyLocked=false, historyBytes=0;
// serializeProject() deep-clones and then the caller stringifies the clone,
// so recording one history entry walked the whole score three times. History
// only ever needs the text, and the text can be produced from the live objects
// in one pass.
function currentStateStr(){ return JSON.stringify(projectShape()); }
// Start a fresh timeline for a newly loaded/created/imported song.
function resetHistory(){
  const s=currentStateStr();
  history=[s]; histIndex=0; historyBytes=s.length;
  updateUndoRedoButtons();
}
function maybeRecordHistory(){
  if(historyLocked) return;
  const s=currentStateStr();
  if(history[histIndex]===s) return;          // nothing actually changed
  for(let i=histIndex+1;i<history.length;i++) historyBytes-=history[i].length;
  history=history.slice(0,histIndex+1);        // drop any redo tail
  history.push(s); historyBytes+=s.length;
  while(history.length>1 && (history.length>HISTORY_MAX+1 || historyBytes>HISTORY_MAX_BYTES)){
    historyBytes-=history[0].length;
    history.shift();
  }
  histIndex=history.length-1;
  updateUndoRedoButtons();
}
// Apply a stored snapshot without recording it as a new change.
function applyHistoryState(s){
  historyLocked=true;
  try{ applyProject(JSON.parse(s)); }
  finally{ historyLocked=false; }
  updateUndoRedoButtons();
}
function undo(){
  if(histIndex<=0) return;
  histIndex--; applyHistoryState(history[histIndex]);
}
function redo(){
  if(histIndex>=history.length-1) return;
  histIndex++; applyHistoryState(history[histIndex]);
}
function updateUndoRedoButtons(){
  const u=document.getElementById('undo-btn'), r=document.getElementById('redo-btn');
  if(u) u.disabled = histIndex<=0;
  if(r) r.disabled = histIndex>=history.length-1;
}
async function clearAll(){
  if(!parts.some(p=>p.notes.length))return;
  if(!await sheetConfirm('Clear this song?','Every note in every part is removed. Undo will still bring it back.','Clear all',true))return;
  parts.forEach(p=>{p.notes=[];p.hairpins=[];});
  selectedNote=null; caretGap=null;
  render();
}

// ═══════════════════════════════════════════════════════
// Note selection & editing
// ═══════════════════════════════════════════════════════
// Everything for editing the selected note lives in the one bar above the
// staff. It used to be duplicated into a panel in the side rail as well,
// which meant two places to look and two to keep in sync.
function updateSelectionUI(){
  const qe=document.getElementById('quick-edit-bar');
  if(!selectedNote){qe.style.display='none';refreshDurRow();syncEditorsToSelection();announceSelection();return;}
  const n=parts[selectedNote.partIdx]?.notes[selectedNote.noteIdx];
  if(!n){qe.style.display='none';refreshDurRow();syncEditorsToSelection();announceSelection();return;}
  const label=n.rest?'Rest':(n.keys||[]).map((k,i)=>{const[name,oct]=k.split('/');const acc=n.vfAccs?.[i];return name+(acc&&acc!=='n'?acc:'')+oct;}).join(' ');
  qe.style.display='flex';
  document.getElementById('qe-label').textContent=label;
  document.querySelectorAll('.qe-pitch-btn').forEach(b=>b.style.display=n.rest?'none':'');
  refreshDurRow();
  syncEditorsToSelection();
  announceSelection();
}

// ── Saying the music out loud ───────────────────────────
// Every control got an accessible name, and the music they operate on stayed a
// bare SVG — so a blind musician could work every button and never learn what
// had been written. These turn the score into something that can be read.
const DUR_WORDS={w:'whole note',h:'half note',q:'quarter note','8':'eighth note','16':'sixteenth note','32':'thirty-second note'};
const ACC_WORDS={'#':' sharp','b':' flat','n':' natural','##':' double sharp','bb':' double flat'};
const ART_WORDS={'a.':'staccato','a>':'accent','a-':'tenuto','a^':'marcato','ao':'fermata','a+':'stopped','tr':'trill'};
// "C sharp 4" rather than "C#/4" — screen readers say the punctuation.
function speakPitch(key,acc){
  const [name,oct]=String(key||'').split('/');
  return name+(acc&&ACC_WORDS[acc]?ACC_WORDS[acc]:'')+' '+oct;
}
function describeNote(n,part,mi){
  if(!n) return '';
  const d=decomposeDur(n.dur);
  const bits=[];
  if(n.repeatBars) return 'repeat of the previous '+(n.repeatBars>1?n.repeatBars+' bars':'bar');
  const dur=(d.dot?'dotted ':'')+(DUR_WORDS[d.base]||'note')+(d.tupN?', '+d.tupN+' in the time of '+tupletOccupied(d.tupN):'');
  if(n.rest){ bits.push(dur.replace('note','rest')); }
  else{
    const disp=part?displayKeys(n,part,mi):{keys:n.keys,vfAccs:n.vfAccs};
    const pitches=(disp.keys||[]).map((k,i)=>speakPitch(k,(disp.vfAccs||[])[i]));
    bits.push((pitches.length>1?'chord, ':'')+pitches.join(', '));
    bits.push(dur);
  }
  if(n.dyn) bits.push(n.dyn);
  (n.arts||[]).forEach(a=>{ if(ART_WORDS[a]) bits.push(ART_WORDS[a]); });
  if(n.tempo) bits.push(n.tempo);
  if(n.lyric) bits.push('lyric '+n.lyric);
  if(n.sticking) bits.push('stick '+(n.sticking==='R'?'right':'left'));
  return bits.join(', ');
}
// Where a note sits, counted the way a musician would say it.
function positionOfNote(partIdx,noteIdx){
  const notes=parts[partIdx]?.notes||[];
  let mi=0,beats=0,BMAX=beatsAt(0);
  for(let i=0;i<noteIdx&&i<notes.length;i++){
    beats+=noteBeats(notes[i],mi);
    if(beats>=BMAX-.001){ mi++; beats=0; BMAX=beatsAt(mi); }
  }
  return {measure:mi+1, beat:Math.round((beats+1)*100)/100};
}
function announceSelection(){
  const live=document.getElementById('score-live');
  if(!live) return;
  if(!selectedNote){
    if(caretGap) live.textContent='Cursor at the start of bar '+(positionOfNote(caretGap.partIdx,caretGap.index).measure);
    else live.textContent='';
    return;
  }
  const part=parts[selectedNote.partIdx];
  const n=part?.notes[selectedNote.noteIdx];
  if(!n){ live.textContent=''; return; }
  const pos=positionOfNote(selectedNote.partIdx,selectedNote.noteIdx);
  live.textContent=part.name+', bar '+pos.measure+' beat '+pos.beat+', '+describeNote(n,part,pos.measure-1);
}
// A readable outline of the active part, so the music itself is reachable —
// not only the note the cursor happens to be on.
//
// Rebuilt off the critical path. It walks every bar of the piece, which on a
// long score is more than a keystroke should pay for, and unlike the live
// region nothing needs it within the frame: it is a reference document, read
// when someone goes looking for it. The live announcement above stays
// immediate, because that one is the feedback for the edit you just made.
let _outlineT=0;
function scheduleScoreOutline(){
  clearTimeout(_outlineT);
  _outlineT=setTimeout(()=>{
    if(window.requestIdleCallback) requestIdleCallback(updateScoreOutline,{timeout:1000});
    else updateScoreOutline();
  },400);
}
function updateScoreOutline(){
  const host=document.getElementById('score-outline');
  if(!host) return;
  const part=parts[apIdx];
  if(!part){ host.textContent=''; return; }
  host.innerHTML='';
  const h=el('h2',null,part.name+' — '+(IMAP[part.instId]||IMAP.piano).label
    +', '+(KMAP[currentKeyId]?.label||currentKeyId)+', '+currentTimeSig.sig
    +(isTransposing(part)?', sounds in '+transposeLabel(isTransposing(part)):''));
  host.appendChild(h);
  const ms=toMeasures(part.notes);
  const ol=document.createElement('ol');
  ms.forEach((m,mi)=>{
    const li=el('li',null,'Bar '+(mi+1)+': '+(m.length?m.map(it=>describeNote(it,part,mi)).join('; '):'empty'));
    ol.appendChild(li);
  });
  host.appendChild(ol);
}

function moveSelNote(semitones){
  if(!selectedNote)return;
  const n=parts[selectedNote.partIdx]?.notes[selectedNote.noteIdx];
  if(!n||n.rest)return;
  n.midiVals=n.midiVals.map(m=>m+semitones);
  const results=n.midiVals.map(m=>midiToNote(m));
  n.keys=results.map(r=>r.name+'/'+r.oct);
  n.vfAccs=results.map(r=>r.acc);
  auditionPreview(n.midiVals, parts[selectedNote.partIdx]?.instId);
  render(); updateSelectionUI();
}

function setSelAcc(acc){
  if(!selectedNote)return;
  const n=parts[selectedNote.partIdx]?.notes[selectedNote.noteIdx];
  if(!n||n.rest)return;
  const midi=n.midiVals[0]; if(midi==null)return;
  const {name,oct}=midiToNote(midi);
  n.keys[0]=name+'/'+oct;
  if(acc==='n'){ n.vfAccs[0]='n'; n.midiVals[0]=noteToMidi(name,null,oct); }
  else { n.vfAccs[0]=acc; n.midiVals[0]=noteToMidi(name,acc,oct); }
  auditionPreview(n.midiVals, parts[selectedNote.partIdx]?.instId);
  render(); updateSelectionUI();
}

// "⇢Rest" turns the note into a rest, keeping its rhythmic slot & timing.
function makeRest(){
  if(!selectedNote)return;
  const p=parts[selectedNote.partIdx]; const n=p?.notes[selectedNote.noteIdx]; if(!n)return;
  const clef=p.clef||(IMAP[p.instId]?.clef)||'treble';
  n.rest=true; n.midiVals=[]; n.keys=[clef==='bass'?'d/3':'b/4']; n.vfAccs=[null]; n.arts=[]; n.lyric=null; n.rud=null; n.grace=[]; n.sticking=null;
  render(); updateSelectionUI();
}
// True delete: remove the note entirely (everything after shifts left). Leaves
// a gap caret at that spot so the next note you write lands in the vacated slot.
function removeSelected(){
  if(!selectedNote)return;
  const p=parts[selectedNote.partIdx]; if(!p)return;
  const idx=selectedNote.noteIdx;
  if(idx<0||idx>=p.notes.length)return;
  p.notes.splice(idx,1);
  p.hairpins=(p.hairpins||[]).filter(hp=>hp.start!==idx&&hp.end!==idx).map(hp=>({...hp,start:hp.start>idx?hp.start-1:hp.start,end:hp.end>idx?hp.end-1:hp.end}));
  caretGap={partIdx:selectedNote.partIdx,index:idx};
  selectedNote=null;
  render(); updateSelectionUI();
}

// Copy/paste: tap a start note then an end note (same part) to pick a
// contiguous range; a 3rd tap starts a fresh range. All per-note fields
// (pitch, duration, dyn/arts/tempo/lyric/rud/grace/sticking) travel with the
// copy via deep-clone; hairpins (a part-level index range, not a per-note
// field) are not included — a documented gap, not a silent drop.
function toggleCopyMode(){
  copyMode=!copyMode;
  copyRangeSel=null;
  if(copyMode){ selectedNote=null; caretGap=null; } // avoid showing both the edit panel and the copy panel at once
  document.getElementById('copy-toggle-btn').style.background=copyMode?'#27ae60':'#2a2a40';
  document.getElementById('copy-toggle-btn').style.color=copyMode?'#fff':'#9bd';
  render(); updateSelectionUI(); updateCopyUI();
}
function pickCopyRangeNote(partIdx,noteIdx){
  if(!copyRangeSel||copyRangeSel.partIdx!==partIdx||copyRangeSel.complete){
    copyRangeSel={partIdx,anchor:noteIdx,startIdx:noteIdx,endIdx:noteIdx,complete:false};
  } else {
    copyRangeSel.startIdx=Math.min(copyRangeSel.anchor,noteIdx);
    copyRangeSel.endIdx=Math.max(copyRangeSel.anchor,noteIdx);
    copyRangeSel.complete=true;
  }
  render(); updateCopyUI();
}
function updateCopyUI(){
  const sec=document.getElementById('copy-section');
  if(!copyMode){ sec.style.display='none'; return; }
  sec.style.display='block';
  const status=document.getElementById('copy-status');
  const copyBtn=document.getElementById('copy-btn');
  if(!copyRangeSel){
    status.textContent='Tap the first note of the range.';
    copyBtn.style.display='none';
  } else if(!copyRangeSel.complete){
    status.textContent='Tap the last note of the range (or the same note again for just one).';
    copyBtn.style.display='none';
  } else {
    const n=copyRangeSel.endIdx-copyRangeSel.startIdx+1;
    status.textContent=n+(n===1?' note':' notes')+' selected.';
    copyBtn.style.display='inline-flex';
  }
}
function copySelectedRange(){
  if(!copyRangeSel||!copyRangeSel.complete)return;
  const {partIdx,startIdx,endIdx}=copyRangeSel;
  clipboard=JSON.parse(JSON.stringify(parts[partIdx].notes.slice(startIdx,endIdx+1)));
  copyMode=false; copyRangeSel=null;
  document.getElementById('copy-toggle-btn').style.background='#2a2a40';
  document.getElementById('copy-toggle-btn').style.color='#9bd';
  render(); updateCopyUI(); updatePasteUI();
}
function cancelCopyRange(){
  copyMode=false; copyRangeSel=null;
  document.getElementById('copy-toggle-btn').style.background='#2a2a40';
  document.getElementById('copy-toggle-btn').style.color='#9bd';
  render(); updateCopyUI();
}
function updatePasteUI(){
  const sec=document.getElementById('paste-section');
  if(!clipboard){ sec.style.display='none'; return; }
  sec.style.display='block';
  document.getElementById('paste-status').textContent='Clipboard: '+clipboard.length+(clipboard.length===1?' note':' notes')+' — select where to paste, or leave nothing selected to append.';
}
// Paste OVERWRITES: it replaces clipboard.length notes starting at the paste
// point (the selected note, the caret gap, or the end), rather than inserting.
function pasteClipboard(){
  if(!clipboard||!clipboard.length)return;
  const part=parts[apIdx];
  const at=(selectedNote&&selectedNote.partIdx===apIdx)?selectedNote.noteIdx
          :(caretGap&&caretGap.partIdx===apIdx)?caretGap.index
          :part.notes.length;
  const clones=JSON.parse(JSON.stringify(clipboard));
  part.notes.splice(at, clones.length, ...clones);
  selectedNote={partIdx:apIdx,noteIdx:at+clones.length-1}; caretGap=null;
  render(); updateSelectionUI(); scrollAfterEntry();
}
function clearClipboard(){ clipboard=null; updatePasteUI(); }

document.getElementById('score-wrap').addEventListener('click', e=>{
  if(selectedNoteSuppressed) return;   // tail end of a pinch, not a tap
  const scoreDiv=document.getElementById('score-div');
  const rect=scoreDiv.getBoundingClientRect();
  const cx=e.clientX-rect.left, cy=e.clientY-rect.top;
  let best=null, bestDist=34;
  for(const pos of notePositions){
    const dx=Math.abs(cx-pos.x);
    const midY=pos.y+(pos.h*0.45);
    const dist=Math.sqrt(dx*dx+(cy-midY)*(cy-midY));
    if(dist<bestDist){bestDist=dist;best=pos;}
  }
  if(copyMode){
    if(best) pickCopyRangeNote(best.partIdx,best.noteIdx);
    return;
  }
  if(best){
    apIdx=best.partIdx;                 // edit/insert in the staff you tapped
    selectedNote={partIdx:best.partIdx,noteIdx:best.noteIdx};
    caretGap=null;
    // Sound the note you touched. On a multi-stave score the quickest way to
    // know which part you have landed on is to hear it.
    const tapped=parts[best.partIdx]?.notes[best.noteIdx];
    if(tapped && !tapped.rest && (tapped.midiVals||[]).length){
      auditionPreview(tapped.midiVals, parts[best.partIdx].instId);
    }
    render(); updateSelectionUI(); switchTab('notes');
  } else {
    // Tapped empty space — drop an insertion cursor in the nearest gap.
    const g=gapFromTap(cx,cy);
    apIdx=g.partIdx; caretGap=g; selectedNote=null;
    render(); updateSelectionUI(); switchTab('notes');
  }
});
// Which (part, gap-index) an empty-space tap corresponds to: nearest staff by
// vertical distance, then count how many of that part's notes sit left of the tap.
// Picks the staff nearest a tap by its row band (TP + pi*PG), not by scanning
// notePositions — a part with zero notes anywhere (a freshly added instrument,
// or a paste destination that hasn't been written into yet) has no entries in
// notePositions at all, so the old nearest-note search could never land on it
// and silently snapped the tap to whichever staff already had notes.
function gapFromTap(cx,cy){
  const numP=parts.length;
  let bestPart=Math.round((cy/scoreZoom-TP-PG/2)/PG);
  bestPart=Math.max(0,Math.min(numP-1,bestPart));
  const inPart=notePositions.filter(p=>p.partIdx===bestPart);
  let index=0;
  inPart.forEach(p=>{ if(cx>p.x) index=Math.max(index,p.noteIdx+1); });
  return {partIdx:bestPart,index};
}
// Positions the insertion-cursor line inside #score-div (scrolls with content).
function renderCaret(){
  const div=document.getElementById('score-div');
  if(!div)return;
  let caret=document.getElementById('score-caret');
  if(!caret){ caret=document.createElement('div'); caret.id='score-caret'; div.appendChild(caret); }
  if(!caretGap){ caret.style.display='none'; return; }
  const pn=notePositions.filter(p=>p.partIdx===caretGap.partIdx);
  const at=pn.find(p=>p.noteIdx===caretGap.index);
  let x;
  if(at) x=at.x-14*scoreZoom;
  else if(pn.length) x=Math.max(...pn.map(p=>p.x))+34*scoreZoom;
  else x=(FX+30)*scoreZoom;
  // VexFlow draws the 5 staff lines starting ~40px below the stave's sy
  // (default space-above); center the caret over that band (sy+40 .. sy+80).
  const y=(TP+caretGap.partIdx*PG+34)*scoreZoom;
  caret.style.cssText='position:absolute;left:'+x+'px;top:'+y+'px;width:2.5px;height:'+(52*scoreZoom)+'px;background:#2980b9;border-radius:2px;pointer-events:none;box-shadow:0 0 3px rgba(41,128,185,.6);';
  caret.style.display='block';
}
