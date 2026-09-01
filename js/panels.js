// ═══════════════════════════════════════════════════════════════════════
// MōdScore — The control panels: score setup, parts, tabs, note controls, chords
// ═══════════════════════════════════════════════════════════════════════
// Part of a single shared script, split across files so a change to one
// concern is not a change inside a five-thousand-line file. These load as
// ordinary scripts, in the order index.html lists them, and share one global
// scope exactly as they did when they were one block — see js/README.md for
// why it is not ES modules.

// ═══════════════════════════════════════════════════════
// Score setup panel init
// ═══════════════════════════════════════════════════════
(function initScorePanel(){
  const majGrid=document.getElementById('key-major-grid');
  const minGrid=document.getElementById('key-minor-grid');
  KEYS_DATA.filter(k=>k.mode==='major').forEach(k=>{
    const b=document.createElement('button');
    b.className='key-btn'+(k.id==='C'?' on':'');
    b.textContent=k.label; b.dataset.kid=k.id;
    b.onclick=()=>setKey(k.id);
    majGrid.appendChild(b);
  });
  KEYS_DATA.filter(k=>k.mode==='minor').forEach(k=>{
    const b=document.createElement('button');
    b.className='key-btn'; b.textContent=k.label; b.dataset.kid=k.id;
    b.onclick=()=>setKey(k.id);
    minGrid.appendChild(b);
  });
  const tg=document.getElementById('time-grid');
  TIME_SIGS.forEach((ts,i)=>{
    const b=document.createElement('button');
    b.className='time-btn'+(i===0?' on':''); b.textContent=ts.sig; b.dataset.sig=ts.sig;
    b.onclick=()=>setTimeSig(ts.sig);
    tg.appendChild(b);
  });
})();

// Always-visible reminder of which staff new notes land on — the Parts tab
// list only shows this while that tab is open, which left people typing into
// the wrong instrument without realizing it.
function updatePartPill(){
  const pill=document.getElementById('part-pill');
  if(!pill)return;
  const p=parts[apIdx];
  if(!p){ pill.textContent='—'; return; }
  const inst=IMAP[p.instId]||IMAP.piano;
  pill.textContent=p.name+' · '+inst.label;
}
// Position on the circle of fifths, keyed by the signature a key carries —
// so a key and its relative minor (same signature) land on the same colour.
const FIFTHS_OF_SIG={'C':0,'G':1,'D':2,'A':3,'E':4,'B':5,'F#':6,'Db':7,'Ab':8,'Eb':9,'Bb':10,'F':11};
// Drives --kh, from which the chord palette's tonic/subdominant/dominant
// colours are derived. One fifth = 30° of hue, so the palette walks the
// colour wheel in step with the music walking the circle of fifths, and C
// keeps the blue/gold/red the app has always had.
function applyKeyHue(){
  const sig=KMAP[currentKeyId]?.vfSig||'C';
  const fifths=FIFTHS_OF_SIG[sig]??0;
  document.documentElement.style.setProperty('--kh',((210+fifths*30)%360));
}
// Which bar an edit applies to: the selected note's, else the cursor's, else
// the end of the active part. The same rule the repeat markers already use.
function editMeasureIndex(){
  try{
    if(selectedNote) return measureIndexOfNote(selectedNote.partIdx,selectedNote.noteIdx);
    if(caretGap) return measureIndexOfNote(caretGap.partIdx,Math.max(0,caretGap.index-1));
    const n=parts[apIdx]?.notes.length||0;
    return n?measureIndexOfNote(apIdx,n-1):0;
  }catch(e){ return 0; }
}
// With a note selected, changing key or metre changes it *from that bar on* —
// the score keeps everything before it. With nothing selected the change is
// the song's opening key or metre, which is how it always behaved.
function setKey(kid){
  const mi=changeScope?editMeasureIndex():0;
  if(mi>0){
    if(keyAt(mi-1)===kid) delete keyChanges[mi]; else keyChanges[mi]=kid;
  } else {
    currentKeyId=kid;
    delete keyChanges[0];
  }
  syncKeyTimeUI();
  applyKeyHue();
  relabelNoteButtons();
  renderDiatonicChords();
  render();
}
function setPickup(beats){
  pickupBeats=Math.max(0,Math.min(currentTimeSig.beats-0.5,beats));
  syncKeyTimeUI(); render();
}
function clearChangesHere(){
  const mi=editMeasureIndex();
  if(mi<=0){ toast('Select a note in a later bar — bar 1 carries the song’s opening key and metre.','warn'); return; }
  delete keyChanges[mi]; delete sigChanges[mi];
  syncKeyTimeUI(); relabelNoteButtons(); renderDiatonicChords(); render();
}
// 'song' = edit the opening key/metre, 'here' = change from the selected bar.
let changeScope=false;
function toggleChangeScope(){
  changeScope=!changeScope;
  syncKeyTimeUI(); render();
}
function syncKeyTimeUI(){
  const mi=changeScope?editMeasureIndex():0;
  const kNow=keyAt(mi), tNow=timeSigAt(mi);
  document.querySelectorAll('.key-btn').forEach(b=>b.classList.toggle('on',b.dataset.kid===kNow));
  document.querySelectorAll('.time-btn').forEach(b=>b.classList.toggle('on',b.dataset.sig===tNow.sig));
  const pill=document.getElementById('key-pill');
  if(pill) pill.textContent=(KMAP[currentKeyId]?.label||currentKeyId)+(Object.keys(keyChanges).length?' →':'');
  const btn=document.getElementById('scope-btn');
  if(btn){
    btn.textContent=changeScope?('✎ Changing from bar '+(mi+1)):'✎ Whole song';
    btn.classList.toggle('on',changeScope);
  }
  const pk=document.getElementById('pickup-val');
  if(pk) pk.textContent=pickupBeats?pickupBeats+' beat'+(pickupBeats===1?'':'s'):'none';
  const lst=document.getElementById('changes-list');
  if(lst){
    lst.innerHTML='';
    const all=[...new Set([...Object.keys(keyChanges),...Object.keys(sigChanges)])].map(Number).filter(i=>i>0).sort((a,b)=>a-b);
    if(!all.length){ lst.appendChild(el('span','hint','No changes yet — the whole song is '+(KMAP[currentKeyId]?.label||currentKeyId)+' in '+currentTimeSig.sig+'.')); return; }
    all.forEach(i=>{
      const bits=[];
      if(keyChanges[i]) bits.push(KMAP[keyChanges[i]]?.label||keyChanges[i]);
      if(sigChanges[i]) bits.push(sigChanges[i]);
      const chip=el('button','chip','bar '+(i+1)+': '+bits.join(' · ')+' ✕');
      chip.style.fontSize='10px';
      chip.onclick=()=>{ delete keyChanges[i]; delete sigChanges[i]; syncKeyTimeUI(); relabelNoteButtons(); renderDiatonicChords(); render(); };
      lst.appendChild(chip);
    });
  }
}

// ── Theme ───────────────────────────────────────────────
// Defaults to the OS preference on first run, then remembers whatever the
// user picked.
function applyTheme(light){
  document.body.classList.toggle('light',!!light);
  const btn=document.getElementById('theme-btn');
  if(btn) btn.textContent=light?'☾ Dark mode':'☀ Light mode';
  safeStore.set('mn_theme',light?'light':'dark');
}
function toggleTheme(){ applyTheme(!document.body.classList.contains('light')); }
function initTheme(){
  const saved=safeStore.get('mn_theme');
  const prefersLight=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved?saved==='light':prefersLight);
}
// Smooth scrolling is motion too — respect the OS setting for the staff's
// auto-scroll the same way the stylesheet does for animations.
const PREFERS_REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const SCROLL_BEHAVIOR = PREFERS_REDUCED_MOTION ? 'auto' : 'smooth';
function setTimeSig(sig){
  const mi=changeScope?editMeasureIndex():0;
  if(mi>0){
    if(timeSigAt(mi-1).sig===sig) delete sigChanges[mi]; else sigChanges[mi]=sig;
  } else {
    currentTimeSig=TIME_SIGS.find(t=>t.sig===sig)||TIME_SIGS[0];
    delete sigChanges[0];
    if(pickupBeats>=currentTimeSig.beats) pickupBeats=0;
  }
  syncKeyTimeUI();
  render();
}

// ═══════════════════════════════════════════════════════
// Parts panel
// ═══════════════════════════════════════════════════════
// The picker is one scrolling list of collapsible families rather than a
// category row that swaps a second row underneath it: you can see everything
// on offer by scrolling, hear anything before committing to it, and tick a
// whole section (say four saxes) to add in one pass.
let openFamilies=new Set(['Keyboard']);
let instQuery='';

function buildInstrumentPicker(){
  const host=document.getElementById('inst-picker');
  if(!host)return;
  host.innerHTML='';
  const q=instQuery.trim().toLowerCase();
  // Searching flattens the accordion — with a query typed, hiding matches
  // behind a collapsed heading is the opposite of what was asked for.
  const matches=inst=>!q||(inst.label+' '+inst.cat+' '+(INST_ALIASES[inst.id]||'')).toLowerCase().includes(q);
  let shown=0;

  CATS.forEach(cat=>{
    const insts=INSTRUMENTS.filter(i=>i.cat===cat&&matches(i));
    if(!insts.length)return;
    shown+=insts.length;
    const open=q?true:openFamilies.has(cat);

    const fam=el('div','ifam');
    const head=el('button','ifam-head');
    head.type='button';
    head.setAttribute('aria-expanded',String(open));
    const icon=el('span','ifam-icon',CAT_ICON[cat]||'');
    icon.setAttribute('aria-hidden','true');
    head.appendChild(icon);
    head.appendChild(el('span','ifam-name',cat));
    head.appendChild(el('span','ifam-count',String(insts.length)));
    const chev=el('span','ifam-chev',open?'▴':'▾');
    chev.setAttribute('aria-hidden','true');
    head.appendChild(chev);
    // A query is showing every match already; collapsing one out from under
    // the search would just hide a result the user is looking at.
    head.onclick=()=>{ if(q)return; openFamilies.has(cat)?openFamilies.delete(cat):openFamilies.add(cat); buildInstrumentPicker(); };
    fam.appendChild(head);

    if(open){
      const body=el('div','ifam-body');
      insts.forEach(inst=>{
        const row=el('div','irow'+(pickedInsts.has(inst.id)?' picked':''));

        const prev=el('button','ipreview','▷');
        prev.type='button';
        prev.title='Hear '+inst.label;
        prev.setAttribute('aria-label','Hear '+inst.label);
        prev.onclick=e=>{ e.stopPropagation(); previewInstrument(inst.id); };
        row.appendChild(prev);

        row.appendChild(el('span','iname',inst.label));

        const picked=pickedInsts.has(inst.id);
        const add=el('button','iadd'+(picked?' on':''),picked?'✓':'+');
        add.type='button';
        add.setAttribute('aria-pressed',String(picked));
        add.setAttribute('aria-label',(picked?'Remove ':'Add ')+inst.label+' to the parts to be added');
        add.onclick=e=>{ e.stopPropagation(); toggleInstPick(inst.id); };
        row.appendChild(add);

        row.onclick=()=>toggleInstPick(inst.id);
        body.appendChild(row);
      });
      fam.appendChild(body);
    }
    host.appendChild(fam);
  });

  if(!shown) host.appendChild(el('div','hint','No instrument matches “'+instQuery.trim()+'”.'));
  syncAddFooter();
}

function toggleInstPick(id){
  pickedInsts.has(id)?pickedInsts.delete(id):pickedInsts.add(id);
  buildInstrumentPicker();
}

function searchInstruments(v){
  instQuery=v||'';
  buildInstrumentPicker();
}

function syncAddFooter(){
  const n=pickedInsts.size;
  const count=document.getElementById('inst-count');
  const btn=document.getElementById('btn-add-confirm');
  if(count) count.textContent=n===0?'None selected':(n===1?'1 selected':n+' selected');
  if(btn){
    btn.disabled=n===0;
    btn.textContent=n>1?('+ Add '+n+' Parts'):'+ Add Part';
  }
}

// Adds every ticked instrument, in the order the picker lists them, and makes
// the last one active — the same end state as adding them one at a time.
function confirmAddPart(){
  if(!pickedInsts.size)return;
  INSTRUMENTS.filter(i=>pickedInsts.has(i.id)).forEach(inst=>{
    parts.push(mkPart(inst.label,inst.id,inst.clef||'treble'));
  });
  apIdx=parts.length-1;
  pickedInsts.clear();
  // A stale selection would still hold the *old* active part's note index.
  selectedNote=null; caretGap=null;
  buildInstrumentPicker();
  renderPartsList(); render(); updateSelectionUI(); relabelNoteButtons();
}

function deletePart(i){
  if(parts.length<=1)return;
  parts.splice(i,1);
  if(apIdx>=parts.length)apIdx=parts.length-1;
  // Both hold a part *index*, and every index above the deleted one has just
  // shifted down — keeping either would aim the next edit at a different
  // instrument, or at a part that is no longer there.
  selectedNote=null; caretGap=null;
  renderPartsList(); render(); updateSelectionUI();
}
// Names are the one string in this app that comes from outside it — a song
// file written by someone else carries its own song and part names — so they
// are set as text, never interpolated into markup. esc() covers the two
// places that have to build a string: the print window and MusicXML export.
function esc(s){
  return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function el(tag,cls,text){
  const e=document.createElement(tag);
  if(cls) e.className=cls;
  if(text!=null) e.textContent=text;
  return e;
}
function renderPartsList(){
  const ul=document.getElementById('parts-list');
  ul.innerHTML='';
  parts.forEach((p,i)=>{
    const inst=IMAP[p.instId]||IMAP['piano'];
    const row=document.createElement('div');
    row.className='prow'+(i===apIdx?' ap':'');
    row.appendChild(el('div','pdot'));
    row.appendChild(el('span','pname',p.name));
    row.appendChild(el('span','pinst',inst.label));
    // Mute and solo — the first thing anyone reaches for when checking one
    // line inside a full score. Solo wins over mute when both are set.
    if(parts.length>1){
      const mk=(label,on,fn,title)=>{
        const b=el('button','pmix'+(on?' on':''),label);
        b.title=title;
        b.onclick=e=>{ e.stopPropagation(); fn(); };
        return b;
      };
      const m=mk('M',!!p.muted,()=>toggleMute(i),'Silence this part without changing a note of it');
      m.setAttribute('aria-pressed',String(!!p.muted));
      m.setAttribute('aria-label','Mute '+p.name);
      const s=mk('S',isSoloed(i),()=>toggleSolo(i),'Play only the soloed parts');
      s.setAttribute('aria-pressed',String(isSoloed(i)));
      s.setAttribute('aria-label','Solo '+p.name);
      row.appendChild(m); row.appendChild(s);
    }
    if(parts.length>1){
      const del=el('button','pdel','✕');
      del.setAttribute('aria-label','Delete the '+p.name+' part');
      del.onclick=e=>{e.stopPropagation();deletePart(i);};
      row.appendChild(del);
    }
    row.onclick=()=>{apIdx=i;selectedNote=null;caretGap=null;renderPartsList();render();updateSelectionUI();relabelNoteButtons();};
    ul.appendChild(row);
    // A fader per part, on every row rather than only the active one —
    // balancing a score means moving one part against another, which you
    // cannot do if you have to select a part to reach its level.
    if(parts.length>1){
      const vr=document.createElement('div');
      vr.className='pvol'+(p.muted?' off':'');
      const sl=document.createElement('input');
      sl.type='range'; sl.min='0'; sl.max='100'; sl.step='1';
      sl.value=String(partVolume(p));
      sl.className='pvol-slider';
      sl.setAttribute('aria-label','Volume for '+p.name);
      sl.setAttribute('aria-valuetext',partVolume(p)+' percent');
      const val=el('span','pvol-val',partVolume(p)+'%');
      val.id='pvol-val-'+i;
      // `input` for the live drag, so the number tracks your thumb; the row's
      // own click handler must not fire and steal the active part underneath.
      sl.oninput=e=>{ e.stopPropagation(); setPartVolume(i,+e.target.value); sl.setAttribute('aria-valuetext',e.target.value+' percent'); };
      sl.onclick=e=>e.stopPropagation();
      vr.appendChild(el('span','pvol-icon',p.muted?'🔇':'🔊'));
      vr.appendChild(sl);
      vr.appendChild(val);
      ul.appendChild(vr);
    }
    // Transposition sits under the active part only — it is a per-part
    // property, but showing eight buttons against every row would bury the
    // list it belongs to.
    if(i===apIdx && !(inst.unpitched||inst.drumset||inst.pitchedDrum)){
      const tr=document.createElement('div');
      tr.className='row';
      tr.style.cssText='margin:2px 0 4px;padding-left:6px;flex-wrap:wrap';
      tr.appendChild(el('span','lbl','Transposes'));
      TRANSPOSE_CHOICES.forEach(c=>{
        const b=el('button','chip'+(isTransposing(p)===c.v?' on':''),c.label);
        b.style.fontSize='10px';
        b.onclick=e=>{ e.stopPropagation(); p.transpose=c.v; renderPartsList(); relabelNoteButtons(); render(); };
        tr.appendChild(b);
      });
      const note=el('div','hint','This part sounds in '+transposeLabel(isTransposing(p))
        +(isTransposing(p)?' — its player reads '+partVfSig(p)+' where the score sounds '+(KMAP[currentKeyId]?.label||currentKeyId):''));
      note.style.width='100%';
      tr.appendChild(note);
      ul.appendChild(tr);
    }
  });
  refreshNoteGridForActivePart();
}
// Single-line drums (Snare, Bass Drum) have no real pitch to pick between —
// swap the 7-letter movable-do grid for one big "Hit" button.
function refreshNoteGridForActivePart(){
  const inst=IMAP[parts[apIdx]?.instId]||IMAP.piano;
  const single=inst.staffLines===1;
  document.querySelectorAll('#note-grid .np').forEach(b=>{ if(b.id!=='hit-btn') b.style.display=single?'none':''; });
  document.getElementById('hit-btn').style.display=single?'':'none';
}

// ═══════════════════════════════════════════════════════
// Tab switching
// ═══════════════════════════════════════════════════════
const TABS=['notes','parts','markings','score','proj'];
function switchTab(name){
  document.querySelectorAll('.tab-btn').forEach((b,i)=>b.classList.toggle('on',TABS[i]===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  document.getElementById('panel-'+name).classList.add('on');
  if(name==='parts')renderPartsList();
  if(name==='proj'){renderProjectsList();renderPrintButtons();}
  syncEditorsToSelection();
}
// Collapse/expand the tall control stack (tabs + panel + chord palette) so the
// staff gets almost the whole screen — essential in landscape.
function toggleControls(){
  const collapsed=document.body.classList.toggle('controls-collapsed');
  document.getElementById('collapse-btn').textContent=collapsed?'▲':'▼';
}
function renderPrintButtons(){
  const row=document.getElementById('print-row');
  if(!row)return;
  row.innerHTML='';
  const mk=(label,arg)=>{
    const b=el('button','chip','🖨 '+label);
    b.style.fontSize='11px';
    b.onclick=()=>exportPDF(arg);
    return b;
  };
  row.appendChild(mk('Full Score','all'));
  parts.forEach((p,i)=>{ if(p.notes.length) row.appendChild(mk(p.name,i)); });
}

const SUBTABS=['lyrics','dyn','art','tempo','rud'];
function switchSubTab(name){
  document.querySelectorAll('.subtab-btn').forEach((b,i)=>b.classList.toggle('on',SUBTABS[i]===name));
  document.querySelectorAll('.subpanel').forEach(p=>p.classList.remove('on'));
  document.getElementById('sub-'+name).classList.add('on');
  syncEditorsToSelection();
}

// ═══════════════════════════════════════════════════════
// Notes controls
// ═══════════════════════════════════════════════════════
// The Dur row does double duty: with a note selected it CHANGES that note's
// length (reflowing what follows); with nothing selected it sets the default
// for new notes. refreshDurRow() keeps the row's highlight in sync with either.
function refreshDurRow(){
  const n=selectedNoteAny();
  const d = n ? decomposeDur(n.dur) : {base:selDur,dot:dotted,tupN:tupletMode?tupletN:0};
  ['w','h','q','8','16','32'].forEach(x=>{
    document.getElementById('d-'+x).classList.toggle('on',x===d.base);
    document.getElementById('qe-d-'+x)?.classList.toggle('on',x===d.base);
  });
  document.getElementById('d-dot').classList.toggle('on',d.dot);
  document.getElementById('qe-d-dot')?.classList.toggle('on',d.dot);
  document.getElementById('d-tuplet').classList.toggle('on',!!d.tupN);
  document.getElementById('d-tuplet').textContent=d.tupN||tupletN;
}
function setDur(dNew){
  selDur=dNew;
  document.getElementById('rest-btn').innerHTML=durIcon(selDur,true,dotted);
  const n=selectedNoteAny();
  if(n){ const d=decomposeDur(n.dur); n.dur=composeDur(dNew,d.dot,d.tupN,d.rest); render(); updateSelectionUI(); }
  else refreshDurRow();
}
function toggleDot(){
  dotted=!dotted;
  document.getElementById('rest-btn').innerHTML=durIcon(selDur,true,dotted);
  const n=selectedNoteAny();
  if(n){ const d=decomposeDur(n.dur); n.dur=composeDur(d.base,!d.dot,d.tupN,d.rest); render(); updateSelectionUI(); }
  else refreshDurRow();
}
// Marks the next notes entered (or the selected note) as part of an N-tuplet —
// drawVoice() groups consecutive runs of N same-N-flagged notes under a bracket.
// N itself is set by changeTupletN() below (duplet, triplet, quintuplet, ...).
function toggleTuplet(){
  tupletMode=!tupletMode;
  tupletCount=0;
  const n=selectedNoteAny();
  if(n){ const d=decomposeDur(n.dur); d.tupN=d.tupN?0:tupletN; n.dur=composeDur(d.base,d.dot,d.tupN,d.rest); render(); updateSelectionUI(); }
  else refreshDurRow();
}
function changeTupletN(delta){
  tupletN=Math.max(2,Math.min(9,tupletN+delta));
  tupletCount=0;
  const n=selectedNoteAny();
  if(n){
    const d=decomposeDur(n.dur);
    if(d.tupN){ d.tupN=tupletN; n.dur=composeDur(d.base,d.dot,d.tupN,d.rest); render(); updateSelectionUI(); return; }
  }
  refreshDurRow();
}
function setAcc(a){
  selAcc=a;
  const m={'key':'a-key','n':'a-n','#':'a-s','b':'a-f','##':'a-ss','bb':'a-ff'};
  Object.values(m).forEach(id=>document.getElementById(id).classList.remove('on'));
  if(m[a])document.getElementById(m[a]).classList.add('on');
}
function changeOct(d){selOct=Math.max(-3,Math.min(3,selOct+d));document.getElementById('oct-val').textContent=(selOct>0?'+':selOct<0?'':'±')+selOct;}

// If a (non-rest) note is selected on the staff, Markings edits apply to it directly;
// otherwise they're "pending" and get attached to the next note entered.
function currentEditableNote(){
  if(!selectedNote)return null;
  const n=parts[selectedNote.partIdx]?.notes[selectedNote.noteIdx];
  return (n && !n.rest) ? n : null;
}
// Unlike currentEditableNote(), includes rests — duration editing makes sense
// for a rest too, unlike pitch/marking edits.
function selectedNoteAny(){
  if(!selectedNote)return null;
  return parts[selectedNote.partIdx]?.notes[selectedNote.noteIdx]||null;
}
function highlightDyn(d){document.querySelectorAll('.dyn-btn').forEach(b=>b.classList.remove('on'));const el=d?document.getElementById('dyn-'+d):document.getElementById('dyn-0');if(el)el.classList.add('on');}
// Articulations are multi-select — a note can carry accent + staccato + tenuto etc at once.
const ART_BTN_ID={'a.':'art-st','a>':'art-ac','a-':'art-te','a^':'art-ma','ao':'art-fe','tr':'art-tr','a+':'art-pz'};
function highlightArts(arr){
  document.querySelectorAll('.art-btn').forEach(b=>b.classList.remove('on'));
  document.getElementById('art-0').classList.toggle('on', !arr || !arr.length);
  (arr||[]).forEach(a=>{ if(ART_BTN_ID[a]) document.getElementById(ART_BTN_ID[a]).classList.add('on'); });
}
function highlightTempo(t){
  document.querySelectorAll('.tempo-btn').forEach(b=>b.classList.remove('on'));
  if(!t){document.getElementById('tw-none').classList.add('on');return;}
  const el=document.getElementById('tw-'+t)||document.getElementById('tc-'+t);
  if(el)el.classList.add('on');
}
// Rolls (tremolo/buzz/press) are single-select, like dyn/tempo.
const RUD_BTN_ID={trem1:'rud-r2',trem2:'rud-r4',trem3:'rud-r8',buzz:'rud-buzz',press:'rud-press'};
function highlightRud(v){
  document.querySelectorAll('#sub-rud .art-btn').forEach(b=>b.classList.remove('on'));
  const id=RUD_BTN_ID[v];
  document.getElementById(id||'rud-0').classList.add('on');
}
function highlightSticking(v){
  document.querySelectorAll('#sub-rud .chip').forEach(b=>{ if(b.id&&b.id.startsWith('stick-'))b.classList.remove('on'); });
  document.getElementById(v?'stick-'+v:'stick-0').classList.add('on');
}
function syncEditorsToSelection(){
  const n=currentEditableNote();
  highlightDyn(n?n.dyn:pendingDyn);
  highlightArts(n?n.arts:pendingArts);
  highlightTempo(n?n.tempo:pendingTempo);
  highlightRud(n?n.rud:pendingRud);
  highlightSticking(n?n.sticking:pendingSticking);
  const li=document.getElementById('lyric-inp');
  if(li && document.activeElement!==li) li.value=(n?n.lyric:null)||'';
}
function setDyn(d){
  const n=currentEditableNote();
  if(n){ n.dyn=d; render(); updateSelectionUI(); return; }
  pendingDyn=d; highlightDyn(d);
}
function setRud(v){
  const n=currentEditableNote();
  if(n){ n.rud=v; render(); updateSelectionUI(); return; }
  pendingRud=v; highlightRud(v);
}
function setSticking(v){
  const n=currentEditableNote();
  if(n){ n.sticking=v; render(); updateSelectionUI(); return; }
  pendingSticking=v; highlightSticking(v);
}
function toggleArt(a){
  const n=currentEditableNote();
  if(n){
    n.arts=n.arts||[];
    const i=n.arts.indexOf(a);
    if(i>=0)n.arts.splice(i,1);else n.arts.push(a);
    render(); updateSelectionUI();
    return;
  }
  const i=pendingArts.indexOf(a);
  if(i>=0)pendingArts.splice(i,1);else pendingArts.push(a);
  highlightArts(pendingArts);
}
function clearArts(){
  const n=currentEditableNote();
  if(n){ n.arts=[]; render(); updateSelectionUI(); return; }
  pendingArts=[]; highlightArts(pendingArts);
}
function setTempo(t){
  const n=currentEditableNote();
  if(n){ n.tempo=t; render(); updateSelectionUI(); return; }
  pendingTempo=t; highlightTempo(t);
}
function clearPending(){
  pendingLyric='';pendingDyn=null;pendingArts=[];pendingTempo=null;pendingRud=null;
  document.getElementById('lyric-inp').value='';
  highlightDyn(pendingDyn); highlightArts(pendingArts); highlightTempo(pendingTempo); highlightRud(pendingRud);
}
document.getElementById('lyric-inp').addEventListener('input', function(){
  const n=currentEditableNote();
  if(n){ n.lyric=this.value.trim()||null; render(); }
});

// Grace notes (flam/drag/ruff): arm, then tap letters below to queue — they
// attach to the next note entered. Only settable at entry time, not
// retroactively on an already-placed note (unlike dyn/arts/tempo/rud above).
// Turning grace mode off does NOT clear the queue — the whole point is to
// arm it, tap out the grace notes, disarm it, then tap the main note (a
// normal entry) which picks up and attaches the queued grace notes.
function toggleGraceMode(){
  graceMode=!graceMode;
  document.getElementById('grace-toggle').classList.toggle('on',graceMode);
}
function setGraceDur(d){
  graceDur=d;
  document.getElementById('grace-8').classList.toggle('on',d==='8');
  document.getElementById('grace-16').classList.toggle('on',d==='16');
}
function updateGracePendingDisplay(){
  const el=document.getElementById('grace-pending');
  el.textContent=pendingGraceNotes.length ? 'Queued: '+pendingGraceNotes.map(g=>g.name+(g.acc||'')+g.oct).join(' ') : '';
}
function clearGraceQueue(){ pendingGraceNotes=[]; updateGracePendingDisplay(); }

// ═══════════════════════════════════════════════════════
// Hairpins
// ═══════════════════════════════════════════════════════
function startHairpin(type){hairpinPending={type,partIdx:apIdx,startIdx:parts[apIdx].notes.length};document.getElementById('hp-status').textContent=`${type==='cresc'?'Cresc':'Decresc'} started — enter notes then tap End`;}
function endHairpin(type){
  if(!hairpinPending||hairpinPending.partIdx!==apIdx)hairpinPending={type,partIdx:apIdx,startIdx:0};
  const end=parts[apIdx].notes.length-1;
  if(end>hairpinPending.startIdx){parts[apIdx].hairpins.push({type:hairpinPending.type,start:hairpinPending.startIdx,end});render();}
  hairpinPending=null;document.getElementById('hp-status').textContent='';
}

// ═══════════════════════════════════════════════════════
// Chord palette
// ═══════════════════════════════════════════════════════
function toggleChord7(){
  chord7Mode=!chord7Mode;
  document.getElementById('btn-chord7').classList.toggle('on',chord7Mode);
  renderDiatonicChords();
}
function toggleChordMode(){
  chordBuildMode=!chordBuildMode;
  document.getElementById('btn-chord-mode').classList.toggle('on',chordBuildMode);
  document.getElementById('pending-row').style.display=chordBuildMode?'flex':'none';
  pendingChordNotes=[];updatePendingDisplay();
}
// Build mode is meant to construct ONE chord at a time, not linger as a sticky
// mode — leaving it on after Add/Cancel is what left people stuck unable to
// enter single notes. Both exits return straight to normal note entry.
function exitChordBuildMode(){
  chordBuildMode=false;
  document.getElementById('btn-chord-mode').classList.remove('on');
  document.getElementById('pending-row').style.display='none';
}
function cancelChord(){pendingChordNotes=[];updatePendingDisplay();exitChordBuildMode();}
function commitChord(){
  if(!pendingChordNotes.length)return;
  auditionPreview(pendingChordNotes.map(n=>n.midi), parts[apIdx]?.instId);
  const {lyric,dyn,arts,tempo,rud,grace,sticking}=grabPending();
  insertNoteAtCursor({
    keys:pendingChordNotes.map(n=>n.name+'/'+n.oct),
    dur:buildDur(), vfAccs:pendingChordNotes.map(n=>n.vfAcc??n.acc),
    midiVals:pendingChordNotes.map(n=>n.midi),
    rest:false,lyric,dyn,arts,tempo,rud,grace,sticking
  });
  pendingChordNotes=[];updatePendingDisplay();
  pendingGraceNotes=[];updateGracePendingDisplay();
  exitChordBuildMode();
  render();scrollAfterEntry();
}
function updatePendingDisplay(){
  const s=pendingChordNotes.map(n=>n.name+(n.acc||'')+n.oct).join(' ');
  document.getElementById('pending-display').textContent=s?'Pending: '+s:'';
}

function renderDiatonicChords(){
  // Follows the key in force where you are writing, so after a modulation the
  // palette offers that key's chords rather than the opening one's.
  const kd=KMAP[keyAt(editMeasureIndex())];
  if(!kd)return;
  const grid=document.getElementById('diatonic-grid');
  grid.innerHTML='';
  const romans=kd.mode==='major'?MAJ_ROMANS:MIN_ROMANS;
  const funcs =kd.mode==='major'?MAJ_FUNC :MIN_FUNC;
  // The chords themselves are built in concert pitch — harmony does not move
  // when a part transposes, and the roman numerals are the same either way.
  // The root *letter* is labelled as the player reads it, so the button marked
  // A on a B♭ trumpet is the A that lands on the staff, matching the note grid.
  const wScale=partScale(parts[apIdx],editMeasureIndex());
  for(let deg=0;deg<7;deg++){
    const tones3=buildChordTones(deg,kd.scale,3,false);
    const w=wScale[deg]||[tones3[0].name,tones3[0].acc];
    const rootName=(w[0]||'')+(w[1]||'');
    const btn=document.createElement('div');
    btn.className='dchord-btn dc-'+funcs[deg];
    const top=document.createElement('div');
    top.className='dchord-7';
    top.textContent=chord7Mode?'▶ 7th':'7th';
    top.addEventListener('click', e=>{e.stopPropagation();enterDiatonicChord(deg,kd,true);});
    const bot=document.createElement('div');
    bot.className='dchord-triad';
    bot.appendChild(el('div','dchord-roman',romans[deg]));
    bot.appendChild(el('div','dchord-root',rootName));
    btn.appendChild(top); btn.appendChild(bot);
    btn.addEventListener('click', ()=>enterDiatonicChord(deg,kd,chord7Mode));
    grid.appendChild(btn);
  }
}

function enterDiatonicChord(deg,kd,seventh=false){
  const [rootName,rootAcc]=kd.scale[deg];
  const rootOct=nearestOctaveMidi(rootName,rootAcc,getEntryAnchorMidi(parts[apIdx]))+selOct;
  const tones=buildChordTones(deg,kd.scale,rootOct,seventh);
  if(chordBuildMode){
    tones.forEach(t=>pendingChordNotes.push({...t,vfAcc:null}));
    auditionPreview(tones.map(t=>t.midi), parts[apIdx]?.instId);
    updatePendingDisplay();
    return;
  }
  auditionPreview(tones.map(t=>t.midi), parts[apIdx]?.instId);
  const {lyric,dyn,arts,tempo,rud,grace,sticking}=grabPending();
  insertNoteAtCursor({
    keys:tones.map(t=>t.name+'/'+t.oct),
    dur:buildDur(),
    vfAccs:tones.map(()=>null),
    midiVals:tones.map(t=>t.midi),
    rest:false,lyric,dyn,arts,tempo,rud,grace,sticking
  });
  pendingGraceNotes=[];updateGracePendingDisplay();
  render();scrollAfterEntry();
}
