// ═══════════════════════════════════════════════════════════════════════
// MōdScore — MIDI in, recording, the performance layer, playback and audition
// ═══════════════════════════════════════════════════════════════════════
// Part of a single shared script, split across files so a change to one
// concern is not a change inside a five-thousand-line file. These load as
// ordinary scripts, in the order index.html lists them, and share one global
// scope exactly as they did when they were one block — see js/README.md for
// why it is not ES modules.

// ═══════════════════════════════════════════════════════
// MIDI input
// ═══════════════════════════════════════════════════════
const MN=['C','C','D','D','E','F','F','G','G','A','A','B'];
const MA=[null,'#',null,'#',null,null,'#',null,'#',null,'#',null];

// A chord struck on a real MIDI keyboard never arrives as one message — each
// key fires its own note-on a few ms apart. Buffer note-ons that land within a
// short window and enter them together as a single chord, instead of the old
// behavior of inserting each key as its own separate note in sequence.
let _midiChordBuf=[], _midiChordTimer=null;
const MIDI_CHORD_WINDOW_MS=45;
function queueMidiNote(name,acc,oct,midi){
  _midiChordBuf.push({name,acc,oct,midi});
  clearTimeout(_midiChordTimer);
  _midiChordTimer=setTimeout(flushMidiChordBuffer,MIDI_CHORD_WINDOW_MS);
}
function flushMidiChordBuffer(){
  const notes=_midiChordBuf; _midiChordBuf=[];
  if(!notes.length)return;
  const activeInst=IMAP[parts[apIdx]?.instId]||IMAP.piano;
  if(notes.length===1||chordBuildMode||graceMode){
    // Single key, or mid-way through an explicit chord-build/grace queue —
    // those already accumulate correctly one call at a time.
    notes.forEach(n=>enterPitch(n.name,n.acc,n.oct,n.acc));
    return;
  }
  if(activeInst.staffLines===1){
    // Single-line percussion has no real pitch to stack — a chord struck here
    // is still just one hit, not several hits piled up in a row.
    enterPitch(notes[0].name,notes[0].acc,notes[0].oct,notes[0].acc);
    return;
  }
  notes.sort((a,b)=>a.midi-b.midi);
  auditionPreview(notes.map(n=>n.midi), parts[apIdx]?.instId);
  const {lyric,dyn,arts,tempo,rud,grace,sticking}=grabPending();
  insertNoteAtCursor({
    keys:notes.map(n=>n.name+'/'+n.oct),
    dur:buildDur(),
    vfAccs:notes.map(n=>n.acc),
    midiVals:notes.map(n=>n.midi),
    rest:false,lyric,dyn,arts,tempo,rud,grace,sticking
  });
  pendingGraceNotes=[];updateGracePendingDisplay();
  render();scrollAfterEntry();
}

// Split out from initMidi's message handler so it's directly callable — both
// by real MIDI input and, e.g., by tests that can't drive actual hardware.
function handleMidiNoteEvent(status,note,vel){
  const type=status&0xf0;
  if(type===0x90&&vel>0){
    if(recState==='recording'){
      recActiveNotes[note]=Tone.now()-recStartSec;
      auditionPreview([note], parts[apIdx]?.instId);
    } else {
      const name=MN[note%12],acc=MA[note%12],oct=Math.floor(note/12)-1;
      queueMidiNote(name,acc,oct,note);
    }
  } else if(type===0x80||(type===0x90&&vel===0)){
    if(recState==='recording'&&recActiveNotes[note]!=null){
      const onSec=recActiveNotes[note]; delete recActiveNotes[note];
      recEvents.push({onSec,offSec:Math.max(onSec+0.02,Tone.now()-recStartSec),midi:note});
    }
  }
}
async function initMidi(){
  if(!navigator.requestMIDIAccess)return;
  try{
    const ma=await navigator.requestMIDIAccess();
    const pill=document.getElementById('midi-pill');
    const attach=inp=>{inp.onmidimessage=e=>handleMidiNoteEvent(e.data[0],e.data[1],e.data[2]);};
    // If a keyboard is plugged in while the record sheet is open, re-run
    // openRecSheet() so the "no MIDI" notice and disabled Start button
    // update in place instead of going stale.
    const markConnected=()=>{
      pill.textContent='MIDI ●'; pill.classList.add('on');
      if(document.getElementById('rec-sheet').classList.contains('on')) openRecSheet();
    };
    ma.inputs.forEach(attach);
    if(ma.inputs.size) markConnected();
    ma.onstatechange=e=>{if(e.port.type==='input'&&e.port.state==='connected'){attach(e.port);markConnected();}};
  }catch(e){}
}

// ═══════════════════════════════════════════════════════
// Live MIDI recording — 2-bar metronome count-in, then capture note-on/off
// timestamps until stopped, quantized afterward to the chosen grid.
// ═══════════════════════════════════════════════════════
let recState='idle'; // 'idle' | 'counting' | 'recording'
let recGrid='16';
let recEvents=[];        // {onSec, offSec, midi} — seconds relative to recStartSec
let recActiveNotes={};   // midi -> onSec, for notes currently held down
let recStartSec=0;       // Tone.now() reference at the instant true recording begins
let recMetroId=null;     // Tone.Transport repeat-event id, so it can be cancelled

let _clickSynth=null;
function getClickSynth(){
  if(_clickSynth)return _clickSynth;
  _clickSynth=new Tone.MembraneSynth({pitchDecay:.008,octaves:4,envelope:{attack:.001,decay:.06,sustain:0,release:.02},volume:-6}).connect(getMasterBus());
  return _clickSynth;
}
function metroClick(time,accent){
  try{ getClickSynth().triggerAttackRelease(accent?'C5':'C4',0.03,time); }catch(e){}
}

function setRecGrid(g){
  recGrid=g;
  document.querySelectorAll('.rec-grid-btn').forEach(b=>b.classList.toggle('on',b.dataset.grid===g));
}
function updateRecUI(){
  const btn=document.getElementById('rec-btn');
  const status=document.getElementById('rec-status');
  if(btn) btn.classList.toggle('recording',recState!=='idle');
  if(status) status.textContent = recState==='recording' ? '● Recording — tap ⏺ again to stop' : (recState==='idle' ? '' : status.textContent);
}
function updateRecCountUI(n,total){
  const status=document.getElementById('rec-status');
  if(status) status.textContent='Count-in '+n+' / '+total+'…';
}

// ⏺ opens the settings sheet rather than firing straight into a count-in —
// the quantize grid is the one thing you want to check before a take, and it
// no longer lives on screen where you could glance at it.
function midiConnected(){
  const pill=document.getElementById('midi-pill');
  return !!(pill&&pill.classList.contains('on'));
}
function openRecSheet(){
  const connected=midiConnected();
  document.getElementById('rec-no-midi').style.display=connected?'none':'block';
  document.getElementById('rec-start-btn').disabled=!connected;
  document.getElementById('rec-status').textContent='';
  document.getElementById('rec-sheet').classList.add('on');
}
function closeRecSheet(){ document.getElementById('rec-sheet').classList.remove('on'); }
function startRecordingFromSheet(){
  if(!midiConnected())return;
  startRecording();
}
async function toggleRecord(){
  if(recState!=='idle'){ stopRecording(); return; }
  if(playing){ toast('Stop playback before recording.','warn'); return; }
  openRecSheet();
}
async function startRecording(){
  await Tone.start();
  const bpm=parseInt(document.getElementById('bpm-inp').value)||80;
  const secPerBeat=60/bpm;
  const beatsPerBar=currentTimeSig.beats;
  const countBeats=beatsPerBar*2;
  recEvents=[]; recActiveNotes={};
  recState='counting';
  updateRecUI();
  Tone.getTransport().bpm.value=bpm;
  Tone.getTransport().cancel();
  for(let i=0;i<countBeats;i++){
    Tone.getTransport().schedule(time=>{
      metroClick(time,i%beatsPerBar===0);
      updateRecCountUI(i+1,countBeats);
    },i*secPerBeat);
  }
  Tone.getTransport().schedule(time=>{
    recState='recording';
    recStartSec=time;
    updateRecUI();
    // Count-in is over — get the sheet out of the way so the staff is
    // visible while you play. The pulsing ⏺ carries the recording state.
    closeRecSheet();
  },countBeats*secPerBeat);
  recMetroId=Tone.getTransport().scheduleRepeat(time=>{
    if(recState!=='recording')return;
    const beatIdx=Math.round((time-recStartSec)/secPerBeat);
    metroClick(time,(beatIdx%beatsPerBar)===0);
  },secPerBeat,countBeats*secPerBeat);
  Tone.getTransport().start();
}
function stopRecording(){
  if(recState==='idle')return;
  Tone.getTransport().stop();
  Tone.getTransport().cancel();
  if(recMetroId!=null){ try{Tone.getTransport().clear(recMetroId);}catch(e){} recMetroId=null; }
  const wasRecording=recState==='recording';
  if(wasRecording){
    const now=Tone.now();
    Object.entries(recActiveNotes).forEach(([midi,onSec])=>{
      recEvents.push({onSec,offSec:Math.max(onSec+0.05,now-recStartSec),midi:parseInt(midi)});
    });
  }
  recActiveNotes={};
  recState='idle';
  updateRecUI();
  closeRecSheet();  // covers stopping during the count-in, sheet still open
  if(wasRecording&&recEvents.length){
    const bpm=parseInt(document.getElementById('bpm-inp').value)||80;
    const notes=quantizeRecording(recEvents,recGrid,bpm);
    if(notes.length) insertRecordedNotes(notes);
  }
  recEvents=[];
}
function insertRecordedNotes(notes){
  const part=parts[apIdx];
  const at=(selectedNote&&selectedNote.partIdx===apIdx)?selectedNote.noteIdx+1
          :(caretGap&&caretGap.partIdx===apIdx)?caretGap.index
          :part.notes.length;
  part.notes.splice(at,0,...notes);
  selectedNote={partIdx:apIdx,noteIdx:at+notes.length-1}; caretGap=null;
  render(); scrollAfterEntry();
}

// ── Quantization ─────────────────────────────────────────
const REC_GRID_BEATS={q:1,'8':0.5,'16':0.25,'8t':1/3,'16t':1/6};
function quantizeRecording(events,gridId,bpm){
  if(!events.length)return[];
  const unit=REC_GRID_BEATS[gridId]||0.25;
  const secPerBeat=60/bpm;
  const toBeat=sec=>sec/secPerBeat;
  events=events.slice().sort((a,b)=>a.onSec-b.onSec);
  if(gridId==='8t'||gridId==='16t') return quantizeTripletGrid(events,unit,toBeat,gridId==='8t'?'8':'16');
  return quantizeSimpleGrid(events,unit,toBeat);
}
// Triplet grids: every cell is exactly one grid unit, never merged across
// cells — that keeps every complete run of 3 consecutive cells aligned to one
// beat, so it can always be bracketed as a clean triplet without needing ties
// (which this app doesn't support).
function quantizeTripletGrid(events,unit,toBeat,baseDur){
  const lastOff=Math.max(...events.map(e=>toBeat(e.offSec)));
  let numCells=Math.max(3,Math.round(lastOff/unit));
  numCells=Math.ceil(numCells/3)*3; // pad to a whole number of triplet groups
  const cellNotes=Array.from({length:numCells},()=>[]);
  events.forEach(e=>{
    const c=Math.max(0,Math.min(numCells-1,Math.round(toBeat(e.onSec)/unit)));
    cellNotes[c].push(e.midi);
  });
  return cellNotes.map(midis=>{
    if(!midis.length) return {keys:['b/4'],dur:composeDur(baseDur,false,3,true),vfAccs:[null],midiVals:[],rest:true,lyric:null,dyn:null,arts:[],tempo:null,rud:null,grace:[],sticking:null};
    const uniq=[...new Set(midis)].sort((a,b)=>a-b);
    const res=uniq.map(m=>midiToNote(m));
    return {keys:res.map(r=>r.name+'/'+r.oct),dur:composeDur(baseDur,false,3,false),vfAccs:res.map(r=>r.acc),midiVals:uniq,rest:false,lyric:null,dyn:null,arts:[],tempo:null,rud:null,grace:[],sticking:null};
  });
}
// Simple (non-triplet) grids: consecutive cells with the same held pitch(es)
// and no new onset merge into one longer notatable note.
function quantizeSimpleGrid(events,unit,toBeat){
  const lastOff=Math.max(...events.map(e=>toBeat(e.offSec)));
  const numCells=Math.max(1,Math.round(lastOff/unit));
  const cellOnset=Array.from({length:numCells},()=>[]);
  const cellHeld=Array.from({length:numCells},()=>new Set());
  events.forEach(e=>{
    const onC=Math.max(0,Math.min(numCells-1,Math.round(toBeat(e.onSec)/unit)));
    cellOnset[onC].push(e.midi);
    let offC=Math.round(toBeat(e.offSec)/unit);
    offC=Math.max(onC+1,Math.min(numCells,offC));
    for(let c=onC;c<offC;c++) cellHeld[c].add(e.midi);
  });
  const eqSet=(a,b)=>a.size===b.size&&[...a].every(x=>b.has(x));
  const out=[];
  let i=0;
  while(i<numCells){
    if(!cellOnset[i].length&&!cellHeld[i].size){
      let j=i; while(j<numCells&&!cellOnset[j].length&&!cellHeld[j].size) j++;
      out.push(restNote((j-i)*unit));
      i=j; continue;
    }
    const heldSet=new Set(cellOnset[i].length?cellOnset[i]:[...cellHeld[i]]);
    let j=i+1;
    while(j<numCells&&!cellOnset[j].length&&eqSet(cellHeld[j],heldSet)) j++;
    const beats=(j-i)*unit;
    const sorted=[...heldSet].sort((a,b)=>a-b);
    const res=sorted.map(m=>midiToNote(m));
    out.push({keys:res.map(r=>r.name+'/'+r.oct),dur:beatsToDur(beats),vfAccs:res.map(r=>r.acc),midiVals:sorted,rest:false,lyric:null,dyn:null,arts:[],tempo:null,rud:null,grace:[],sticking:null});
    i=j;
  }
  return out;
}

// ═══════════════════════════════════════════════════════
// Performance — turning the markings into sound
// ═══════════════════════════════════════════════════════
// The mix: how loud each part is, and which are silenced.
//
// Balance is a property of the song, so `volume` and `muted` live on the part
// itself and are saved with it — a part muted while you work on another one is
// still muted tomorrow, and nothing about it has been thrown away. They were
// briefly held in a Set keyed by part *index*, which meant deleting a part
// slid the mute onto its neighbour; the same trap the selection fell into.
//
// Solo is different: it is a "let me hear just this" gesture, not a decision
// about the piece, so it stays for the session only. It is keyed by part id
// rather than index, for the reason above.
let soloParts=new Set();
let loopPlayback=false;
const partVolume=p=>p&&p.volume!=null?Math.max(0,Math.min(100,p.volume)):100;
// 0..1, applied to note velocity. Squared so the slider behaves the way a
// fader should: halfway feels like half as loud, not 3dB down.
function partGain(pi){
  const v=partVolume(parts[pi])/100;
  return v*v;
}
function partMuted(pi){
  const p=parts[pi]; if(!p) return true;
  if(soloParts.size) return !soloParts.has(p.id);
  return !!p.muted || partVolume(p)===0;
}
function toggleMute(pi){
  const p=parts[pi]; if(!p) return;
  p.muted=!p.muted;
  renderPartsList(); scheduleAutosave();
}
function toggleSolo(pi){
  const p=parts[pi]; if(!p) return;
  if(soloParts.has(p.id)) soloParts.delete(p.id); else soloParts.add(p.id);
  renderPartsList();
}
function isSoloed(pi){ const p=parts[pi]; return !!(p&&soloParts.has(p.id)); }
function setPartVolume(pi,v){
  const p=parts[pi]; if(!p) return;
  p.volume=Math.max(0,Math.min(100,Math.round(v)));
  const lbl=document.getElementById('pvol-val-'+pi);
  if(lbl) lbl.textContent=p.volume+'%';
  scheduleAutosave();
}
function toggleLoop(){
  loopPlayback=!loopPlayback;
  const b=document.getElementById('loop-btn');
  if(b) b.classList.toggle('on',loopPlayback);
  if(playing){ stopScore(); playScore(); }
}

// Dynamics, hairpins, articulations and tempo words were all drawn and none of
// them were heard: velocity was hardcoded (1 in the scheduler, 90 in the MIDI
// writer), so ppp and fff played identically and staccato did not shorten.
// This layer reads a part's markings once and hands playback and MIDI export
// the same answer, so what you export matches what you auditioned.
const DYN_VEL={ppp:.16,pp:.26,p:.38,mp:.5,mf:.62,f:.76,ff:.88,fff:1};
// Accents that mark one note without changing the standing level. sfp is both:
// a hard attack, then the line continues piano.
const DYN_ACCENT={sfz:1.0,fz:.95,sfp:1.0};
const DYN_AFTER={sfp:'p'};
const DEFAULT_VEL=DYN_VEL.mf;
// [velocity multiplier, duration multiplier]
const ART_EFFECT={
  'a.':[1,.45],     // staccato — detached
  'a>':[1.3,.9],    // accent
  'a^':[1.45,.6],   // marcato — accented and short
  'a-':[1.05,1],    // tenuto — full value, slight lean
  'ao':[1,2.2],     // fermata — held
  'a+':[.9,.5],     // stopped / pizzicato
  'tr':[1,1],       // trill is drawn, not simulated
};
// Tempo words as a multiplier on the BPM box, so the box stays the reference.
const TEMPO_MULT={
  Grave:.55,Largo:.62,Adagio:.72,Andante:.88,Moderato:1,Allegretto:1.12,
  Allegro:1.3,Vivace:1.45,Presto:1.65,Prestissimo:1.85,'a tempo':1,
};
// Gradual changes, as the proportion of tempo gained or lost across the ramp,
// and how many quarter-notes the ramp takes.
const TEMPO_RAMP={
  'accel.':[1.3,8],'poco accel.':[1.12,8],
  'rit.':[.75,8],'ritard.':[.75,8],'rall.':[.7,8],
};

// The standing dynamic and per-note accent for every note of a part, with
// hairpins interpolated across the notes they span.
function velocityMap(part){
  const notes=part.notes||[];
  const out=new Array(notes.length).fill(DEFAULT_VEL);
  let level=DEFAULT_VEL;
  const levelAt=new Array(notes.length).fill(DEFAULT_VEL);
  notes.forEach((n,i)=>{
    if(n.dyn&&DYN_VEL[n.dyn]!=null) level=DYN_VEL[n.dyn];
    levelAt[i]=level;
    if(n.dyn&&DYN_AFTER[n.dyn]) level=DYN_VEL[DYN_AFTER[n.dyn]];
  });
  // Hairpins ramp from the level where they start to the level the music
  // reaches after them — or one step either way if nothing says otherwise.
  (part.hairpins||[]).forEach(hp=>{
    const a=Math.max(0,hp.start), b=Math.min(notes.length-1,hp.end);
    if(b<=a) return;
    const from=levelAt[a];
    let to=null;
    // The arriving dynamic is usually written on the note the hairpin ends on,
    // so start looking there rather than after it — searching only past the end
    // made every crescendo stop short of the ff it was pointing at.
    for(let i=b;i<notes.length;i++){ if(notes[i].dyn&&DYN_VEL[notes[i].dyn]!=null&&i>a){ to=DYN_VEL[notes[i].dyn]; break; } }
    if(to==null) to=hp.type==='cresc'?Math.min(1,from*1.55):Math.max(.14,from*.6);
    for(let i=a;i<=b;i++) levelAt[i]=from+(to-from)*((i-a)/(b-a));
  });
  notes.forEach((n,i)=>{
    let v=levelAt[i];
    if(n.dyn&&DYN_ACCENT[n.dyn]) v=Math.max(v,DYN_ACCENT[n.dyn]);
    (n.arts||[]).forEach(a=>{ const e=ART_EFFECT[a]; if(e) v*=e[0]; });
    out[i]=Math.max(.05,Math.min(1,v));
  });
  return out;
}
// How long a note actually sounds, as a fraction of its written value.
function articulationHold(n){
  let m=0.94;   // the small gap that has always separated consecutive notes
  (n.arts||[]).forEach(a=>{ const e=ART_EFFECT[a]; if(e) m*=e[1]; });
  return Math.max(.05,m);
}
// Tempo across the piece, as {beat, bpm} points in playback order. Marks are
// read from every part, since a tempo word belongs to the music, not a staff.
// How many beats a measure actually holds, taken from its content across all
// parts and falling back to the metre. Same rule drawScore uses, but callable
// without having rendered first — MIDI export runs before any draw.
function measureBeatsOf(allM,mi){
  let mx=0;
  allM.forEach(pm=>{ const arr=pm[mi]||[]; const b=arr.reduce((s,n)=>s+noteBeats(n,mi),0); if(b>mx)mx=b; });
  return mx||beatsAt(mi);
}
function buildTempoMap(playOrder,allM,baseBpm){
  const pts=[{beat:0,bpm:baseBpm}];
  const seen=new Set();
  parts.forEach((part,pi)=>{
    let beat=0;
    playOrder.forEach(mi=>{
      resolveMeasureNotes(allM[pi],mi).forEach(n=>{
        if(n.tempo&&!n.tieFrom){
          const key=beat.toFixed(4)+':'+n.tempo;
          if(!seen.has(key)){
            seen.add(key);
            if(TEMPO_MULT[n.tempo]!=null) pts.push({beat,bpm:baseBpm*TEMPO_MULT[n.tempo]});
            else if(TEMPO_RAMP[n.tempo]){
              const [factor,span]=TEMPO_RAMP[n.tempo];
              pts.push({beat,ramp:true,factor,span});
            }
          }
        }
        beat+=noteBeats(n,mi);
      });
    });
  });
  pts.sort((a,b)=>a.beat-b.beat);
  // Resolve ramps against whatever tempo is running when they start.
  const out=[]; let cur=baseBpm;
  pts.forEach(p=>{
    if(p.ramp){
      out.push({beat:p.beat,bpm:cur});
      cur=cur*p.factor;
      out.push({beat:p.beat+p.span,bpm:cur,linearFrom:p.beat});
    } else {
      cur=p.bpm;
      out.push({beat:p.beat,bpm:cur});
    }
  });
  return out.length?out:[{beat:0,bpm:baseBpm}];
}
// Seconds from the start of playback to a given beat, integrating the map.
// Constant segments are beats/bpm*60; a ramp is integrated as a linear change
// of tempo, which is what accel. and rit. actually do.
function beatToSec(map,beat){
  let sec=0;
  for(let i=0;i<map.length;i++){
    const seg=map[i], next=map[i+1];
    const from=seg.beat, to=next?Math.min(next.beat,beat):beat;
    if(to<=from) { if(next&&next.beat>=beat) break; else continue; }
    const span=to-from;
    if(next&&next.linearFrom!=null&&next.beat>seg.beat){
      // Tempo moves linearly from seg.bpm to next.bpm across the ramp.
      const full=next.beat-seg.beat;
      const bEnd=seg.bpm+(next.bpm-seg.bpm)*(span/full);
      const avg=(seg.bpm+bEnd)/2;
      sec+=span*60/Math.max(1,avg);
    } else {
      sec+=span*60/Math.max(1,seg.bpm);
    }
    if(!next||next.beat>=beat) break;
  }
  return sec;
}

// ═══════════════════════════════════════════════════════
// Playback
// ═══════════════════════════════════════════════════════
const BVP={w:4,h:2,q:1,'8':.5,'16':.25,'32':.125};
function durSecs(dur,bpm){
  const d=decomposeDur(dur);
  let mult=d.dot?1.5:1;
  if(d.tupN) mult*=tupletOccupied(d.tupN)/d.tupN;
  return (BVP[d.base]??1)*mult*(60/bpm);
}

// ── Sample-based instruments (real recordings) ──────────
// Salamander grand piano (Tone.js official) + tonejs-instruments library.
const TI='https://nbrosowsky.github.io/tonejs-instruments/samples/';
const SALAMANDER={
  base:'https://tonejs.github.io/audio/salamander/',
  map:{'A0':'A0.mp3','C1':'C1.mp3','D#1':'Ds1.mp3','F#1':'Fs1.mp3','A1':'A1.mp3','C2':'C2.mp3','D#2':'Ds2.mp3','F#2':'Fs2.mp3','A2':'A2.mp3','C3':'C3.mp3','D#3':'Ds3.mp3','F#3':'Fs3.mp3','A3':'A3.mp3','C4':'C4.mp3','D#4':'Ds4.mp3','F#4':'Fs4.mp3','A4':'A4.mp3','C5':'C5.mp3','D#5':'Ds5.mp3','F#5':'Fs5.mp3','A5':'A5.mp3','C6':'C6.mp3','D#6':'Ds6.mp3','F#6':'Fs6.mp3','A6':'A6.mp3','C7':'C7.mp3','D#7':'Ds7.mp3','F#7':'Fs7.mp3','A7':'A7.mp3','C8':'C8.mp3'}
};
// folder -> sampled pitches (Sampler pitch-shifts to fill the gaps; '#' -> 's' in filename)
const SAMP={
  piano:SALAMANDER,
  violin:{base:TI+'violin/', pitches:['C4','A4','C5','C6']},
  cello:{base:TI+'cello/', pitches:['C2','C3','C4','C#4']},
  contrabass:{base:TI+'contrabass/', pitches:['C2','E2','G1']},
  flute:{base:TI+'flute/', pitches:['C4','C5','C6','A5']},
  clarinet:{base:TI+'clarinet/', pitches:['D4','D5','F4']},
  bassoon:{base:TI+'bassoon/', pitches:['C3','C4','G2','A3']},
  saxophone:{base:TI+'saxophone/', pitches:['A4','C5','D5','E4']},
  trumpet:{base:TI+'trumpet/', pitches:['C4','F4','G4']},
  frenchhorn:{base:TI+'french-horn/', pitches:['C4','D3','F3']},
  trombone:{base:TI+'trombone/', pitches:['C3','D3','F3','A#2']},
  tuba:{base:TI+'tuba/', pitches:['A#1','F2','A#2','D3']},
  organ:{base:TI+'organ/', pitches:['C3','C4','C5','A4']},
  xylophone:{base:TI+'xylophone/', pitches:['C5','C6','G5']},
  guitar:{base:TI+'guitar-acoustic/', pitches:['C3','C4','C5']}
};
// instrument id -> sample folder (missing => piano; unpitched => synth drum)
const INST_SAMPLE={
  piano:'piano', organ:'organ', harpsi:'guitar',
  violin:'violin', viola:'cello', cello:'cello', dbass:'contrabass',
  flute:'flute', oboe:'flute', clarinet:'clarinet', bassoon:'bassoon', sax:'saxophone',
  trumpet:'trumpet', horn:'frenchhorn', trombone:'trombone', tuba:'tuba', tsax:'saxophone',
  soprano:'organ', mezzo:'organ', altov:'organ', tenorv:'organ', baritonev:'organ', bassv:'organ',
  timpani:'piano', xyloph:'xylophone', marimba:'xylophone',
  // The acoustic-guitar set was already being fetched for the harpsichord;
  // the plucked family is what it was actually recorded for.
  guitar:'guitar', nylon:'guitar', ukulele:'guitar', harp:'guitar', ebass:'contrabass'
  // The Special voices are deliberately absent: they carry synthOnly, so
  // getSampler() hands back their own synth voice instead of a sample set.
};
// Every instrument routes here instead of straight toDestination(). With each
// voice going directly to the speakers, playing several parts at once (or a
// thick MIDI/keyboard chord, or the drum set alongside anything else) could
// sum well past 0dB with nothing to catch it — a brick-wall limiter just
// under full scale stops that clipping without touching the level of normal,
// single-part playback (it only engages once the sum actually gets loud).
let _masterBus=null;
function getMasterBus(){
  if(_masterBus)return _masterBus;
  _masterBus=new Tone.Limiter(-1).toDestination();
  return _masterBus;
}

const _samplerCache={}, _drumCache={}, _synthCache={};
// The recorded instruments stream from tonejs.github.io. That fetch can fail
// — offline, captive wifi, the host having a bad day — and a Sampler that
// never loads simply plays nothing, so the app looked broken with no clue
// why. Every instrument already carries an oscillator/envelope definition
// for exactly this shape of sound, so fall back to synthesizing it: quieter
// than the samples, but the score still plays.
function buildSynthVoice(instId){
  const inst=IMAP[instId]||IMAP['piano'];
  return new Tone.PolySynth(Tone.Synth,{
    oscillator:{type:inst.osc==='fm'||inst.osc==='membrane'||inst.osc==='noise'?'triangle':inst.osc},
    envelope:{attack:inst.env.a,decay:inst.env.d,sustain:inst.env.s,release:inst.env.r},
    volume:inst.vol,
  }).connect(getMasterBus());
}
// Which sample sets have actually arrived, so the app can say what you are
// hearing instead of quietly swapping a piano for an oscillator.
const sampleState={};   // key -> 'loading' | 'ready' | 'synth'
function setSampleState(key,st){ if(sampleState[key]!==st){ sampleState[key]=st; updateVoicePill(); } }
function updateVoicePill(){
  const pill=document.getElementById('voice-pill'); if(!pill)return;
  const states=Object.values(sampleState);
  const synth=states.filter(s=>s==='synth').length;
  if(!states.length || (!synth && !states.includes('loading'))){ pill.style.display='none'; return; }
  pill.style.display='inline-block';
  if(synth){
    pill.textContent='〜 Synth voices';
    pill.title='The recorded instruments could not be downloaded, so playback is using the built-in synth. Reconnect and play again, or use Songs → “Save sounds for offline”.';
    pill.style.color='var(--warn)';
  } else {
    pill.textContent='… Loading sounds';
    pill.title='Downloading the recorded instruments.';
    pill.style.color='var(--muted4)';
  }
}
function getSampler(instId){
  // Instruments defined as synthesis rather than recording never touch the
  // sample path — its fallback key is the piano, which would be the wrong
  // sound rather than a degraded one. Cached per instrument, not per sample
  // set, because each of these *is* its own voice.
  if(IMAP[instId]?.synthOnly){
    return _synthCache[instId]||(_synthCache[instId]=buildSynthVoice(instId));
  }
  const key=INST_SAMPLE[instId]||'piano';
  if(_samplerCache[key])return _samplerCache[key];
  const def=SAMP[key]||SALAMANDER;
  const urls={};
  if(def.map)Object.assign(urls,def.map);
  else def.pitches.forEach(p=>{urls[p]=p.replace('#','s')+'.mp3';});
  let fallback=null;
  setSampleState(key,'loading');
  const s=new Tone.Sampler({urls,baseUrl:def.base,release:1,volume:-4,
    onload:()=>setSampleState(key,'ready'),
    onerror:()=>{ if(!fallback){ try{ fallback=buildSynthVoice(instId); }catch(e){} } setSampleState(key,'synth'); },
  }).connect(getMasterBus());
  // Route each note to whichever voice can actually sound it right now, so a
  // sample set that fails mid-session degrades instead of going silent.
  const voice={
    triggerAttackRelease:(n,d,t,v)=>{
      const target=(s.loaded||!fallback)?s:fallback;
      try{ target.triggerAttackRelease(n,d,t,v); }catch(e){}
    },
    releaseAll:()=>{ try{s.releaseAll?.();}catch(e){} try{fallback?.releaseAll?.();}catch(e){} },
    sampleKey:key,
  };
  _samplerCache[key]=voice;return voice;
}
// Warm the worker's sample cache on demand, so "offline" means the real
// instruments rather than the fallback synth. Only the sets this song
// actually uses, plus piano — the full library is tens of megabytes.
async function saveSoundsOffline(){
  const btn=document.getElementById('offline-sounds-btn');
  const keys=[...new Set(['piano',...parts.filter(p=>p.notes.length).map(p=>INST_SAMPLE[p.instId]).filter(Boolean)])];
  const urls=[];
  keys.forEach(k=>{
    const def=SAMP[k]||SALAMANDER;
    if(def.map) Object.entries(def.map).forEach(([,f])=>urls.push(def.base+f));
    else def.pitches.forEach(p=>urls.push(def.base+p.replace('#','s')+'.mp3'));
  });
  if(btn){ btn.disabled=true; btn.textContent='⇩ Saving sounds…'; }
  let done=0,failed=0;
  await Promise.all(urls.map(u=>fetch(u,{mode:'no-cors'}).then(()=>done++).catch(()=>failed++)));
  if(btn){
    btn.disabled=false;
    btn.textContent=failed?`⇩ Saved ${done} of ${urls.length}`:`✓ ${done} sounds saved`;
    setTimeout(()=>{ btn.textContent='⇩ Save sounds for offline'; },4000);
  }
}
function getDrum(instId){
  if(_drumCache[instId])return _drumCache[instId];
  const inst=IMAP[instId];const e={attack:inst.env.a,decay:inst.env.d,sustain:inst.env.s,release:inst.env.r};
  let s;
  if(inst.osc==='noise')s=new Tone.NoiseSynth({noise:{type:'white'},envelope:e,volume:inst.vol}).connect(getMasterBus());
  else s=new Tone.MembraneSynth({pitchDecay:.05,octaves:5,envelope:e,volume:inst.vol}).connect(getMasterBus());
  _drumCache[instId]=s;return s;
}
// Drum set: one 5-line percussion staff whose notes route to different drum
// voices by staff position (pitch). Low notes → kick, low-mid → toms,
// middle → snare, high → hi-hat/cymbal — the usual drum-kit layout.
let _drumset=null;
function getDrumset(){
  if(_drumset)return _drumset;
  const kick =new Tone.MembraneSynth({pitchDecay:.03,octaves:6,envelope:{attack:.001,decay:.28,sustain:0,release:.2},volume:-6}).connect(getMasterBus());
  const tom  =new Tone.MembraneSynth({pitchDecay:.05,octaves:4,envelope:{attack:.001,decay:.25,sustain:0,release:.2},volume:-6}).connect(getMasterBus());
  const snare=new Tone.NoiseSynth({noise:{type:'white'},envelope:{attack:.001,decay:.16,sustain:0,release:.05},volume:-7}).connect(getMasterBus());
  // Hi-hat/cymbal: high-passed short noise so it reads as metal, not a snare.
  const hatFilter=new Tone.Filter(7000,'highpass').connect(getMasterBus());
  const hat  =new Tone.NoiseSynth({noise:{type:'white'},envelope:{attack:.001,decay:.045,sustain:0,release:.02},volume:-13}).connect(hatFilter);
  _drumset={kick,tom,snare,hat,voices:[kick,tom,snare,hat]};
  return _drumset;
}
// Route one drum-set note (by MIDI/staff height) to its voice and strike it.
function drumsetHit(midi,dur,time,vel){
  const d=getDrumset();
  try{
    if(midi<=41)      d.kick.triggerAttackRelease('C1',dur,time,vel);
    else if(midi<=45) d.tom.triggerAttackRelease('G1',dur,time,vel);
    else if(midi<=52) d.tom.triggerAttackRelease('C2',dur,time,vel);
    else if(midi<=59) d.snare.triggerAttackRelease(dur,time,vel);
    else              d.hat.triggerAttackRelease(dur,time,vel*0.85);
  }catch(e){}
}

// ═══════════════════════════════════════════════════════
// Audition — hear a pitch/chord immediately as you enter or edit it, using
// the active part's instrument. Independent of full playback (Play/Stop);
// on by default, most useful when writing at the piano-style note grid.
// ═══════════════════════════════════════════════════════
let auditionEnabled=true;
function toggleAudition(){
  auditionEnabled=!auditionEnabled;
  document.getElementById('audition-pill')?.classList.toggle('on',auditionEnabled);
}
async function auditionPreview(midiVals,instId,partIdx){
  if(!auditionEnabled||!midiVals||!midiVals.length)return;
  // Auditioning through the same mix as playback, so a part turned down stays
  // turned down while you write into it.
  const pi=(partIdx==null)?apIdx:partIdx;
  if(partMuted(pi)) return;
  try{
    await Tone.start();
    const inst=IMAP[instId]||IMAP.piano;
    const dur=0.35,vel=0.7*partGain(pi),time=Tone.now();
    if(inst.drumset){ midiVals.forEach(m=>drumsetHit(m,dur,time,vel)); return; }
    if(inst.unpitched||inst.pitchedDrum){
      const voice=getDrum(instId);
      if(inst.unpitched){ if(inst.osc==='noise')voice.triggerAttackRelease(dur,time,vel); else voice.triggerAttackRelease('C2',dur,time,vel); }
      else voice.triggerAttackRelease(Tone.Frequency(midiVals[0],'midi').toNote(),dur,time,vel);
      return;
    }
    const voice=getSampler(instId);
    const notes=midiVals.map(m=>Tone.Frequency(m,'midi').toNote());
    voice.triggerAttackRelease(notes.length===1?notes[0]:notes,dur,time,vel);
  }catch(e){}
}

// Hear an instrument from the picker, before any part exists for it. Plays a
// short rising figure rather than one note, because what tells two instruments
// apart is mostly the attack and decay of successive notes. Deliberately
// independent of the audition toggle and of part mute: nothing is muted yet,
// and pressing ▷ is an explicit request to hear something.
let _previewVoices=[];
async function previewInstrument(instId){
  const inst=IMAP[instId]; if(!inst)return;
  // Voices are cached and shared, so releasing a preview would cut short a
  // note the transport is holding. Nothing to preview over anyway — the point
  // of ▷ is to hear one instrument on its own.
  if(playing||recState!=='idle')return;
  try{
    await Tone.start();
    // A second ▷ interrupts the first rather than layering on top of it.
    stopInstrumentPreview();
    const t0=Tone.now()+.05, step=.16, dur=.34;
    if(inst.drumset){
      // The drum set's figure is kick / snare / hat rather than a scale.
      [36,38,42,38].forEach((m,i)=>drumsetHit(m,dur,t0+i*step,.7));
      return;
    }
    if(inst.unpitched){
      const voice=getDrum(instId); _previewVoices.push(voice);
      for(let i=0;i<3;i++){
        if(inst.osc==='noise') voice.triggerAttackRelease(dur,t0+i*step,.7);
        else voice.triggerAttackRelease('C2',dur,t0+i*step,.7);
      }
      return;
    }
    const root=12*((inst.defaultOct??4)+1);   // MIDI C of the instrument's home octave
    const figure=inst.pitchedDrum?[0,0,7]:[0,4,7,12];
    if(inst.pitchedDrum){
      const voice=getDrum(instId); _previewVoices.push(voice);
      figure.forEach((iv,i)=>voice.triggerAttackRelease(Tone.Frequency(root+iv,'midi').toNote(),dur,t0+i*step,.7));
      return;
    }
    const voice=getSampler(instId); _previewVoices.push(voice);
    figure.forEach((iv,i)=>voice.triggerAttackRelease(Tone.Frequency(root+iv,'midi').toNote(),dur,t0+i*step,.7));
  }catch(e){}
}
function stopInstrumentPreview(){
  _previewVoices.forEach(v=>{ try{ v.releaseAll?v.releaseAll():v.triggerRelease?.(); }catch(e){} });
  _previewVoices=[];
}

let playing=false,_activeVoices=[];
// Expands repeat barlines into the actual order measures play in — e.g.
// start=[0] end=[1] over 5 measures becomes [0,1,0,1,2,3,4] (play the marked
// section, then its repeat, then continue normally). Each end measure only
// triggers its jump-back once, so this always terminates.
function buildPlayOrder(numM){
  const order=[]; const expanded=new Set();
  let mi=0;
  while(mi<numM){
    order.push(mi);
    if(repeatEndMeasures.includes(mi) && !expanded.has(mi)){
      expanded.add(mi);
      const starts=repeatStartMeasures.filter(s=>s<=mi).sort((a,b)=>b-a);
      mi=starts.length?starts[0]:0;
      continue;
    }
    mi++;
  }
  return order;
}
// Resolves a measure-repeat ("%") marker to the real notes from N measures
// back (recursing in case that measure is itself a marker). Simplification:
// "%%"/"%%%%" look back exactly 2/4 measure-slots rather than visually
// spanning multiple measures the way engraved parts traditionally do.
function resolveMeasureNotes(measuresForPart, mi, depth){
  if((depth||0)>10) return [];
  const arr=measuresForPart[mi]||[];
  if(arr.length===1 && arr[0].repeatBars){
    const back=mi-arr[0].repeatBars;
    if(back<0) return [];
    return resolveMeasureNotes(measuresForPart, back, (depth||0)+1);
  }
  return arr;
}
async function playScore(){
  if(playing||recState!=='idle')return;await Tone.start();
  const playBtn=document.querySelector('.tb.play');
  const bpm=parseInt(document.getElementById('bpm-inp').value)||80;
  // Pre-create + load all samplers needed
  const usedInst=[...new Set(parts.filter(p=>p.notes.length).map(p=>p.instId))];
  let needLoad=false;
  usedInst.forEach(id=>{const inst=IMAP[id];if(inst&&inst.drumset){getDrumset();}else if(inst&&(inst.unpitched||inst.pitchedDrum)){getDrum(id);}else{const key=INST_SAMPLE[id]||'piano';if(!_samplerCache[key])needLoad=true;getSampler(id);}});
  if(needLoad){ if(playBtn)playBtn.textContent='…'; }
  // Tone.loaded() neither resolves nor usefully rejects when a sample host is
  // unreachable, which left the play button stuck on '…' forever. Cap the
  // wait; getSampler()'s fallback voice covers whatever didn't arrive.
  try{ await Promise.race([Tone.loaded(), new Promise(r=>setTimeout(r,4000))]); }catch(e){}
  if(playBtn)playBtn.textContent='▶';
  stopScore(true);playing=true;
  Tone.getTransport().bpm.value=bpm;Tone.getTransport().cancel();

  const allM=parts.map(p=>toMeasures(p.notes));
  const numM=Math.max(...allM.map(m=>m.length),1);
  const playOrder=buildPlayOrder(numM);
  // Positions are worked out in beats and converted to seconds through the
  // tempo map, so a tempo word or a rit. bends the whole timeline — including
  // the auto-scroll — instead of only the notes after it.
  const tempoMap=buildTempoMap(playOrder,allM,bpm);
  const at=b=>beatToSec(tempoMap,b);

  // Default to starting playback from the selected/highlighted note (or the
  // insertion caret) instead of always from the top — find its position in the
  // playback timeline so every scheduled event can be shifted back by it.
  let cursorBeat=0, cursorOcc=0;
  const cur=selectedNote?{partIdx:selectedNote.partIdx,noteIdx:selectedNote.noteIdx}
           :caretGap?{partIdx:caretGap.partIdx,noteIdx:caretGap.index}:null;
  if(cur && parts[cur.partIdx]){
    const cNotes=parts[cur.partIdx].notes;
    let mi=0,beats=0,posInMeasure=0,BMAX=beatsAt(0);
    for(let i=0;i<cur.noteIdx && i<cNotes.length;i++){
      beats+=noteBeats(cNotes[i],mi); posInMeasure++;
      if(beats>=BMAX-.001){ mi++; beats=0; posInMeasure=0; BMAX=beatsAt(mi); }
    }
    const occ=playOrder.indexOf(mi);
    cursorOcc=occ>=0?occ:playOrder.length;
    for(let k=0;k<cursorOcc;k++) cursorBeat+=(measureBeats[playOrder[k]]||beatsAt(playOrder[k]));
    if(occ>=0){
      const mNotes=resolveMeasureNotes(allM[cur.partIdx],mi);
      for(let k=0;k<posInMeasure && k<mNotes.length;k++) cursorBeat+=durBeats(mNotes[k].dur);
    }
  }
  const cursorTime=at(cursorBeat);

  // Follow the currently-playing measure across the staff view as it plays —
  // uses the expanded order, so the view jumps back during a repeat too.
  let cumBeat=0;
  const phPlan=[];
  playOrder.forEach((mi,k)=>{
    const s=at(cumBeat);
    if(k>=cursorOcc) Tone.getTransport().schedule(()=>scrollToMeasure(mi),'+'+Math.max(0,s-cursorTime));
    cumBeat+=(measureBeats[mi]||beatsAt(mi));
    phPlan.push({mi,startSec:s,endSec:at(cumBeat)});
  });

  _activeVoices=[];let maxT=0;
  parts.forEach((part,pi)=>{
    if(!part.notes.length)return;
    const inst=IMAP[part.instId]||IMAP['piano'];
    const voice=inst.drumset?getDrumset():((inst.unpitched||inst.pitchedDrum)?getDrum(part.instId):getSampler(part.instId));
    if(inst.drumset){ _activeVoices.push(...voice.voices); } else { _activeVoices.push(voice); }
    const hit=(notesArg,d,time,vel)=>{
      try{
        if(inst.unpitched){ if(inst.osc==='noise')voice.triggerAttackRelease(d,time,vel); else voice.triggerAttackRelease('C2',d,time,vel); }
        else voice.triggerAttackRelease(notesArg,d,time,vel);
      }catch(e){}
    };
    // Dynamics and hairpins are read per part, keyed by the note's own index
    // in the part, so tied pieces and repeats all report the same velocity.
    if(partMuted(pi)) return;
    // The part's fader multiplies into velocity rather than sitting on a gain
    // node, because one sampler is shared by every part using that instrument —
    // a node after it could not tell whose note it was carrying. With no
    // velocity layers in these sample sets, the two are the same sound.
    const gain=partGain(pi);
    const vels=velocityMap(part).map(v=>Math.max(0,Math.min(1,v*gain)));
    let bt=0;
    playOrder.forEach(mi=>{
      const measureNotes=resolveMeasureNotes(allM[pi],mi);
      measureNotes.forEach(n=>{
        const beats=durBeats(n.dur);
        // A note split across a barline is drawn as tied pieces but must
        // still sound once, for its whole value — so only the head of a tie
        // is struck, and it is held for the note's full length rather than
        // the length of the piece that happens to sit in this bar.
        const soundBeats=(n.soundBeats!=null)?n.soundBeats:beats;
        if(!n.rest&&!n.repeatBars&&!n.tieFrom&&(n.midiVals||[]).length){
          const absT=at(bt);
          const vel=(n.srcIdx!=null&&vels[n.srcIdx]!=null)?vels[n.srcIdx]:DEFAULT_VEL;
          const hold=articulationHold(n);
          const toneNotes=n.midiVals.map(m=>Tone.Frequency(m,'midi').toNote());
          const mainNotes=toneNotes.length===1?toneNotes[0]:toneNotes;
          // Drum set fires each note by staff position to its own drum voice,
          // so a chord of kick+snare+hat all sound together and distinctly.
          const fire=(d,time,v)=>{ if(inst.drumset){ n.midiVals.forEach(m=>drumsetHit(m,d,time,v)); } else hit(mainNotes,d,time,v); };
          // Grace notes (flam/drag/ruff): quick quiet taps just before the main hit.
          const graceList=n.grace||[];
          const GRACE_GAP=.035;
          graceList.forEach((g,gi)=>{
            const gt=absT-(graceList.length-gi)*GRACE_GAP;
            if(gt>=cursorTime) Tone.getTransport().schedule(time=>fire(GRACE_GAP*.85,time,Math.min(1,vel*.7)),'+'+(gt-cursorTime));
          });
          // Rolls: subdivide the note into fast repeated hits instead of one sustained note.
          const ROLL_HITS={trem1:2,trem2:4,trem3:8,buzz:16,press:20};
          const hits=ROLL_HITS[n.rud];
          if(hits){
            const secs=at(bt+beats)-absT;
            const hitDur=secs/hits;
            for(let k=0;k<hits;k++){ const ht=absT+k*hitDur; if(ht>=cursorTime) Tone.getTransport().schedule(time=>fire(hitDur*.85,time,vel),'+'+(ht-cursorTime)); }
          } else {
            // Plain seconds (not a Tone.js Time-string like '8n') so arbitrary
            // N-tuplet ratios play at the right length — Tone's own 't' shorthand
            // only understands the 2:3 triplet case.
            const soundSecs=at(bt+soundBeats)-absT;
            if(absT>=cursorTime) Tone.getTransport().schedule(time=>fire(soundSecs*hold,time,vel),'+'+(absT-cursorTime));
          }
        }
        bt+=beats;
      });
    });
    maxT=Math.max(maxT,at(bt));
  });
  if(!_activeVoices.length){playing=false;return;}
  // Looping repeats the whole expanded order rather than stopping at the end,
  // which is what practising a passage needs.
  if(loopPlayback){
    const span=Math.max(.25,maxT-cursorTime);
    Tone.getTransport().scheduleRepeat(()=>{ startPlayhead(phPlan,cursorTime); }, span, 0);
    Tone.getTransport().loop=true;
    Tone.getTransport().loopStart=0;
    Tone.getTransport().loopEnd=span;
  } else {
    Tone.getTransport().loop=false;
    Tone.getTransport().schedule(()=>stopScore(),'+' +Math.max(0,maxT-cursorTime+.8));
  }
  startPlayhead(phPlan,cursorTime);
  Tone.getTransport().start();
}
function rewindToStart(){
  selectedNote=null;
  caretGap={partIdx:apIdx,index:0};
  const wrap=document.getElementById('score-wrap');
  if(wrap) wrap.scrollTo({left:0,top:0,behavior:SCROLL_BEHAVIOR});
  render(); updateSelectionUI();
}
function stopScore(s){
  // Pressing stop when nothing is playing means "take me back to the start" —
  // the same second press that rewinds a tape deck. `s` marks the internal
  // call playScore() makes to clear the decks before starting.
  if(!s && !playing){ rewindToStart(); return; }
  Tone.getTransport().stop();Tone.getTransport().cancel();
  Tone.getTransport().loop=false;
  _activeVoices.forEach(x=>{try{x.releaseAll?.();}catch(e){}});
  _activeVoices=[];playing=false;
  stopPlayhead();
  const playBtn=document.querySelector('.tb.play');if(playBtn)playBtn.textContent='▶';
}
