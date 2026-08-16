// ═══════════════════════════════════════════════════════════════════════
// MōdScore — Storage, dialogs, instrument and key data, transposition, shared state
// ═══════════════════════════════════════════════════════════════════════
// Part of a single shared script, split across files so a change to one
// concern is not a change inside a five-thousand-line file. These load as
// ordinary scripts, in the order index.html lists them, and share one global
// scope exactly as they did when they were one block — see js/README.md for
// why it is not ES modules.

// ═══════════════════════════════════════════════════════
// Storage access
// ═══════════════════════════════════════════════════════
// Safari with "Block All Cookies", iOS Lockdown Mode and some embedded
// webviews make *reading* localStorage throw, not just writing to it — so a
// bare getItem was enough to kill the boot before a single note was drawn.
// Every access goes through here and falls back to memory, so the app runs
// (and says it can't save) instead of showing a blank sheet.
const memStore=new Map();
const safeStore={
  // True once any access has been refused outright, as opposed to the disk
  // being full — two different problems that need two different messages.
  blocked:false,
  get(k){
    try{ return localStorage.getItem(k); }
    catch(e){ safeStore.blocked=true; return memStore.has(k)?memStore.get(k):null; }
  },
  // Returns null on success, or the error that stopped it.
  set(k,v){
    memStore.set(k,String(v));
    try{ localStorage.setItem(k,String(v)); return null; }
    catch(e){
      // A quota error still means storage exists; anything else means it is
      // switched off for this site.
      if(!(e&&(e.name==='QuotaExceededError'||e.code===22||e.code===1014))) safeStore.blocked=true;
      return e||new Error('storage unavailable');
    }
  },
};

// ═══════════════════════════════════════════════════════
// Telling and asking
// ═══════════════════════════════════════════════════════
// alert/confirm/prompt draw browser chrome inside an app that has none of its
// own, and iOS can refuse prompt() outright — which would have made naming a
// song impossible there. These replace them, and split the job in two: a
// passing notice is a toast, and anything needing an answer is a sheet.
function toast(msg,kind){
  const host=document.getElementById('toast-host'); if(!host){ return; }
  const t=document.createElement('div');
  t.className='toast'+(kind?' '+kind:'');
  t.textContent=msg;
  host.appendChild(t);
  // Long enough to read the longest of these without being in the way.
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .25s'; setTimeout(()=>t.remove(),260); },
             Math.min(6000,2200+msg.length*35));
}
let _sheetClose=null;
function closeAppSheet(value){
  const el=document.getElementById('app-sheet');
  if(el) el.classList.remove('on');
  const cb=_sheetClose; _sheetClose=null;
  if(cb) cb(value);
}
// Resolves to the chosen action's value, or to null if dismissed.
function appSheet({title,message,input,inputValue,placeholder,actions,danger}){
  return new Promise(resolve=>{
    const el=document.getElementById('app-sheet');
    if(!el){ resolve(null); return; }                 // never leave a caller hanging
    if(_sheetClose) closeAppSheet(null);              // one at a time
    const card=document.getElementById('app-sheet-card');
    card.classList.toggle('danger',!!danger);
    document.getElementById('app-sheet-title').textContent=title||'';
    const msg=document.getElementById('app-sheet-msg');
    msg.textContent=message||''; msg.style.display=message?'':'none';
    const inp=document.getElementById('app-sheet-input');
    inp.style.display=input?'':'none';
    if(input){ inp.value=inputValue||''; inp.placeholder=placeholder||''; }
    const btns=document.getElementById('app-sheet-btns');
    btns.innerHTML='';
    let settled=false;
    _sheetClose=v=>{ if(settled)return; settled=true; document.removeEventListener('keydown',onKey); resolve(v); };
    const pick=a=>closeAppSheet(a.value===undefined?(input?inp.value:true):a.value);
    (actions||[{label:'OK',primary:true}]).forEach(a=>{
      const b=document.createElement('button');
      b.className='chip'+(a.danger?' danger':a.primary?' primary':'');
      b.textContent=a.label;
      b.onclick=()=>pick(a);
      btns.appendChild(b);
    });
    const onKey=e=>{
      if(e.key==='Escape'){ e.preventDefault(); closeAppSheet(null); }
      else if(e.key==='Enter'&&input){ e.preventDefault(); closeAppSheet(inp.value); }
    };
    document.addEventListener('keydown',onKey);
    el.onclick=e=>{ if(e.target===el) closeAppSheet(null); };   // tapping outside dismisses
    el.classList.add('on');
    setTimeout(()=>{ if(input) inp.focus(); else btns.querySelector('.primary,.danger,button')?.focus(); },30);
  });
}
function sheetTell(title,message){
  return appSheet({title,message,actions:[{label:'OK',primary:true,value:true}]});
}
function sheetConfirm(title,message,okLabel,danger){
  return appSheet({title,message,danger,actions:[
    {label:'Cancel',value:null},
    {label:okLabel||'OK',primary:!danger,danger:!!danger,value:true},
  ]});
}
// Resolves to the trimmed text, or null if cancelled or left empty.
async function sheetAsk(title,message,value,placeholder){
  const v=await appSheet({title,message,input:true,inputValue:value,placeholder,actions:[
    {label:'Cancel',value:null},
    {label:'Save',primary:true},
  ]});
  return (typeof v==='string'&&v.trim())?v.trim():null;
}

// ═══════════════════════════════════════════════════════
// Instruments
// ═══════════════════════════════════════════════════════
const INSTRUMENTS = [
  {id:'piano',   label:'Piano',       cat:'Keyboard',  clef:'treble',     osc:'triangle',  env:{a:.01,d:.3,s:.3,r:1},   vol:-6, gm:0,  defaultOct:4},
  {id:'organ',   label:'Organ',       cat:'Keyboard',  clef:'treble',     osc:'sine4',     env:{a:.02,d:0,s:1,r:.04},   vol:-8, gm:19, defaultOct:4},
  {id:'harpsi',  label:'Harpsichord', cat:'Keyboard',  clef:'treble',     osc:'sawtooth',  env:{a:.005,d:.4,s:0,r:.1},  vol:-8, gm:6,  defaultOct:4},
  {id:'violin',  label:'Violin',      cat:'Strings',   clef:'treble',     osc:'sawtooth4', env:{a:.1,d:.05,s:1,r:.5},   vol:-8, gm:40, defaultOct:4},
  {id:'viola',   label:'Viola',       cat:'Strings',   clef:'alto',       osc:'sawtooth4', env:{a:.12,d:.05,s:1,r:.5},  vol:-8, gm:41, defaultOct:4},
  {id:'cello',   label:'Cello',       cat:'Strings',   clef:'bass',       osc:'sawtooth4', env:{a:.14,d:.05,s:1,r:.6},  vol:-8, gm:42, defaultOct:3},
  {id:'dbass',   label:'Dbl Bass',    cat:'Strings',   clef:'bass',       osc:'sawtooth2', env:{a:.15,d:.1,s:.9,r:.7},  vol:-6, gm:43, defaultOct:2, transpose:12},
  {id:'flute',   label:'Flute',       cat:'Woodwinds', clef:'treble',     osc:'sine',      env:{a:.06,d:.05,s:.9,r:.4}, vol:-10, gm:73, defaultOct:5},
  {id:'oboe',    label:'Oboe',        cat:'Woodwinds', clef:'treble',     osc:'sawtooth8', env:{a:.04,d:.1,s:.85,r:.3}, vol:-10, gm:68, defaultOct:4},
  {id:'clarinet',label:'Clarinet',    cat:'Woodwinds', clef:'treble',     osc:'square',    env:{a:.04,d:.05,s:.85,r:.35},vol:-10, gm:71, defaultOct:4, transpose:2},
  {id:'bassoon', label:'Bassoon',     cat:'Woodwinds', clef:'bass',       osc:'sawtooth',  env:{a:.08,d:.1,s:.85,r:.5}, vol:-8, gm:70, defaultOct:3},
  {id:'sax',     label:'Alto Sax',    cat:'Woodwinds', clef:'treble',     osc:'sawtooth8', env:{a:.05,d:.1,s:.9,r:.4},  vol:-8, gm:65, defaultOct:4, transpose:9},
  {id:'tsax',    label:'Tenor Sax',   cat:'Woodwinds', clef:'treble',     osc:'sawtooth8', env:{a:.05,d:.1,s:.9,r:.4},  vol:-8, gm:66, defaultOct:3, transpose:14},
  {id:'trumpet', label:'Trumpet',     cat:'Brass',     clef:'treble',     osc:'square',    env:{a:.04,d:.1,s:.85,r:.3}, vol:-8, gm:56, defaultOct:4, transpose:2},
  {id:'horn',    label:'Fr. Horn',    cat:'Brass',     clef:'treble',     osc:'triangle8', env:{a:.1,d:.1,s:.8,r:.6},   vol:-8, gm:60, defaultOct:3, transpose:7},
  {id:'trombone',label:'Trombone',    cat:'Brass',     clef:'bass',       osc:'sawtooth',  env:{a:.06,d:.1,s:.85,r:.5}, vol:-8, gm:57, defaultOct:3},
  {id:'tuba',    label:'Tuba',        cat:'Brass',     clef:'bass',       osc:'square',    env:{a:.08,d:.1,s:.85,r:.6}, vol:-6, gm:58, defaultOct:2},
  {id:'soprano', label:'Soprano',     cat:'Vocal',     clef:'treble',     osc:'sine',      env:{a:.1,d:.1,s:.9,r:.8},   vol:-8, gm:52, defaultOct:4},
  {id:'mezzo',   label:'Mezzo',       cat:'Vocal',     clef:'treble',     osc:'sine',      env:{a:.1,d:.1,s:.88,r:.8},  vol:-8, gm:52, defaultOct:4},
  {id:'altov',   label:'Alto',        cat:'Vocal',     clef:'treble',     osc:'sine',      env:{a:.1,d:.1,s:.85,r:.8},  vol:-8, gm:53, defaultOct:4},
  {id:'tenorv',  label:'Tenor',       cat:'Vocal',     clef:'treble',     osc:'triangle',  env:{a:.08,d:.1,s:.85,r:.7}, vol:-8, gm:53, defaultOct:3},
  {id:'baritonev',label:'Baritone',   cat:'Vocal',     clef:'bass',       osc:'triangle',  env:{a:.09,d:.1,s:.85,r:.8}, vol:-8, gm:53, defaultOct:3},
  {id:'bassv',   label:'Bass Voice',  cat:'Vocal',     clef:'bass',       osc:'triangle',  env:{a:.1,d:.1,s:.85,r:.8},  vol:-8, gm:53, defaultOct:2},
  {id:'timpani', label:'Timpani',     cat:'Percussion',clef:'bass',       osc:'membrane',  env:{a:.001,d:.5,s:0,r:.5},  vol:-4, gm:47, defaultOct:3},
  {id:'xyloph',  label:'Xylophone',   cat:'Percussion',clef:'treble',     osc:'fm',        env:{a:.001,d:.3,s:0,r:.1},  vol:-8, gm:13, defaultOct:5, transpose:-12},
  {id:'marimba', label:'Marimba',     cat:'Percussion',clef:'treble',     osc:'fm',        env:{a:.001,d:.6,s:0,r:.2},  vol:-6, gm:12, defaultOct:4},
  {id:'snare',   label:'Snare',       cat:'Percussion',clef:'percussion', osc:'noise',     env:{a:.001,d:.2,s:0,r:.1},  vol:-6, unpitched:true, gm:0, staffLines:1, defaultOct:4},
  {id:'bassdrum',label:'Bass Drum',   cat:'Percussion',clef:'percussion', osc:'membrane',  env:{a:.001,d:.4,s:0,r:.2},  vol:-4, unpitched:true, gm:0, staffLines:1, defaultOct:4},
  {id:'tenordrum',label:'Tenor Drum', cat:'Percussion',clef:'percussion', osc:'membrane',  env:{a:.001,d:.35,s:0,r:.15},vol:-4, pitchedDrum:true, gm:0, defaultOct:4},
  {id:'marchbass',label:'Marching Bass',cat:'Percussion',clef:'percussion', osc:'membrane',env:{a:.001,d:.5,s:0,r:.2},  vol:-4, pitchedDrum:true, gm:0, defaultOct:3},
  {id:'drumset', label:'Drum Set',    cat:'Percussion',clef:'percussion', osc:'membrane',  env:{a:.001,d:.3,s:0,r:.2},  vol:-4, drumset:true, gm:0, defaultOct:4},
];
const IMAP = Object.fromEntries(INSTRUMENTS.map(i=>[i.id,i]));
const CATS  = [...new Set(INSTRUMENTS.map(i=>i.cat))];

// ═══════════════════════════════════════════════════════
// Key / Scale data
// ═══════════════════════════════════════════════════════
const KEYS_DATA = [
  {id:'C', label:'C',  vfSig:'C',  mode:'major', scale:[['C',null],['D',null],['E',null],['F',null],['G',null],['A',null],['B',null]]},
  {id:'G', label:'G',  vfSig:'G',  mode:'major', scale:[['G',null],['A',null],['B',null],['C',null],['D',null],['E',null],['F','#']]},
  {id:'D', label:'D',  vfSig:'D',  mode:'major', scale:[['D',null],['E',null],['F','#'],['G',null],['A',null],['B',null],['C','#']]},
  {id:'A', label:'A',  vfSig:'A',  mode:'major', scale:[['A',null],['B',null],['C','#'],['D',null],['E',null],['F','#'],['G','#']]},
  {id:'E', label:'E',  vfSig:'E',  mode:'major', scale:[['E',null],['F','#'],['G','#'],['A',null],['B',null],['C','#'],['D','#']]},
  {id:'B', label:'B',  vfSig:'B',  mode:'major', scale:[['B',null],['C','#'],['D','#'],['E',null],['F','#'],['G','#'],['A','#']]},
  {id:'Fs',label:'F#', vfSig:'F#', mode:'major', scale:[['F','#'],['G','#'],['A','#'],['B',null],['C','#'],['D','#'],['E','#']]},
  {id:'F', label:'F',  vfSig:'F',  mode:'major', scale:[['F',null],['G',null],['A',null],['B','b'],['C',null],['D',null],['E',null]]},
  {id:'Bb',label:'Bb', vfSig:'Bb', mode:'major', scale:[['B','b'],['C',null],['D',null],['E','b'],['F',null],['G',null],['A',null]]},
  {id:'Eb',label:'Eb', vfSig:'Eb', mode:'major', scale:[['E','b'],['F',null],['G',null],['A','b'],['B','b'],['C',null],['D',null]]},
  {id:'Ab',label:'Ab', vfSig:'Ab', mode:'major', scale:[['A','b'],['B','b'],['C',null],['D','b'],['E','b'],['F',null],['G',null]]},
  {id:'Db',label:'Db', vfSig:'Db', mode:'major', scale:[['D','b'],['E','b'],['F',null],['G','b'],['A','b'],['B','b'],['C',null]]},
  {id:'Am', label:'Am', vfSig:'C',  mode:'minor', scale:[['A',null],['B',null],['C',null],['D',null],['E',null],['F',null],['G',null]]},
  {id:'Em', label:'Em', vfSig:'G',  mode:'minor', scale:[['E',null],['F','#'],['G',null],['A',null],['B',null],['C',null],['D',null]]},
  {id:'Bm', label:'Bm', vfSig:'D',  mode:'minor', scale:[['B',null],['C','#'],['D',null],['E',null],['F','#'],['G',null],['A',null]]},
  {id:'Fsm',label:'F#m',vfSig:'A',  mode:'minor', scale:[['F','#'],['G','#'],['A',null],['B',null],['C','#'],['D',null],['E',null]]},
  {id:'Csm',label:'C#m',vfSig:'E',  mode:'minor', scale:[['C','#'],['D','#'],['E',null],['F','#'],['G','#'],['A',null],['B',null]]},
  {id:'Dm', label:'Dm', vfSig:'F',  mode:'minor', scale:[['D',null],['E',null],['F',null],['G',null],['A',null],['B','b'],['C',null]]},
  {id:'Gm', label:'Gm', vfSig:'Bb', mode:'minor', scale:[['G',null],['A',null],['B','b'],['C',null],['D',null],['E','b'],['F',null]]},
  {id:'Cm', label:'Cm', vfSig:'Eb', mode:'minor', scale:[['C',null],['D',null],['E','b'],['F',null],['G',null],['A','b'],['B','b']]},
  {id:'Fm', label:'Fm', vfSig:'Ab', mode:'minor', scale:[['F',null],['G',null],['A','b'],['B','b'],['C',null],['D','b'],['E','b']]},
  {id:'Bbm',label:'Bbm',vfSig:'Db', mode:'minor', scale:[['B','b'],['C',null],['D','b'],['E','b'],['F',null],['G','b'],['A','b']]},
];
const KMAP = Object.fromEntries(KEYS_DATA.map(k=>[k.id,k]));

const MAJ_FUNC  = ['tonic','subdom','tonic','subdom','dom','tonic','dom'];
const MIN_FUNC  = ['tonic','subdom','tonic','subdom','dom','subdom','dom'];
const MAJ_ROMANS= ['I','ii','iii','IV','V','vi','vii°'];
const MIN_ROMANS= ['i','ii°','III','iv','v','VI','VII'];

const NOTE_SEMI = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
function accSemi(acc){return acc==='#'?1:acc==='b'?-1:acc==='##'?2:acc==='bb'?-2:0;}
function noteToMidi(name, acc, oct){ return (oct+1)*12 + NOTE_SEMI[name] + accSemi(acc); }

function buildChordTones(degree, scale, rootOct, seventh=false){
  const count = seventh ? 4 : 3;
  const idxs = Array.from({length:count},(_,i)=>(degree+i*2)%7);
  let prevMidi=-999, oct=rootOct;
  return idxs.map(idx=>{
    const [name,acc]=scale[idx];
    let o=oct, m=noteToMidi(name,acc,o);
    while(m<=prevMidi){o++;m=noteToMidi(name,acc,o);}
    prevMidi=m; oct=o;
    return {name,acc,oct:o,midi:m};
  });
}

const SEMI_TO_SHARP=[['C',null],['C','#'],['D',null],['D','#'],['E',null],['F',null],['F','#'],['G',null],['G','#'],['A',null],['A','#'],['B',null]];
const SEMI_TO_FLAT =[['C',null],['D','b'],['D',null],['E','b'],['E',null],['F',null],['G','b'],['G',null],['A','b'],['A',null],['B','b'],['B',null]];
const FLAT_KEYS=['F','Bb','Eb','Ab','Db','Gb','Cb'];
function midiToNote(midi){
  const kd=KMAP[currentKeyId];
  const oct=Math.floor(midi/12)-1;
  const semi=((midi%12)+12)%12;
  if(kd){
    for(const [name,acc] of kd.scale){
      const ns=((NOTE_SEMI[name]+accSemi(acc))+120)%12;
      if(ns===semi) return {name,acc,oct};
    }
  }
  const useFlat=FLAT_KEYS.includes(kd?.vfSig||'');
  const [n,a]=(useFlat?SEMI_TO_FLAT:SEMI_TO_SHARP)[semi];
  return {name:n,acc:a,oct};
}

// ═══════════════════════════════════════════════════════
// Transposing instruments
// ═══════════════════════════════════════════════════════
// A B♭ trumpet sounds a tone below what its player reads, so a trumpet part
// printed at concert pitch is a part that player cannot use. midiVals stay
// concert pitch throughout — playback, audition and MIDI export are the
// sounding music and never change — and the *written* pitch is derived here
// for the staff, the printed part and MusicXML.
//
// `transpose` is what you add to concert to get written: +2 for B♭, +9 for
// E♭ alto, +7 for F horn, +12 for double bass (written an octave high).
const FIFTHS_TO_MAJOR={'-7':'Cb','-6':'Gb','-5':'Db','-4':'Ab','-3':'Eb','-2':'Bb','-1':'F','0':'C','1':'G','2':'D','3':'A','4':'E','5':'B','6':'F#','7':'C#'};
const MAJOR_TO_FIFTHS=Object.fromEntries(Object.entries(FIFTHS_TO_MAJOR).map(([f,n])=>[n,parseInt(f)]));
const SHARP_ORDER=['F','C','G','D','A','E','B'], FLAT_ORDER=['B','E','A','D','G','C','F'];
const LETTERS=['C','D','E','F','G','A','B'];

// The scale of the major key at this point on the circle of fifths, as the
// same [letter, accidental] pairs KEYS_DATA uses.
function scaleForFifths(f){
  const alt={};
  if(f>0) SHARP_ORDER.slice(0,f).forEach(l=>alt[l]='#');
  if(f<0) FLAT_ORDER.slice(0,-f).forEach(l=>alt[l]='b');
  const tonic=FIFTHS_TO_MAJOR[String(f)]||'C';
  const start=LETTERS.indexOf(tonic[0]);
  return Array.from({length:7},(_,i)=>{const l=LETTERS[(start+i)%7];return[l,alt[l]||null];});
}
// Transposing by N semitones moves the key N*7 places round the circle of
// fifths (7 is its own inverse mod 12). Wrapped back into the range VexFlow
// can draw, so a part never asks for a signature with nine sharps.
function transposeFifths(f,semis){
  let n=f+7*semis;
  while(n>7) n-=12;
  while(n<-7) n+=12;
  return n;
}
// Which octave actually spells this MIDI note as (name, acc) — B#3 and C4 are
// the same key but not the same octave number.
function octaveFor(name,acc,midi){
  const base=Math.floor(midi/12)-1;
  for(let d=-1;d<=1;d++) if(noteToMidi(name,acc,base+d)===midi) return base+d;
  return base;
}
// Spell a MIDI note inside a given key: notes of the key take the signature's
// accidental and draw none, notes outside it get an explicit one.
function spellInScale(midi,scale,preferFlat){
  const semi=((midi%12)+12)%12;
  for(const [name,acc] of scale){
    if(((NOTE_SEMI[name]+accSemi(acc))+120)%12===semi)
      return {name,acc,oct:octaveFor(name,acc,midi),vfAcc:null};
  }
  const [n,a]=(preferFlat?SEMI_TO_FLAT:SEMI_TO_SHARP)[semi];
  return {name:n,acc:a,oct:octaveFor(n,a,midi),vfAcc:a||'n'};
}

// The key list stopped at 12 majors and 10 minors, which left out G♭ and C♭
// major and four of the sharp minors — reachable keys that a modulation lands
// in constantly. Now that the scale for any point on the circle can be
// derived, the gaps fill themselves.
(function fillOutKeys(){
  const MAJ=[['Gb',-6],['Cb',-7]];
  const MIN=[['Ebm',-6],['Abm',-7],['Gsm',5],['Dsm',6],['Asm',7]];
  const MIN_LABEL={Ebm:'E♭m',Abm:'A♭m',Gsm:'G#m',Dsm:'D#m',Asm:'A#m'};
  MAJ.forEach(([id,f])=>{
    if(KMAP[id])return;
    const k={id,label:FIFTHS_TO_MAJOR[String(f)],vfSig:FIFTHS_TO_MAJOR[String(f)],mode:'major',scale:scaleForFifths(f)};
    KEYS_DATA.push(k); KMAP[id]=k;
  });
  MIN.forEach(([id,f])=>{
    if(KMAP[id])return;
    // A minor key shares its relative major's signature; its natural scale is
    // that major scale started from the sixth degree.
    const maj=scaleForFifths(f);
    const scale=Array.from({length:7},(_,i)=>maj[(i+5)%7]);
    const k={id,label:MIN_LABEL[id]||id,vfSig:FIFTHS_TO_MAJOR[String(f)],mode:'minor',scale};
    KEYS_DATA.push(k); KMAP[id]=k;
  });
})();

// 'concert' — the score as it sounds, which is how the app has always behaved.
// 'written' — each part as its player reads it.
let pitchView='written';
function applyPitchView(v){
  pitchView=(v==='concert')?'concert':'written';
  const pill=document.getElementById('pitch-pill');
  if(pill){
    pill.textContent=pitchView==='written'?'Written':'Concert';
    pill.classList.toggle('on',pitchView==='written');
  }
  safeStore.set('mn_pitchview',pitchView);
  relabelNoteButtons();
  if(typeof renderPartsList==='function'&&document.getElementById('parts-list')) renderPartsList();
  render();
}
function togglePitchView(){ applyPitchView(pitchView==='written'?'concert':'written'); }
// How a transposition reads on the page: "B♭" for +2, "E♭" for +9, and so on.
// Derived from the interval rather than a lookup table, so a custom value on
// an odd instrument still describes itself.
function transposeLabel(semis){
  if(!semis) return 'C (concert)';
  // An instrument is named for the pitch that sounds when its player reads C,
  // which is `semis` semitones *below* C — so this list is indexed by how far
  // down, not by pitch class. Indexing it by pitch class named every
  // instrument as its own inversion: a B♭ trumpet came out "D".
  const names=['C','B','B♭','A','A♭','G','G♭','F','E','E♭','D','D♭'];
  const down=((semis%12)+12)%12;
  const oct=semis>=12?' (8vb)':semis<=-12?' (8va)':'';
  return names[down]+oct;
}
const TRANSPOSE_CHOICES=[
  {v:0,  label:'C'},
  {v:2,  label:'B♭'},
  {v:9,  label:'E♭ alto'},
  {v:14, label:'B♭ tenor'},
  {v:7,  label:'F'},
  {v:3,  label:'A'},
  {v:12, label:'8vb'},
  {v:-12,label:'8va'},
];
function isTransposing(p){
  if(!p) return 0;
  const inst=IMAP[p.instId]||IMAP.piano;
  if(inst.unpitched||inst.drumset||inst.pitchedDrum) return 0;   // percussion has no key to move
  return (p.transpose!=null?p.transpose:(inst.transpose||0))|0;
}
// The shift actually applied when drawing this part right now.
function writtenSemis(p){ return pitchView==='written'?isTransposing(p):0; }
// Every one of these takes an optional measure index, because the key can now
// change part-way through the piece. Left out, they answer for the opening
// key — which is what the whole song used to be.
function concertFifths(mi){ return MAJOR_TO_FIFTHS[KMAP[keyAt(mi||0)]?.vfSig]??0; }
function partFifths(p,mi){ return transposeFifths(concertFifths(mi),writtenSemis(p)); }
function partVfSig(p,mi){ return FIFTHS_TO_MAJOR[String(partFifths(p,mi))]||'C'; }
function partScale(p,mi){
  const s=writtenSemis(p);
  const kd=KMAP[keyAt(mi||0)]||KEYS_DATA[0];
  if(!s) return kd.scale;
  const maj=scaleForFifths(partFifths(p,mi));
  // scaleForFifths answers with the *major* scale for that signature, which
  // for a minor key starts on the relative major's tonic — six degrees out.
  // Rotate it onto this key's own tonic so degree 0 is the tonic the player
  // reads, and the note buttons keep the order they have in concert.
  const t=kd.scale[0];
  const want=((NOTE_SEMI[t[0]]+accSemi(t[1])+s)%12+12)%12;
  const at=maj.findIndex(([n,a])=>((NOTE_SEMI[n]+accSemi(a))%12+12)%12===want);
  return at>0?maj.slice(at).concat(maj.slice(0,at)):maj;
}
// What to draw for one note on one part. With no transposition in play the
// stored spelling is used untouched, so a deliberate double-sharp or an odd
// enharmonic the user chose is never quietly rewritten.
function displayKeys(n,p,mi){
  const semis=writtenSemis(p);
  if(!semis||n.rest||n.repeatBars||!(n.midiVals||[]).length) return {keys:n.keys,vfAccs:n.vfAccs};
  const scale=partScale(p,mi), flat=partFifths(p,mi)<0;
  const res=n.midiVals.map(m=>spellInScale(m+semis,scale,flat));
  return {keys:res.map(r=>r.name+'/'+r.oct), vfAccs:res.map(r=>r.vfAcc)};
}
// The concert spelling to store for a note, so concert view stays correct for
// music entered while reading written pitch.
function spellConcert(midi,mi){
  const kd=KMAP[keyAt(mi||0)]||KEYS_DATA[0];
  return spellInScale(midi,kd.scale,FLAT_KEYS.includes(kd.vfSig||''));
}

// ═══════════════════════════════════════════════════════
// Time signature data
// ═══════════════════════════════════════════════════════
// `beats` is the bar's length in quarter notes, which is the unit everything
// downstream counts in — not the number the signature's top figure names.
const TIME_SIGS = [
  {sig:'4/4', beats:4,   vfB:4,  vfV:4},
  {sig:'3/4', beats:3,   vfB:3,  vfV:4},
  {sig:'2/4', beats:2,   vfB:2,  vfV:4},
  {sig:'5/4', beats:5,   vfB:5,  vfV:4},
  {sig:'6/4', beats:6,   vfB:6,  vfV:4},
  {sig:'2/2', beats:4,   vfB:2,  vfV:2},
  {sig:'3/2', beats:6,   vfB:3,  vfV:2},
  {sig:'6/8', beats:3,   vfB:6,  vfV:8},
  {sig:'9/8', beats:4.5, vfB:9,  vfV:8},
  {sig:'12/8',beats:6,   vfB:12, vfV:8},
  {sig:'3/8', beats:1.5, vfB:3,  vfV:8},
  {sig:'5/8', beats:2.5, vfB:5,  vfV:8},
  {sig:'7/8', beats:3.5, vfB:7,  vfV:8},
];
let currentTimeSig = TIME_SIGS[0];

// ── Changes of key and meter part-way through ───────────────────────────
// Both used to be properties of the whole song, so a piece that changes
// metre — or starts on beat 4 — could not be written at all. They are sparse
// maps of measure index -> value; measure 0 falls back to the song's opening
// key and metre, which is what currentKeyId/currentTimeSig now mean.
let sigChanges={};    // {measureIndex: '3/4'}
let keyChanges={};    // {measureIndex: 'G'}
// A pickup bar holds fewer beats than the metre says. 0 = none.
let pickupBeats=0;
// Index of the latest change at or before mi, or -1 for none.
function bestAt(map,mi){
  let at=-1;
  for(const k of Object.keys(map)){ const i=+k; if(i<=mi && i>at) at=i; }
  return at;
}
function timeSigAt(mi){
  const at=bestAt(sigChanges,mi);
  return (at>=0 && TIME_SIGS.find(t=>t.sig===sigChanges[at])) || currentTimeSig;
}
function beatsAt(mi){ return mi===0&&pickupBeats>0?pickupBeats:timeSigAt(mi).beats; }
function keyAt(mi){
  const at=bestAt(keyChanges,mi);
  return at>=0?(keyChanges[at]||currentKeyId):currentKeyId;
}
// True when measure mi opens with a signature the previous bar did not have,
// i.e. the point where it has to be drawn.
function sigChangeAt(mi){ return mi>0 && sigChanges[mi] && sigChanges[mi]!==timeSigAt(mi-1).sig; }
function keyChangeAt(mi){ return mi>0 && keyChanges[mi] && keyChanges[mi]!==keyAt(mi-1); }

// ═══════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════
let pid=1;
function mkPart(name,instId,clef){
  const inst=IMAP[instId];
  return{id:pid++,name,instId,clef:clef||null,notes:[],hairpins:[],transpose:(inst&&inst.transpose)||0,volume:100,muted:false};
}
let parts=[mkPart('Treble','piano','treble'), mkPart('Bass','piano','bass')];
let apIdx=0;

let currentKeyId='C';
let selDur='q', selAcc='key', selOct=0, dotted=false, tupletMode=false, tupletN=3, tupletCount=0;
let pendingLyric='', pendingDyn=null, pendingArts=[], pendingTempo=null, pendingRud=null, pendingSticking=null;
let graceMode=false, graceDur='8', pendingGraceNotes=[];
let hairpinPending=null;
let chordBuildMode=false;
let chord7Mode=false;
let pendingChordNotes=[];
let newInstId=null;

let notePositions=[];
let selectedNote=null;
// Insertion cursor sitting in a gap (not on a note): {partIdx, index} where
// index is "insert before notes[index]". Mutually exclusive with selectedNote;
// both null = append at the end of the active part.
let caretGap=null;
let measureXs=[], measureBeats=[], measureWs=[];
// Staff zoom. The page itself stays pinchable for anyone who needs bigger
// controls; this scales only the music, which is what you actually want to
// enlarge to read a dense passage or place a note precisely.
let scoreZoom=1;
const MIN_ZOOM=0.5, MAX_ZOOM=3;
// Set while a pinch is in progress: the click that follows a two-finger
// gesture must not be read as "tap a note".
let selectedNoteSuppressed=false;
// Repeats are a whole-piece structural property (the ensemble repeats
// together), not per-part — measure indices where a repeat barline draws.
let repeatStartMeasures=[], repeatEndMeasures=[];
// Copy/paste: copyRangeSel tracks the in-progress tap-start/tap-end range
// pick; clipboard holds the last copied notes (persists across part
// switches so you can paste into a different staff, and across pastes).
let copyMode=false, copyRangeSel=null, clipboard=null;

// ── Duration strings ─────────────────────────────────────
// A note's `dur` is base + optional 'd' (dot) + optional 't<N>' (tuplet size)
// + optional 'r' (rest) — in that order, e.g. "8t5" = eighth-note quintuplet,
// "qdt3r" = dotted-quarter-triplet rest. compose/decomposeDur keep every call
// site from hand-rolling that string.
function composeDur(base,dot,tupN,rest){ return base+(dot?'d':'')+(tupN?('t'+tupN):'')+(rest?'r':''); }
function decomposeDur(dur){
  const rest=dur.includes('r');
  const m=dur.match(/t(\d+)/); const tupN=m?parseInt(m[1],10):0;
  const dot=dur.includes('d');
  const base=dur.replace(/t\d+/,'').replace(/[dr]/g,'');
  return {base,dot,tupN,rest};
}
// Duration string with the 't<N>' tuplet marker removed — VexFlow's own
// duration syntax only understands 'd' (dot) and 'r' (rest) suffixes.
function stripTuplet(dur){ return dur.replace(/t\d+/,''); }
function tupletNumOf(dur){ return decomposeDur(dur).tupN; }

// Standard "notes occupied" for common tuplet sizes — how much normal time an
// N-tuplet group fills (e.g. a triplet's 3 notes fill the time 2 normally
// would). Anything not listed falls back to the nearest lower power of two,
// the same convention most notation software defaults to.
const TUPLET_RATIOS={2:3,3:2,4:3,5:4,6:4,7:4,9:8};
function tupletOccupied(n){ return TUPLET_RATIOS[n] || Math.pow(2,Math.floor(Math.log2(Math.max(n-1,1)))); }

const BV={w:4,h:2,q:1,'8':.5,'16':.25,'32':.125};
function durBeats(dur){
  const d=decomposeDur(dur);
  let mult=d.dot?1.5:1;
  if(d.tupN) mult*=tupletOccupied(d.tupN)/d.tupN;
  return (BV[d.base]??1)*mult;
}
// A measure-repeat marker always fills exactly one measure, regardless of
// time signature — it has no meaningful `dur` string of its own.
// A measure-repeat glyph fills whatever bar it lands in, which is no longer
// a single fixed length once the metre can change part-way through.
function noteBeats(n,mi){ return n.repeatBars ? beatsAt(mi==null?0:mi) : durBeats(n.dur); }

// ═══════════════════════════════════════════════════════
// Duration / rest SVG icons
// ═══════════════════════════════════════════════════════
function durIcon(base, isRest, dot){
  const D = dot ? "<circle cx='21' cy='19' r='1.5' fill='currentColor'/>" : "";
  let inner='';
  if(!isRest){
    const open ="<ellipse cx='9' cy='20' rx='5' ry='3.6' fill='none' stroke='currentColor' stroke-width='2' transform='rotate(-22 9 20)'/>";
    const fill ="<ellipse cx='9' cy='20' rx='5' ry='3.6' fill='currentColor' transform='rotate(-22 9 20)'/>";
    const stem ="<line x1='13.6' y1='19' x2='13.6' y2='3' stroke='currentColor' stroke-width='2'/>";
    const f1="<path d='M13.6 3 C19 5 19 10 16.5 12' fill='none' stroke='currentColor' stroke-width='2'/>";
    const f2="<path d='M13.6 8 C19 10 19 15 16.5 17' fill='none' stroke='currentColor' stroke-width='2'/>";
    const f3="<path d='M13.6 13 C19 15 19 20 16.5 22' fill='none' stroke='currentColor' stroke-width='2'/>";
    if(base==='w') inner="<ellipse cx='12' cy='16' rx='7' ry='4.6' fill='none' stroke='currentColor' stroke-width='2.4'/>";
    else if(base==='h') inner=open+stem;
    else if(base==='q') inner=fill+stem;
    else if(base==='8') inner=fill+stem+f1;
    else if(base==='16')inner=fill+stem+f1+f2;
    else if(base==='32')inner=fill+stem+f1+f2+f3;
  } else {
    if(base==='w') inner="<rect x='6' y='12.5' width='11' height='4.5' fill='currentColor'/><line x1='4' y1='12.5' x2='19' y2='12.5' stroke='currentColor' stroke-width='1.2'/>";
    else if(base==='h') inner="<rect x='6' y='13.5' width='11' height='4.5' fill='currentColor'/><line x1='4' y1='18' x2='19' y2='18' stroke='currentColor' stroke-width='1.2'/>";
    else if(base==='q') inner="<path d='M9 5 L14 11 L9.5 15 Q8 16.5 10.5 18.5 L14 23 Q9 21 8.5 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/>";
    else if(base==='8') inner="<circle cx='9' cy='9' r='2.2' fill='currentColor'/><path d='M11 8 L7.5 21' stroke='currentColor' stroke-width='1.8' fill='none'/>";
    else if(base==='16')inner="<circle cx='9' cy='8' r='2' fill='currentColor'/><circle cx='11' cy='14' r='2' fill='currentColor'/><path d='M13 7 L7.5 22' stroke='currentColor' stroke-width='1.8' fill='none'/>";
    else if(base==='32')inner="<circle cx='9' cy='7' r='1.9' fill='currentColor'/><circle cx='11' cy='12' r='1.9' fill='currentColor'/><circle cx='13' cy='17' r='1.9' fill='currentColor'/><path d='M15 6 L7.5 23' stroke='currentColor' stroke-width='1.8' fill='none'/>";
  }
  return "<svg viewBox='0 0 24 30' style='display:block;margin:auto'>"+inner+D+"</svg>";
}
function refreshDurIcons(){
  [['w','d-w'],['h','d-h'],['q','d-q'],['8','d-8'],['16','d-16'],['32','d-32']].forEach(([b,id])=>{
    const icon=durIcon(b,false,false);
    document.getElementById(id).innerHTML=icon;
    const qe=document.getElementById('qe-'+id); if(qe) qe.innerHTML=icon;
  });
  document.getElementById('rest-btn').innerHTML=durIcon(selDur,true,dotted);
}
