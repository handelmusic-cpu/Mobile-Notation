// ═══════════════════════════════════════════════════════════════════════
// MōdScore — Song storage, autosave, and every import and export path
// ═══════════════════════════════════════════════════════════════════════
// Part of a single shared script, split across files so a change to one
// concern is not a change inside a five-thousand-line file. These load as
// ordinary scripts, in the order index.html lists them, and share one global
// scope exactly as they did when they were one block — see js/README.md for
// why it is not ES modules.

// ═══════════════════════════════════════════════════════
// Song store (IndexedDB, with localStorage as the fallback)
// ═══════════════════════════════════════════════════════
// Every song lived in one localStorage string against a ~5MB origin quota. At
// ~190 KB for a 1200-note piece that is roughly twenty songs before the (well
// handled) "storage full" path starts firing, and every save rewrote every
// song. IndexedDB holds one record per song, so the ceiling goes away and a
// save costs the song you edited.
//
// localStorage stays as the fallback for browsers where IndexedDB is blocked —
// which is the same set of privacy settings safeStore already handles — so
// there is always somewhere to write.
const IDB_NAME='modscore', IDB_STORE='songs', IDB_VERSION=1;
let _idb=null, _idbReady=null;
function idbOpen(){
  if(_idbReady) return _idbReady;
  _idbReady=new Promise(resolve=>{
    let req;
    try{ req=indexedDB.open(IDB_NAME,IDB_VERSION); }
    catch(e){ resolve(null); return; }
    if(!req){ resolve(null); return; }
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE,{keyPath:'id'});
    };
    req.onsuccess=()=>{ _idb=req.result; resolve(_idb); };
    req.onerror=()=>resolve(null);
    req.onblocked=()=>resolve(null);
    // Private-mode Firefox can leave the request hanging rather than failing.
    setTimeout(()=>resolve(_idb),3000);
  });
  return _idbReady;
}
function idbTx(mode){
  if(!_idb) return null;
  try{ return _idb.transaction(IDB_STORE,mode).objectStore(IDB_STORE); }catch(e){ return null; }
}
function idbPut(rec){
  return new Promise(resolve=>{
    const st=idbTx('readwrite'); if(!st) return resolve(false);
    const r=st.put(rec);
    r.onsuccess=()=>resolve(true);
    r.onerror=()=>resolve(false);
  });
}
function idbDelete(id){
  return new Promise(resolve=>{
    const st=idbTx('readwrite'); if(!st) return resolve(false);
    const r=st.delete(id);
    r.onsuccess=()=>resolve(true);
    r.onerror=()=>resolve(false);
  });
}
function idbGetAll(){
  return new Promise(resolve=>{
    const st=idbTx('readonly'); if(!st) return resolve(null);
    const r=st.getAll();
    r.onsuccess=()=>resolve(r.result||[]);
    r.onerror=()=>resolve(null);
  });
}

// ═══════════════════════════════════════════════════════
// Projects + autosave
// ═══════════════════════════════════════════════════════
let projects=[]; let currentProjId=null; let autosaveT=null;

// The document's shape, referencing the live objects. Cheap to build and safe
// to stringify; anything that will outlive this moment must take a copy.
function projectShape(){
  return {
    parts,
    pid, apIdx,
    keyId:currentKeyId,
    timeSig:currentTimeSig.sig,
    keyChanges,
    sigChanges,
    pickupBeats,
    bpm:parseInt(document.getElementById('bpm-inp').value)||80,
    repeatStartMeasures,
    repeatEndMeasures
  };
}
// A detached copy, for storing in a project or writing to a file.
function serializeProject(){ return JSON.parse(JSON.stringify(projectShape())); }
// Autosave used to swallow every error, including the QuotaExceededError you
// get once browser storage fills up. The Songs tab promises your work is
// saved in the browser, so a silent failure there is silent data loss — the
// one outcome this app must never produce quietly.
let saveFailed=false, saveFailAlerted=false;
function updateSaveWarn(){
  const el=document.getElementById('save-warn');
  if(el) el.style.display=saveFailed?'inline-block':'none';
}
// Which songs still need writing. Saving one song should not rewrite the
// others, so the dirty set is drained rather than the whole list dumped.
const dirtySongs=new Set();
let idbUsable=false;
function saveAll(ids){
  safeStore.set('mn_current',currentProjId||'');
  if(ids) ids.forEach(i=>dirtySongs.add(i)); else projects.forEach(p=>dirtySongs.add(p.id));
  if(idbUsable){
    const pending=[...dirtySongs]; dirtySongs.clear();
    Promise.all(pending.map(id=>{
      const p=projects.find(x=>x.id===id);
      return p?idbPut({id:p.id,name:p.name,data:p.data,updated:p.updated}):idbDelete(id);
    })).then(results=>{
      const failed=results.some(r=>r===false);
      if(failed!==saveFailed){ saveFailed=failed; updateSaveWarn(); }
      if(failed) warnSaveFailure();
    });
    return;
  }
  // No IndexedDB — fall back to the single localStorage blob.
  dirtySongs.clear();
  const e1=safeStore.set('mn_projects',JSON.stringify(projects));
  if(!e1){
    if(saveFailed){ saveFailed=false; updateSaveWarn(); }
    return;
  }
  if(!saveFailed){ saveFailed=true; updateSaveWarn(); }
  warnSaveFailure();
}
function warnSaveFailure(){
  // Once per session — the pill carries the state from then on, and an
  // alert on every keystroke would be worse than the problem.
  if(!saveFailAlerted){
    saveFailAlerted=true;
    const why=safeStore.blocked
      ? "This song can't be auto-saved — your browser is blocking storage for this site.\n\nIn Safari that's Settings → Safari → Block All Cookies, or Private Browsing."
      : "This song can't be auto-saved — your browser's storage for this site is full.";
    setTimeout(()=>sheetTell("Can't save this song",why+"\n\nYour work is still here for now, but it won't survive a reload. Use Songs → “⇩ Save to device” to keep a copy."),0);
  }
}
let autosavePending=false;
function writeCurrentProject(){
  autosavePending=false;
  const p=projects.find(x=>x.id===currentProjId);
  if(!p) return;
  p.data=serializeProject(); p.updated=Date.now(); saveAll([p.id]);
  if(document.getElementById('panel-proj').classList.contains('on')) renderProjectsList();
}
function scheduleAutosave(){
  autosavePending=true;
  clearTimeout(autosaveT);
  autosaveT=setTimeout(writeCurrentProject,500);
}
// Swiping a phone app away mid-bar is not an edge case — it is how apps get
// closed, and iOS discards backgrounded web views without warning. The 500ms
// debounce that keeps typing cheap is exactly 500ms of work to lose, so the
// pending write is forced out synchronously the moment the page goes away.
function flushAutosave(){
  if(!autosavePending) return;
  clearTimeout(autosaveT);
  writeCurrentProject();
  // An IndexedDB write is asynchronous, and a page being torn down may not
  // live long enough to commit one — which would undo the whole point of
  // flushing here. localStorage is synchronous, so the song in progress also
  // goes there as a recovery record, and the next boot folds it back in.
  if(idbUsable){
    const p=projects.find(x=>x.id===currentProjId);
    if(p) safeStore.set('mn_pending',JSON.stringify({id:p.id,name:p.name,data:p.data,updated:p.updated}));
  }
}
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='hidden') flushAutosave(); });
window.addEventListener('pagehide', flushAutosave);
function updateProjPill(){ const p=projects.find(x=>x.id===currentProjId); document.getElementById('proj-pill').textContent=p?p.name:'Song'; }

// Migrate notes saved before articulations became multi-select (singular `art` -> `arts` array).
function normalizeNote(n){
  if(n.arts===undefined){ n.arts=n.art?[n.art]:[]; delete n.art; }
  return n;
}
function applyProject(d){
  // Songs written before transposition existed carry no `transpose`, and
  // everything in them was entered at concert pitch — so a saved trumpet part
  // must keep sounding where it was written. Only parts created since then
  // inherit their instrument's default.
  parts=(d.parts||[]).map(p=>({...p,hairpins:p.hairpins||[],transpose:p.transpose||0,
    volume:(p.volume==null?100:p.volume),muted:!!p.muted,notes:(p.notes||[]).map(normalizeNote)}));
  // Solo is a listening gesture, not part of the song — never carry one in
  // from a saved file, or a score reopens with most of it inexplicably silent.
  soloParts=new Set();
  if(!parts.length) parts=[mkPart('Treble','piano','treble'),mkPart('Bass','piano','bass')];
  pid=d.pid||(Math.max(0,...parts.map(p=>p.id||0))+1);
  apIdx=Math.min(d.apIdx||0,parts.length-1);
  currentKeyId=d.keyId||'C';
  currentTimeSig=TIME_SIGS.find(t=>t.sig===d.timeSig)||TIME_SIGS[0];
  keyChanges=d.keyChanges?{...d.keyChanges}:{};
  sigChanges=d.sigChanges?{...d.sigChanges}:{};
  pickupBeats=d.pickupBeats||0;
  document.getElementById('bpm-inp').value=d.bpm||80;
  repeatStartMeasures=d.repeatStartMeasures?d.repeatStartMeasures.slice():[];
  repeatEndMeasures=d.repeatEndMeasures?d.repeatEndMeasures.slice():[];
  syncKeyTimeUI();
  applyKeyHue();   // loading a song in a new key repaints the chord palette
  relabelNoteButtons();
  renderDiatonicChords();
  selectedNote=null; caretGap=null; updateSelectionUI(); updateProjPill();
  renderPartsList(); render();
}

// Offline backup: write the current song to a downloadable JSON file, and read
// one back in as a new song. Independent of localStorage, so work survives
// clearing browser data or moving between devices.
// Getting a file off the device.
//
// A download lands in the downloads folder, which on a phone is close to the
// least useful place for it — the actual job is "send this part to my section
// leader". Where the system share sheet can take files it is offered first,
// since that is the one flow that reaches Messages, Mail, AirDrop and Files;
// where it cannot, this falls back to the download that was always here.
async function deliverFile(blob,filename,shareTitle){
  const file=(typeof File!=='undefined')?new File([blob],filename,{type:blob.type}):null;
  if(file&&navigator.canShare&&navigator.canShare({files:[file]})&&navigator.share){
    try{
      await navigator.share({files:[file],title:shareTitle||filename});
      return 'shared';
    }catch(e){
      // A cancelled share is a decision, not a failure — do not then shove a
      // download at someone who just backed out.
      if(e&&(e.name==='AbortError'||e.name==='NotAllowedError')) return 'cancelled';
    }
  }
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
  return 'downloaded';
}
function songFileName(){ return ((projects.find(p=>p.id===currentProjId)?.name)||'song').replace(/[^a-z0-9]+/gi,'_'); }
async function saveProjectToFile(){
  const proj=projects.find(p=>p.id===currentProjId);
  const payload={ app:'modscore', version:1, name:(proj?proj.name:'Song'), data:serializeProject() };
  const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});
  const nm=((proj?proj.name:'song')||'song').replace(/[^a-z0-9]+/gi,'_');
  const how=await deliverFile(blob,nm+'.mnote.json',(proj?proj.name:'Song'));
  if(how==='downloaded') toast('Saved '+nm+'.mnote.json to your device.');
}
function openProjectFromFile(){ const inp=document.getElementById('project-file'); inp.value=''; inp.click(); }
document.getElementById('project-file').addEventListener('change', async function(){
  const f=this.files[0]; if(!f)return;
  try{
    const payload=JSON.parse(await f.text());
    const data=payload && payload.data ? payload.data : payload; // tolerate a bare data object
    if(!data || !Array.isArray(data.parts)) throw new Error('Not a MōdScore song file');
    const id='p'+Date.now();
    const name=(payload.name||f.name.replace(/\.(mnote\.)?json$/i,'')||'Imported song');
    projects.push({id,name,data,updated:Date.now()});
    currentProjId=id; saveAll(); applyProject(data); resetHistory(); renderProjectsList(); switchTab('notes');
  }catch(e){ toast('Could not open that file: '+e.message,'err'); }
});

function newProject(name){
  const id='p'+Date.now();
  const blank={
    parts:[ mkPart('Treble','piano','treble'), mkPart('Bass','piano','bass') ].map(p=>JSON.parse(JSON.stringify(p))),
    pid:pid, apIdx:0, keyId:'C', timeSig:'4/4', bpm:80
  };
  projects.push({id,name:name||('Song '+(projects.length+1)),data:blank,updated:Date.now()});
  currentProjId=id; saveAll(); applyProject(blank); resetHistory(); renderProjectsList();
}
async function newProjectPrompt(){
  const nm=await sheetAsk('New song','What should it be called?','Song '+(projects.length+1),'Song name');
  if(nm!==null){ newProject(nm.trim()||undefined); switchTab('notes'); }
}
function loadProject(id){
  const p=projects.find(x=>x.id===id); if(!p)return;
  const cur=projects.find(x=>x.id===currentProjId); if(cur) cur.data=serializeProject();
  currentProjId=id; saveAll(); applyProject(p.data); resetHistory(); renderProjectsList(); switchTab('notes');
}
async function renameProject(id){
  const p=projects.find(x=>x.id===id); if(!p)return;
  const nm=await sheetAsk('Rename song',null,p.name,'Song name');
  if(nm!==null&&nm.trim()){ p.name=nm.trim(); saveAll([p.id]); renderProjectsList(); updateProjPill(); }
}
async function deleteProject(id){
  if(projects.length<=1){toast('Keep at least one song.','warn');return;}
  if(!await sheetConfirm('Delete this song?','“'+(projects.find(x=>x.id===id)?.name||'This song')+'” is removed from this device. This cannot be undone.','Delete',true))return;
  projects=projects.filter(x=>x.id!==id);
  if(currentProjId===id){ currentProjId=projects[0].id; applyProject(projects[0].data); resetHistory(); }
  if(idbUsable) idbDelete(id); else safeStore.set('mn_projects',JSON.stringify(projects));
  saveAll([currentProjId]); renderProjectsList();
}
function renderProjectsList(){
  const ul=document.getElementById('proj-list'); if(!ul)return; ul.innerHTML='';
  projects.slice().sort((a,b)=>(b.updated||0)-(a.updated||0)).forEach(p=>{
    const row=document.createElement('div');
    row.className='prow'+(p.id===currentProjId?' ap':'');
    const nNotes=(p.data.parts||[]).reduce((s,pt)=>s+((pt.notes||[]).length),0);
    const kLabel=KMAP[p.data.keyId]?.label||p.data.keyId||'C';
    const info=document.createElement('div'); info.style.cssText='display:flex;align-items:center;gap:5px;flex:1;overflow:hidden;';
    info.appendChild(el('div','pdot'));
    info.appendChild(el('span','pname',p.name));
    info.appendChild(el('span','pinst',kLabel+' · '+nNotes+' notes'));
    info.onclick=()=>loadProject(p.id);
    const ren=document.createElement('button'); ren.className='pdel'; ren.style.color='#f0c040'; ren.textContent='✎';
    ren.onclick=(e)=>{e.stopPropagation();renameProject(p.id);};
    const del=document.createElement('button'); del.className='pdel'; del.textContent='✕';
    del.onclick=(e)=>{e.stopPropagation();deleteProject(p.id);};
    row.appendChild(info); row.appendChild(ren); row.appendChild(del);
    ul.appendChild(row);
  });
}
// Boot without waiting on a database. Before the upgrade there is a
// localStorage blob to read; after it, that blob is deliberately left frozen
// (so rolling this build back does not lose anything) and is therefore stale —
// mn_store records which of the two is authoritative so a stale song is never
// shown. Whichever it is, the first paint happens immediately and IndexedDB
// fills in a moment later.
let _wantedProjId=null, bootAppliedId=null;
function makeFirstSong(){
  const id='p'+Date.now();
  projects=[{id,name:'My First Song',data:serializeProject(),updated:Date.now()}];
  currentProjId=id; bootAppliedId=id; saveAll(); updateProjPill();
}
function initProjects(){
  const idbMode=safeStore.get('mn_store')==='idb';
  _wantedProjId=safeStore.get('mn_current')||null;
  if(!idbMode){
    try{ const raw=safeStore.get('mn_projects'); if(raw) projects=JSON.parse(raw)||[]; }catch(e){ projects=[]; }
    if(!Array.isArray(projects)) projects=[];
  } else {
    projects=[];   // the database owns the songs; it is opening now
  }
  currentProjId=_wantedProjId;
  if(projects.length){
    const p=projects.find(x=>x.id===currentProjId)||projects[0];
    currentProjId=p.id; bootAppliedId=p.id; applyProject(p.data);
  } else if(!idbMode){
    makeFirstSong();
  }
  resetHistory();
  upgradeToIDB();
}
async function upgradeToIDB(){
  const db=await idbOpen();
  if(!db){                              // blocked or unsupported
    if(!projects.length) makeFirstSong();
    return;
  }
  const stored=await idbGetAll();
  if(stored===null){
    if(!projects.length) makeFirstSong();
    return;
  }
  idbUsable=true;
  // Fold in anything the last teardown managed to write synchronously but not
  // commit to the database.
  const pendingRaw=safeStore.get('mn_pending');
  if(pendingRaw){
    try{
      const rec=JSON.parse(pendingRaw);
      if(rec&&rec.id){
        const at=stored.findIndex(r=>r.id===rec.id);
        if(at<0) stored.push(rec);
        else if((rec.updated||0)>(stored[at].updated||0)) stored[at]=rec;
        await idbPut(rec);
      }
    }catch(e){}
    safeStore.set('mn_pending','');
  }
  const byId=new Map(stored.map(r=>[r.id,r]));
  // Anything held in memory the database has not seen — the first run after
  // the upgrade, or a song written while the database was unavailable.
  const toMigrate=projects.filter(p=>!byId.has(p.id));
  if(toMigrate.length) await Promise.all(toMigrate.map(p=>idbPut({id:p.id,name:p.name,data:p.data,updated:p.updated})));
  // Keep whichever copy of a song is newer, except the one being edited: that
  // one is live and may already have changes the database has not caught.
  const merged=[]; const seen=new Set();
  projects.forEach(p=>{
    const rec=byId.get(p.id);
    merged.push(rec&&(rec.updated||0)>(p.updated||0)&&p.id!==currentProjId?rec:p);
    seen.add(p.id);
  });
  stored.forEach(r=>{ if(!seen.has(r.id)) merged.push(r); });
  merged.sort((a,b)=>(b.updated||0)-(a.updated||0));
  projects=merged;
  if(!projects.length){ makeFirstSong(); safeStore.set('mn_store','idb'); return; }

  // Show the song that was actually open last time. Only when nothing has been
  // typed yet — an edit made in the moment before the database opened must
  // never be thrown away by the handover.
  const want=projects.find(p=>p.id===_wantedProjId)||projects[0];
  if(want && want.id!==bootAppliedId && history.length<=1){
    currentProjId=want.id;
    applyProject(want.data);
    resetHistory();
    bootAppliedId=want.id;
  } else if(!projects.find(p=>p.id===currentProjId)){
    currentProjId=projects[0].id;
  }
  safeStore.set('mn_store','idb');
  renderProjectsList();
  updateProjPill();
}

// ═══════════════════════════════════════════════════════
// MIDI file export (Standard MIDI File, format 1)
// ═══════════════════════════════════════════════════════
function vlq(n){ const b=[n&0x7F]; n=Math.floor(n/128); while(n>0){ b.unshift((n&0x7F)|0x80); n=Math.floor(n/128);} return b; }
function buildTrack(events){
  let data=[];
  events.forEach(e=>{ data.push(...vlq(e.d)); data.push(...e.bytes); });
  data.push(0x00,0xFF,0x2F,0x00);
  const len=data.length;
  return [0x4D,0x54,0x72,0x6B,(len>>24)&255,(len>>16)&255,(len>>8)&255,len&255,...data];
}
function exportMIDI(){
  const PPQ=480;
  const bpm=parseInt(document.getElementById('bpm-inp').value)||80;
  const tracks=[];
  // The export walked part.notes raw while playback walked the expanded repeat
  // order, so the file disagreed with what you had just listened to. Both read
  // the same order and the same velocities now.
  const allM=parts.map(p=>toMeasures(p.notes));
  const numM=Math.max(...allM.map(m=>m.length),1);
  const playOrder=buildPlayOrder(numM);

  // Tempo / meta track, carrying every metre change and tempo word. Collected
  // at absolute ticks and only then turned into deltas — two separate running
  // deltas cannot be interleaved into one stream.
  const meta=[];
  let mBeat=0, lastSig=null;
  playOrder.forEach(mi=>{
    const ts=timeSigAt(mi);
    if(ts.sig!==lastSig){
      lastSig=ts.sig;
      meta.push({tick:Math.round(mBeat*PPQ),bytes:[0xFF,0x58,0x04,ts.vfB,Math.round(Math.log2(ts.vfV)),24,8]});
    }
    mBeat+=measureBeatsOf(allM,mi);
  });
  const tempoMap=buildTempoMap(playOrder,allM,bpm);
  let lastBpm=null;
  tempoMap.forEach(pt=>{
    const b=Math.round(pt.bpm);
    if(b===lastBpm) return;
    lastBpm=b;
    const mpq=Math.round(60000000/Math.max(1,b));
    meta.push({tick:Math.round(pt.beat*PPQ),bytes:[0xFF,0x51,0x03,(mpq>>16)&255,(mpq>>8)&255,mpq&255]});
  });
  meta.sort((a,b)=>a.tick-b.tick);
  const t0=[]; let metaLast=0;
  meta.forEach(m=>{ t0.push({d:Math.max(0,m.tick-metaLast),bytes:m.bytes}); metaLast=m.tick; });
  tracks.push(buildTrack(t0));

  // Part tracks
  let chNext=0;
  parts.forEach((part,pi)=>{
    const inst=IMAP[part.instId]||IMAP['piano'];
    const vels=velocityMap(part);
    const raw=[];
    let bt=0;
    playOrder.forEach(mi=>{
      resolveMeasureNotes(allM[pi],mi).forEach(n=>{
        const beats=durBeats(n.dur);
        const soundBeats=(n.soundBeats!=null)?n.soundBeats:beats;
        const tick=Math.round(bt*PPQ);
        if(!n.rest && !n.repeatBars && !n.tieFrom && (n.midiVals||[]).length){
          const vel=Math.max(1,Math.min(127,Math.round(((n.srcIdx!=null&&vels[n.srcIdx]!=null)?vels[n.srcIdx]:DEFAULT_VEL)*127)));
          const hold=articulationHold(n);
          const dt=Math.max(1,Math.round(soundBeats*PPQ*hold));
          // Grace notes sound just before the beat, as they do on playback.
          (n.grace||[]).forEach((g,gi,arr)=>{
            if(g.midi==null) return;
            const gt=Math.max(0,tick-(arr.length-gi)*Math.round(PPQ*0.06));
            raw.push({tick:gt,on:1,midi:g.midi,vel:Math.round(vel*0.7)});
            raw.push({tick:gt+Math.round(PPQ*0.05),on:0,midi:g.midi,vel:0});
          });
          const ROLL_HITS={trem1:2,trem2:4,trem3:8,buzz:16,press:20};
          const hits=ROLL_HITS[n.rud];
          if(hits){
            const step=Math.max(1,Math.round(beats*PPQ/hits));
            for(let k=0;k<hits;k++){
              n.midiVals.forEach(m=>{
                raw.push({tick:tick+k*step,on:1,midi:m,vel});
                raw.push({tick:tick+k*step+Math.max(1,Math.round(step*0.85)),on:0,midi:m,vel:0});
              });
            }
          } else {
            n.midiVals.forEach(m=>{
              raw.push({tick,on:1,midi:m,vel});
              raw.push({tick:tick+dt,on:0,midi:m,vel:0});
            });
          }
        }
        bt+=beats;
      });
    });
    raw.sort((a,b)=> a.tick-b.tick || a.on-b.on);
    // Percussion belongs on channel 10 (index 9) or a DAW plays the drums back
    // as piano notes. Everything else takes the next melodic channel.
    const perc=inst.unpitched||inst.drumset||inst.pitchedDrum;
    let ch;
    if(perc) ch=9;
    else { ch=chNext%16; if(ch===9) ch=(++chNext)%16; chNext++; }
    const evs=[];
    const nameB=Array.from(new TextEncoder().encode(part.name)).slice(0,64);
    evs.push({d:0,bytes:[0xFF,0x03,nameB.length,...nameB]});
    if(!perc) evs.push({d:0,bytes:[0xC0|ch,(inst.gm||0)&0x7F]});
    // The mix travels with the file as channel volume (CC 7), so a score that
    // was balanced here opens balanced in a DAW. Mute is deliberately not
    // exported: it is a listening decision about this session, and the whole
    // point of muting rather than deleting is that the part is still there.
    evs.push({d:0,bytes:[0xB0|ch,7,Math.max(0,Math.min(127,Math.round(partVolume(part)/100*127)))]});
    let last=0;
    raw.forEach(e=>{ const d=e.tick-last; last=e.tick; evs.push({d,bytes:[(e.on?0x90:0x80)|ch, e.midi&0x7F, e.on?(e.vel||90):0]}); });
    tracks.push(buildTrack(evs));
  });
  const ntrk=tracks.length;
  const header=[0x4D,0x54,0x68,0x64,0,0,0,6,0,1,(ntrk>>8)&255,ntrk&255,(PPQ>>8)&255,PPQ&255];
  const u8=new Uint8Array([...header,...tracks.flat()]);
  const blob=new Blob([u8],{type:'audio/midi'});
  const name=songFileName();
  deliverFile(blob,name+'.mid',name+' (MIDI)').then(how=>{ if(how==='downloaded') toast('Saved '+name+'.mid to your device.'); });
}

// ═══════════════════════════════════════════════════════
// MusicXML export
// ═══════════════════════════════════════════════════════
// Import handled MusicXML and export did not, which made this app a place
// sketches went to stay — you could not carry one into MuseScore, Sibelius,
// Dorico or Finale to finish it. Written from the same toMeasures() output the
// renderer draws, so what is exported is what is on screen: barlines where the
// score puts them, ties where notes cross them.
const XML_TYPE_OUT={w:'whole',h:'half',q:'quarter','8':'eighth','16':'16th','32':'32nd'};
const ART_TO_XML={'a.':'staccato','a>':'accent','a-':'tenuto','a^':'strong-accent'};
const XML_DIVISIONS=48;   // divisions per quarter note; 48 covers triplets and 32nds
function keyFifthsOf(keyId){ return MAJOR_TO_FIFTHS[KMAP[keyId]?.vfSig]??0; }
function buildMusicXML(){
  const bpm=parseInt(document.getElementById('bpm-inp').value)||80;
  const title=projects.find(p=>p.id===currentProjId)?.name||'Score';
  const allM=parts.map(p=>toMeasures(p.notes));
  const numM=Math.max(...allM.map(m=>m.length),1);
  const out=[];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="3.1">');
  out.push('<work><work-title>'+esc(title)+'</work-title></work>');
  out.push('<identification><encoding><software>MōdScore</software></encoding></identification>');
  out.push('<part-list>');
  parts.forEach((p,pi)=>{
    const inst=IMAP[p.instId]||IMAP.piano;
    out.push('<score-part id="P'+(pi+1)+'">');
    out.push('<part-name>'+esc(p.name)+'</part-name>');
    out.push('<score-instrument id="P'+(pi+1)+'-I1"><instrument-name>'+esc(inst.label)+'</instrument-name></score-instrument>');
    out.push('<midi-instrument id="P'+(pi+1)+'-I1"><midi-channel>'+((inst.unpitched||inst.drumset||inst.pitchedDrum)?10:((pi%15)+1))+'</midi-channel><midi-program>'+((inst.gm||0)+1)+'</midi-program></midi-instrument>');
    out.push('</score-part>');
  });
  out.push('</part-list>');

  parts.forEach((part,pi)=>{
    out.push('<part id="P'+(pi+1)+'">');
    const semis=isTransposing(part);
    let prevKey=null, prevSig=null;
    for(let mi=0;mi<numM;mi++){
      const ts=timeSigAt(mi), kid=keyAt(mi);
      out.push('<measure number="'+(mi+1)+'">');
      const attrs=[];
      if(mi===0||kid!==prevKey){
        // MusicXML keys are written as the part reads them, and <transpose>
        // says how to get back to concert — the same split the app draws.
        attrs.push('<key><fifths>'+transposeFifths(keyFifthsOf(kid),semis)+'</fifths><mode>'+((KMAP[kid]?.mode)||'major')+'</mode></key>');
      }
      if(mi===0||ts.sig!==prevSig){
        attrs.push('<time><beats>'+ts.vfB+'</beats><beat-type>'+ts.vfV+'</beat-type></time>');
      }
      if(mi===0){
        attrs.unshift('<divisions>'+XML_DIVISIONS+'</divisions>');
        const cl=partClefFor(part);
        const clef=cl==='bass'?['F',4]:cl==='alto'?['C',3]:cl==='percussion'?['percussion',2]:['G',2];
        attrs.push('<clef>'+(clef[0]==='percussion'?'<sign>percussion</sign><line>2</line>':'<sign>'+clef[0]+'</sign><line>'+clef[1]+'</line>')+'</clef>');
        if(semis){
          // MusicXML's chromatic is what you add to the *written* pitch to get
          // the sounding one, so it is the opposite sign to our `transpose`.
          // Anything past an octave goes in octave-change, with chromatic
          // holding only the remainder — that is the convention readers expect.
          const chrom=-semis;
          const octCh=Math.trunc(chrom/12), rem=chrom-octCh*12;
          const DIA={0:0,1:0,2:1,3:2,4:2,5:3,6:3,7:4,8:4,9:5,10:6,11:6};
          const dia=(rem<0?-DIA[-rem]:DIA[rem])+octCh*7;
          attrs.push('<transpose><diatonic>'+dia+'</diatonic><chromatic>'+rem+'</chromatic>'
            +(octCh?'<octave-change>'+octCh+'</octave-change>':'')+'</transpose>');
        }
      }
      if(attrs.length) out.push('<attributes>'+attrs.join('')+'</attributes>');
      if(mi===0&&pi===0) out.push('<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>'+bpm+'</per-minute></metronome></direction-type><sound tempo="'+bpm+'"/></direction>');
      prevKey=kid; prevSig=ts.sig;

      (allM[pi][mi]||[]).forEach(n=>{
        if(n.repeatBars){
          // No stored notes to write; emit a whole-measure rest so the bar
          // still holds its time in another program.
          out.push('<note><rest measure="yes"/><duration>'+Math.round(beatsAt(mi)*XML_DIVISIONS)+'</duration><voice>1</voice></note>');
          return;
        }
        const d=decomposeDur(n.dur);
        const beats=durBeats(n.dur);
        const dur=Math.max(1,Math.round(beats*XML_DIVISIONS));
        const type=XML_TYPE_OUT[d.base]||'quarter';
        if(n.rest){
          out.push('<note><rest/><duration>'+dur+'</duration><voice>1</voice><type>'+type+'</type>'+(d.dot?'<dot/>':'')+'</note>');
          return;
        }
        // Directions attach at the point they appear in the stream, so a
        // dynamic or tempo word has to be written before the note it marks.
        if(n.dyn&&!n.tieFrom) out.push('<direction placement="below"><direction-type><dynamics><'+n.dyn+'/></dynamics></direction-type></direction>');
        if(n.tempo&&!n.tieFrom) out.push('<direction placement="above"><direction-type><words font-style="italic">'+esc(n.tempo)+'</words></direction-type></direction>');
        // Spelled exactly as it is drawn — including whatever enharmonic the
        // user chose — with alter derived from the pitch rather than re-guessed.
        const disp=displayKeys(n,part,mi);
        n.midiVals.forEach((m,ci)=>{
          const written=m+semis;
          const kk=String((disp.keys||[])[ci]||'C/4').split('/');
          const step=(kk[0]||'C').toUpperCase();
          const oct=parseInt(kk[1]);
          const alter=(NOTE_SEMI[step]!=null&&!isNaN(oct))?written-noteToMidi(step,null,oct):0;
          const bits=[];
          if(ci>0) bits.push('<chord/>');
          bits.push('<pitch><step>'+step+'</step>'+(alter?'<alter>'+alter+'</alter>':'')+'<octave>'+oct+'</octave></pitch>');
          bits.push('<duration>'+dur+'</duration>');
          if(n.tieFrom) bits.push('<tie type="stop"/>');
          if(n.tieTo)   bits.push('<tie type="start"/>');
          bits.push('<voice>1</voice><type>'+type+'</type>');
          if(d.dot) bits.push('<dot/>');
          const dispAcc=(disp.vfAccs||[])[ci];
          if(dispAcc&&dispAcc!=='n') bits.push('<accidental>'+(dispAcc==='#'?'sharp':dispAcc==='b'?'flat':dispAcc==='##'?'double-sharp':'flat-flat')+'</accidental>');
          else if(dispAcc==='n') bits.push('<accidental>natural</accidental>');
          if(d.tupN){
            const occ=tupletOccupied(d.tupN);
            bits.push('<time-modification><actual-notes>'+d.tupN+'</actual-notes><normal-notes>'+occ+'</normal-notes></time-modification>');
          }
          const notations=[];
          if(n.tieFrom) notations.push('<tied type="stop"/>');
          if(n.tieTo)   notations.push('<tied type="start"/>');
          const arts=(n.arts||[]).map(a=>ART_TO_XML[a]).filter(Boolean);
          if(arts.length) notations.push('<articulations>'+arts.map(a=>'<'+a+'/>').join('')+'</articulations>');
          if((n.arts||[]).includes('ao')) notations.push('<fermata/>');
          if((n.arts||[]).includes('tr')) notations.push('<ornaments><trill-mark/></ornaments>');
          if(notations.length) bits.push('<notations>'+notations.join('')+'</notations>');
          if(ci===0&&n.lyric) bits.push('<lyric number="1"><syllabic>single</syllabic><text>'+esc(n.lyric)+'</text></lyric>');
          out.push('<note>'+bits.join('')+'</note>');
        });
      });
      // Repeat barlines
      if(repeatStartMeasures.includes(mi)) out.push('<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>');
      if(repeatEndMeasures.includes(mi))   out.push('<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>');
      out.push('</measure>');
    }
    out.push('</part>');
  });
  out.push('</score-partwise>');
  return out.join('\n');
}
function exportMusicXML(){
  if(!parts.some(p=>p.notes.length)){ toast('Nothing to export yet — write some notes first.','warn'); return; }
  const xml=buildMusicXML();
  const blob=new Blob([xml],{type:'application/vnd.recordare.musicxml+xml'});
  const name=songFileName();
  deliverFile(blob,name+'.musicxml',name+' (MusicXML)').then(how=>{ if(how==='downloaded') toast('Saved '+name+'.musicxml to your device.'); });
}

// ═══════════════════════════════════════════════════════
// PDF / print export
// ═══════════════════════════════════════════════════════
// Lays a set of parts out as printed sheet music: measures are packed into
// width-budgeted "systems" (lines), each drawn as its own small SVG, instead
// of the single continuous strip the on-screen view uses. The print document
// stacks these with CSS break-inside:avoid so the browser paginates cleanly
// between systems and never slices one in half across a page.
const PRINT_SYS_W=720; // ~ usable Letter-page width in CSS px at 96dpi after 14mm margins
function buildPrintSystems(partsSubset){
  const VF=Vex.Flow;
  const {Renderer,Stave,StaveConnector,StaveHairpin,Barline}=VF;
  const kd=KMAP[currentKeyId];
  const allM=partsSubset.map(p=>toMeasures(p.notes));
  const numM=Math.max(...allM.map(m=>m.length),1);
  const numP=partsSubset.length;
  const partClefs=partsSubset.map(partClefFor);
  const mws=Array.from({length:numM},(_,mi)=>calcMW(allM,mi));

  const systems=[]; let cur=[], curW=0;
  for(let mi=0;mi<numM;mi++){
    const w=cur.length===0?mws[mi]+FX:mws[mi];
    if(cur.length&&curW+w>PRINT_SYS_W){ systems.push(cur); cur=[]; curW=0; }
    cur.push(mi); curW+=(cur.length===1?mws[mi]+FX:mws[mi]);
  }
  if(cur.length)systems.push(cur);

  const partOffsets=new Array(numP).fill(0);
  const vfRefs=partsSubset.map(()=>({}));
  const svgBlocks=[];

  systems.forEach(measureIdxs=>{
    const sysW=FX+measureIdxs.reduce((s,mi)=>s+mws[mi],0)+20;
    const sysH=TP+numP*PG+20;
    const div=document.createElement('div');
    const renderer=new Renderer(div,Renderer.Backends.SVG);
    renderer.resize(sysW,sysH);
    const ctx=renderer.getContext();
    const rangeStart=partOffsets.slice();

    let x=10;
    measureIdxs.forEach((mi,localIdx)=>{
      const first=localIdx===0;
      const mw=first?mws[mi]+FX:mws[mi];
      const staves=partsSubset.map((p,pi)=>{
        const inst=IMAP[p.instId]||IMAP['piano'];
        const cl=partClefs[pi];
        const sy=TP+pi*PG;
        const st=new Stave(x,sy,mw);
        if(inst.staffLines===1)st.setConfigForLines([{visible:false},{visible:false},{visible:true},{visible:false},{visible:false}]);
        if(first){ st.addClef(cl).addKeySignature(partVfSig(p,mi)).addTimeSignature(timeSigAt(mi).sig); }
        else{
          if(keyChangeAt(mi)) st.addKeySignature(partVfSig(p,mi),partVfSig(p,mi-1));
          if(sigChangeAt(mi)) st.addTimeSignature(timeSigAt(mi).sig);
        }
        if(repeatStartMeasures.includes(mi))st.setBegBarType(Barline.type.REPEAT_BEGIN);
        if(repeatEndMeasures.includes(mi))st.setEndBarType(Barline.type.REPEAT_END);
        st.setContext(ctx).draw();
        return st;
      });
      if(numP>=2){
        if(first){
          const i0=IMAP[partsSubset[0].instId],i1=IMAP[partsSubset[1].instId];
          if(i0&&i1&&i0.cat==='Keyboard'&&i1.cat==='Keyboard'&&partsSubset[0].clef!==partsSubset[1].clef){
            try{new StaveConnector(staves[0],staves[1]).setType('brace').setContext(ctx).draw();}catch(e){}
          }
          new StaveConnector(staves[0],staves[numP-1]).setType('singleLeft').setContext(ctx).draw();
        }
        new StaveConnector(staves[0],staves[numP-1]).setType('singleRight').setContext(ctx).draw();
      }
      staves.forEach((st,pi)=>{
        const noteData=allM[pi][mi]||[];
        const vfNotes=drawVoice(ctx,st,noteData,mw,VF,pi,partOffsets[pi],partClefs[pi],partsSubset[pi],timeSigAt(mi),mi);
        noteData.forEach((_,li)=>{ if(vfNotes[li])vfRefs[pi][partOffsets[pi]+li]={vfNote:vfNotes[li],stave:st}; });
        partOffsets[pi]+=noteData.length;
      });
      x+=mw;
    });

    // Only draw hairpins fully contained within this system — one that spans
    // a line break is dropped for print (a real, if rare, engraving edge case).
    partsSubset.forEach((part,pi)=>{
      (part.hairpins||[]).forEach(hp=>{
        if(hp.start<rangeStart[pi]||hp.end>=partOffsets[pi])return;
        const s=vfRefs[pi][hp.start],e=vfRefs[pi][hp.end];
        if(!s||!e)return;
        try{
          const h=new StaveHairpin({first_note:s.vfNote,last_note:e.vfNote,first_indices:[0],last_indices:[0]},
            hp.type==='cresc'?StaveHairpin.type.CRESC:StaveHairpin.type.DECRESC);
          h.setContext(ctx).setStave(s.stave).draw();
        }catch(err){}
      });
    });

    const svg=div.querySelector('svg');
    svg.setAttribute('width',sysW);
    svg.removeAttribute('style');
    svgBlocks.push(svg.outerHTML);
  });
  return svgBlocks;
}

function exportPDF(scope){
  if(!parts.some(p=>p.notes.length)){ toast('Nothing to print yet — write some notes first.','warn'); return; }
  const partsSubset=scope==='all'?parts:[parts[scope]];
  if(!partsSubset[0]||!partsSubset.some(p=>p.notes.length)){ toast('That part has no notes yet.','warn'); return; }
  const title=projects.find(p=>p.id===currentProjId)?.name||'Score';
  const subtitle=scope==='all'?'Full Score':partsSubset[0].name;

  const savedSel=selectedNote; selectedNote=null; // don't bake the on-screen blue selection into the print
  let svgBlocks;
  try{ svgBlocks=buildPrintSystems(partsSubset); }
  finally{ selectedNote=savedSel; }
  if(!svgBlocks.length){ toast('Nothing to print yet — write some notes first.','warn'); return; }

  const systemsHTML=svgBlocks.map(s=>`<div class="system">${s}</div>`).join('');
  const doc=`<!DOCTYPE html><html><head><title>${esc(title)} — ${esc(subtitle)}</title>
    <style>
      @page{margin:14mm;}
      body{font-family:serif;color:#000;margin:0 auto;padding:12px;max-width:${PRINT_SYS_W}px;}
      h1{font-size:20px;margin:0 0 2px;}
      h2{font-size:13px;font-weight:normal;color:#444;margin:0 0 4px;}
      .meta{font-size:12px;color:#444;margin-bottom:14px;}
      .system{break-inside:avoid;page-break-inside:avoid;margin-bottom:6px;}
      .system svg{max-width:100%;height:auto;display:block;}
    </style></head><body>
    <h1>${esc(title)}</h1>
    <h2>${esc(subtitle)}</h2>
    <div class="meta">Key: ${KMAP[currentKeyId]?.label||currentKeyId} &nbsp;·&nbsp; ${currentTimeSig.sig} &nbsp;·&nbsp; ♩ = ${parseInt(document.getElementById('bpm-inp').value)||80}</div>
    ${systemsHTML}
    </body></html>`;
  printDocument(doc);
}
// window.open() sends an installed app out to a Safari window to print, which
// is a jarring way to leave a full-screen score — and it is blocked outright
// whenever the browser decides the gesture has gone stale. A hidden iframe
// prints from inside the app instead, with no pop-up to permit.
function printDocument(html){
  const old=document.getElementById('print-frame');
  if(old) old.remove();
  const f=document.createElement('iframe');
  f.id='print-frame';
  f.setAttribute('aria-hidden','true');
  f.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none;';
  document.body.appendChild(f);
  const d=f.contentDocument||f.contentWindow.document;
  d.open(); d.write(html); d.close();
  const go=()=>{
    try{ f.contentWindow.focus(); f.contentWindow.print(); }
    catch(e){ toast('Could not open the print dialog: '+e.message,'err'); }
    // Kept around briefly: Safari returns from print() before the dialog has
    // actually taken the document, and removing the frame early prints blank.
    setTimeout(()=>{ const el=document.getElementById('print-frame'); if(el) el.remove(); },60000);
  };
  // Give the SVGs a moment to lay out; onload alone does not cover them.
  if(d.readyState==='complete') setTimeout(go,300);
  else f.onload=()=>setTimeout(go,300);
}

// ═══════════════════════════════════════════════════════
// Import — MIDI & MusicXML
// ═══════════════════════════════════════════════════════
// Quantize a duration in quarter-note beats to the nearest notatable value.
const DUR_TABLE=[[4,'w'],[3,'hd'],[2,'h'],[1.5,'qd'],[1,'q'],[0.75,'8d'],[0.5,'8'],[0.375,'16d'],[0.25,'16'],[0.1875,'32d'],[0.125,'32']];
function beatsToDur(qb){
  let best='q', bd=1e9;
  for(const [b,d] of DUR_TABLE){ const diff=Math.abs(b-qb); if(diff<bd){bd=diff;best=d;} }
  return best;
}
function restNote(qb){return{keys:['b/4'],dur:beatsToDur(qb)+'r',vfAccs:[null],midiVals:[],rest:true,lyric:null,dyn:null,arts:[],tempo:null};}

// ---- MIDI (Standard MIDI File) ----
function parseMIDI(buf){
  const dv=new DataView(buf); let p=0;
  const rd8=()=>dv.getUint8(p++);
  const rd16=()=>{const v=dv.getUint16(p);p+=2;return v;};
  const rd32=()=>{const v=dv.getUint32(p);p+=4;return v;};
  const rstr=(n)=>{let s='';for(let i=0;i<n;i++)s+=String.fromCharCode(rd8());return s;};
  const vlqRead=()=>{let d=0,b;do{b=rd8();d=(d<<7)|(b&0x7F);}while(b&0x80);return d;};
  if(rstr(4)!=='MThd')throw new Error('Not a MIDI file');
  rd32(); rd16(); const ntrk=rd16(); const div=rd16();
  const ppq=(div&0x8000)?480:div;
  let tempo=500000, timeSig='4/4';
  const tracks=[];
  for(let t=0;t<ntrk;t++){
    if(rstr(4)!=='MTrk')throw new Error('Bad MIDI track');
    const len=rd32(); const end=p+len;
    let tick=0, running=0; const events=[];
    while(p<end){
      tick+=vlqRead();
      let status=dv.getUint8(p);
      if(status<0x80){status=running;}else{p++;running=status;}
      const type=status&0xF0;
      if(status===0xFF){ const mt=rd8(); const ml=vlqRead(); const ms=p;
        if(mt===0x51)tempo=(dv.getUint8(p)<<16)|(dv.getUint8(p+1)<<8)|dv.getUint8(p+2);
        else if(mt===0x58){const nn=dv.getUint8(p),dd=dv.getUint8(p+1);timeSig=nn+'/'+Math.pow(2,dd);}
        p=ms+ml;
      } else if(status===0xF0||status===0xF7){ const sl=vlqRead(); p+=sl; }
      else if(type===0x90||type===0x80){ const note=rd8(),vel=rd8(); events.push({tick,on:(type===0x90&&vel>0),note}); }
      else if(type===0xA0||type===0xB0||type===0xE0){ p+=2; }
      else if(type===0xC0||type===0xD0){ p+=1; }
      else { p++; }
    }
    p=end; if(events.length)tracks.push(events);
  }
  return {ppq,tempo,timeSig,tracks};
}
function midiToData(parsed){
  const bpm=Math.max(20,Math.min(320,Math.round(60000000/parsed.tempo)));
  const ppq=parsed.ppq||480, tol=ppq*0.12;
  const outParts=[];
  parsed.tracks.forEach(events=>{
    const active={}, notes=[];
    events.forEach(e=>{
      if(e.on){(active[e.note]=active[e.note]||[]).push(e.tick);}
      else{const a=active[e.note];if(a&&a.length){const st=a.shift();if(e.tick>st)notes.push({start:st,end:e.tick,midi:e.note});}}
    });
    if(!notes.length)return;
    notes.sort((a,b)=>a.start-b.start||a.midi-b.midi);
    const nd=[]; let cursor=notes[0].start, i=0;
    if(cursor>tol)nd.push(restNote(cursor/ppq));
    while(i<notes.length){
      const start=notes[i].start; const group=[]; let j=i;
      while(j<notes.length&&Math.abs(notes[j].start-start)<tol){group.push(notes[j]);j++;}
      if(start-cursor>tol)nd.push(restNote((start-cursor)/ppq));
      const dur=Math.max(...group.map(g=>g.end-g.start));
      const midis=group.map(g=>g.midi).sort((a,b)=>a-b);
      const res=midis.map(m=>midiToNote(m));
      nd.push({keys:res.map(r=>r.name+'/'+r.oct),dur:beatsToDur(dur/ppq),vfAccs:res.map(r=>r.acc),midiVals:midis,rest:false,lyric:null,dyn:null,arts:[],tempo:null});
      cursor=start+dur; i=j;
    }
    outParts.push({notes:nd});
  });
  return {bpm,timeSig:parsed.timeSig,keyId:'C',parts:outParts};
}

// ---- MusicXML ----
const FIFTHS_MAJOR={'0':'C','1':'G','2':'D','3':'A','4':'E','5':'B','6':'Fs','-1':'F','-2':'Bb','-3':'Eb','-4':'Ab','-5':'Db','-6':'Fs'};
const FIFTHS_MINOR={'0':'Am','1':'Em','2':'Bm','3':'Fsm','4':'Csm','-1':'Dm','-2':'Gm','-3':'Cm','-4':'Fm','-5':'Bbm'};
function fifthsToKey(f,mode){return (mode==='minor'?FIFTHS_MINOR:FIFTHS_MAJOR)[String(f)]||'C';}
const XML_TYPE={'whole':'w','half':'h','quarter':'q','eighth':'8','16th':'16','32nd':'32','breve':'w','64th':'32'};
function xmlAcc(el){ const a=el.querySelector(':scope > accidental'); if(!a)return null; return {'sharp':'#','flat':'b','natural':'n','double-sharp':'##','sharp-sharp':'##','flat-flat':'bb','double-flat':'bb'}[a.textContent.trim()]||null; }
function xmlAlter(pitchEl){ const a=pitchEl.querySelector('alter'); const v=a?parseInt(a.textContent):0; return v; }
function alterToAcc(v){return v===1?'#':v===-1?'b':v===2?'##':v===-2?'bb':null;}
// MusicXML writes a second voice by rewinding the clock with <backup> and
// then laying more notes over the same span. Reading notes in document order
// and ignoring <backup>, <forward> and <voice> — which is what this did —
// stacked both voices end to end, so any piano or choral score imported as one
// garbled line at twice its real length. Each (staff, voice) pair is tracked
// separately now, against a real time cursor.
function parseMusicXML(text){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.querySelector('parsererror'))throw new Error('Invalid MusicXML');
  const partEls=[...doc.querySelectorAll('score-partwise > part, part')];
  if(!partEls.length)throw new Error('No parts found (timewise MusicXML not supported)');
  let keyId='C', timeSig='4/4', bpm=80;
  const kf=doc.querySelector('key fifths');
  if(kf){const modeEl=doc.querySelector('key mode');keyId=fifthsToKey(parseInt(kf.textContent),modeEl?modeEl.textContent.trim():'major');}
  const te=doc.querySelector('time');
  if(te){const b=te.querySelector('beats'),bt=te.querySelector('beat-type');if(b&&bt)timeSig=b.textContent.trim()+'/'+bt.textContent.trim();}
  const se=doc.querySelector('sound[tempo]');if(se)bpm=Math.max(20,Math.min(320,Math.round(parseFloat(se.getAttribute('tempo')))));
  // Part names, so an imported score does not come back as "Part 2".
  const partNames={};
  [...doc.querySelectorAll('part-list score-part')].forEach(sp=>{
    const id=sp.getAttribute('id');
    const nm=sp.querySelector('part-name')?.textContent.trim();
    if(id&&nm) partNames[id]=nm;
  });
  const outParts=[];
  partEls.forEach(partEl=>{
    // key = "staff/voice"; each holds {notes, cursor} in divisions.
    const lines=new Map();
    const lineFor=k=>{ if(!lines.has(k)) lines.set(k,{notes:[],cursor:0,staff:k.split('/')[0],voice:k.split('/')[1]}); return lines.get(k); };
    let divisions=1, measureStart=0;
    [...partEl.querySelectorAll('measure')].forEach(m=>{
      const dv=m.querySelector('attributes > divisions');
      if(dv) divisions=parseInt(dv.textContent)||divisions;
      // Every line starts each measure at the same point, whatever it did last.
      lines.forEach(l=>{ l.cursor=measureStart; });
      let cursor=measureStart, lastKey=null, measureEnd=measureStart;
      [...m.children].forEach(c=>{
        const tag=c.tagName;
        if(tag==='backup'){ cursor-=parseInt(c.querySelector('duration')?.textContent||'0')||0; return; }
        if(tag==='forward'){ cursor+=parseInt(c.querySelector('duration')?.textContent||'0')||0; return; }
        if(tag!=='note') return;
        const nEl=c;
        const staff=nEl.querySelector('staff')?.textContent.trim()||'1';
        const voice=nEl.querySelector('voice')?.textContent.trim()||'1';
        const key=staff+'/'+voice;
        const line=lineFor(key);
        const isRest=!!nEl.querySelector('rest');
        const isChord=!!nEl.querySelector('chord');
        const typeT=nEl.querySelector('type')?.textContent.trim();
        const dots=nEl.querySelectorAll('dot').length;
        const xmlDur=parseInt(nEl.querySelector('duration')?.textContent||'0')||0;
        // Prefer the written type; fall back to the sounding duration for a
        // note that has none (which MusicXML permits).
        const dur=typeT?((XML_TYPE[typeT]||'q')+(dots>0?'d':'')):beatsToDur(xmlDur/divisions);

        if(isChord){
          // A chord member sits on the same beat as the note before it and
          // must not advance anything.
          const prev=lastKey!=null?lineFor(lastKey).notes[lineFor(lastKey).notes.length-1]:null;
          const pit=nEl.querySelector('pitch');
          if(prev&&!prev.rest&&pit){
            const step=pit.querySelector('step').textContent.trim();
            const oct=parseInt(pit.querySelector('octave').textContent);
            const acc=alterToAcc(xmlAlter(pit));
            prev.keys.push(step+'/'+oct); prev.vfAccs.push(xmlAcc(nEl)); prev.midiVals.push(noteToMidi(step,acc,oct));
          }
          return;
        }
        // Fill any gap this line has skipped (another voice was sounding) so
        // the notes stay where they belong in the bar.
        if(cursor>line.cursor+1e-6){
          const gap=(cursor-line.cursor)/divisions;
          if(gap>0.01) beatsToDurs(gap).forEach(d=>line.notes.push(restNote(durBeats(d))));
          line.cursor=cursor;
        }
        if(isRest){
          line.notes.push(restNote(xmlDur?xmlDur/divisions:durBeats(dur)));
        } else {
          const pit=nEl.querySelector('pitch');
          if(!pit) return;
          const step=pit.querySelector('step').textContent.trim();
          const oct=parseInt(pit.querySelector('octave').textContent);
          const acc=alterToAcc(xmlAlter(pit));
          const lyr=nEl.querySelector('lyric text')?.textContent.trim()||null;
          line.notes.push({keys:[step+'/'+oct],dur,vfAccs:[xmlAcc(nEl)],midiVals:[noteToMidi(step,acc,oct)],rest:false,lyric:lyr,dyn:null,arts:[],tempo:null,grace:[],rud:null,sticking:null});
        }
        lastKey=key;
        cursor+=xmlDur; line.cursor=cursor;
        if(cursor>measureEnd) measureEnd=cursor;
      });
      lines.forEach(l=>{ if(l.cursor>measureEnd) measureEnd=l.cursor; });
      measureStart=measureEnd;
    });
    const pname=partNames[partEl.getAttribute('id')]||null;
    [...lines.keys()].sort().forEach(k=>{
      const l=lines.get(k);
      if(!l.notes.length) return;
      // Only name the extra voices; the first one carries the part's own name.
      const multi=[...lines.keys()].filter(o=>o.split('/')[0]===l.staff).length>1;
      outParts.push({notes:l.notes,staff:l.staff,name:pname&&!multi?pname:(pname?pname+' v'+l.voice:null)});
    });
  });
  return {keyId,timeSig,bpm,parts:outParts};
}

// A .mxl is a ZIP holding the score XML — and it is what MuseScore saves by
// default, so the file most people reach for was the one turned away at the
// door. Unpacked here with DecompressionStream, no library.
async function unzipMXL(buf){
  const dv=new DataView(buf), u8=new Uint8Array(buf);
  // Read the central directory from the end-of-central-directory record,
  // rather than trusting local headers (whose sizes may live in a data
  // descriptor after the compressed bytes).
  let eocd=-1;
  for(let i=u8.length-22;i>=0&&i>u8.length-66000;i--){
    if(dv.getUint32(i,true)===0x06054b50){ eocd=i; break; }
  }
  if(eocd<0) throw new Error('Not a .mxl archive');
  const count=dv.getUint16(eocd+10,true);
  let p=dv.getUint32(eocd+16,true);
  const entries=[];
  for(let i=0;i<count;i++){
    if(dv.getUint32(p,true)!==0x02014b50) break;
    const method=dv.getUint16(p+10,true);
    const compSize=dv.getUint32(p+20,true);
    const nameLen=dv.getUint16(p+28,true);
    const extraLen=dv.getUint16(p+30,true);
    const cmtLen=dv.getUint16(p+32,true);
    const localOff=dv.getUint32(p+42,true);
    const name=new TextDecoder().decode(u8.subarray(p+46,p+46+nameLen));
    entries.push({name,method,compSize,localOff});
    p+=46+nameLen+extraLen+cmtLen;
  }
  const read=async e=>{
    const lNameLen=dv.getUint16(e.localOff+26,true);
    const lExtraLen=dv.getUint16(e.localOff+28,true);
    const start=e.localOff+30+lNameLen+lExtraLen;
    const bytes=u8.subarray(start,start+e.compSize);
    if(e.method===0) return new TextDecoder().decode(bytes);
    if(e.method!==8) throw new Error('Unsupported compression in .mxl');
    if(typeof DecompressionStream==='undefined') throw new Error('This browser cannot open compressed .mxl — export as uncompressed MusicXML');
    const ds=new DecompressionStream('deflate-raw');
    const out=new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return await out.text();
  };
  // META-INF/container.xml names the real score; fall back to the first .xml
  // that is not the container itself.
  const container=entries.find(e=>/^META-INF\/container\.xml$/i.test(e.name));
  if(container){
    try{
      const cx=new DOMParser().parseFromString(await read(container),'application/xml');
      const path=cx.querySelector('rootfile')?.getAttribute('full-path');
      const hit=path&&entries.find(e=>e.name===path);
      if(hit) return await read(hit);
    }catch(e){}
  }
  const score=entries.find(e=>/\.(xml|musicxml)$/i.test(e.name)&&!/^META-INF\//i.test(e.name));
  if(!score) throw new Error('No score found inside the .mxl');
  return await read(score);
}

function importToProject(name,data){
  if(!data.parts.length||!data.parts.some(p=>p.notes.length))throw new Error('No notes found in file');
  const newParts=data.parts.filter(p=>p.notes.length).map((pp,i)=>{
    let clef=pp.staff==='2'?'bass':pp.staff==='1'?'treble':null;
    if(!clef){const mids=pp.notes.flatMap(n=>n.midiVals);const avg=mids.length?mids.reduce((a,b)=>a+b,0)/mids.length:64;clef=avg<57?'bass':'treble';}
    // Use the name the file gave the part where there is one, rather than
    // renaming everybody Treble/Bass/Part 3.
    const nm=pp.name||(clef==='bass'?'Bass':(i===0?'Treble':'Part '+(i+1)));
    return {id:i+1,name:nm,instId:'piano',clef,notes:pp.notes,hairpins:[],transpose:0};
  });
  const proj={parts:newParts,pid:newParts.length+1,apIdx:0,keyId:data.keyId||'C',timeSig:data.timeSig||'4/4',bpm:data.bpm||80};
  const id='p'+Date.now();
  projects.push({id,name:name||'Imported',data:proj,updated:Date.now()});
  currentProjId=id; saveAll(); applyProject(proj); resetHistory(); renderProjectsList(); switchTab('notes');
}
function importFile(kind){
  const inp=document.getElementById('import-file');
  inp.dataset.kind=kind;
  inp.accept=kind==='midi'?'.mid,.midi':'.xml,.musicxml,.mxl';
  inp.value=''; inp.click();
}
document.getElementById('import-file').addEventListener('change', async function(){
  const f=this.files[0]; if(!f)return;
  const kind=this.dataset.kind;
  try{
    if(kind==='midi'){
      const buf=await f.arrayBuffer();
      importToProject(f.name.replace(/\.midi?$/i,''), midiToData(parseMIDI(buf)));
    } else {
      const text=/\.mxl$/i.test(f.name) ? await unzipMXL(await f.arrayBuffer()) : await f.text();
      importToProject(f.name.replace(/\.(mxl|xml|musicxml)$/i,''), parseMusicXML(text));
    }
  }catch(e){ sheetTell('Import failed',e.message); console.error(e); }
});
