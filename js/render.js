// ═══════════════════════════════════════════════════════════════════════
// MōdScore — Grouping notes into measures, drawing the score, and zoom
// ═══════════════════════════════════════════════════════════════════════
// Part of a single shared script, split across files so a change to one
// concern is not a change inside a five-thousand-line file. These load as
// ordinary scripts, in the order index.html lists them, and share one global
// scope exactly as they did when they were one block — see js/README.md for
// why it is not ES modules.

// ═══════════════════════════════════════════════════════
// Measure grouping & dynamic width
// ═══════════════════════════════════════════════════════
// Every writable duration, longest first, in quarter-beats — used to express
// an arbitrary leftover span as real note values.
const SPLIT_DURS=[
  ['w',4],['hd',3],['h',2],['qd',1.5],['q',1],
  ['8d',.75],['8',.5],['16d',.375],['16',.25],['32',.125],
];
// Break a span of beats into the fewest notated durations that add up to it,
// longest first — 2.5 beats becomes a half tied to an eighth.
function beatsToDurs(beats){
  const out=[]; let left=beats;
  for(const [d,v] of SPLIT_DURS){
    while(left>=v-1e-6){ out.push(d); left-=v; }
    if(left<=1e-6) break;
  }
  return out.length?out:['32'];
}
function durWithFlags(base,src){
  const d=decomposeDur(src.dur);
  // base already encodes its own dot; carry the rest marker across.
  return base+(d.rest?'r':'');
}
// Groups a part's notes into measures.
//
// A note whose value runs past the end of the bar used to be dropped into the
// bar whole, so a half note starting on beat 3 of 3/4 produced a four-beat
// bar. Nothing rejected it — the VexFlow voice is in SOFT mode — so the bar
// simply held more music than the time signature allows, every later bar in
// that part slid out of step with the other staves, and notes ended up
// crowding and crossing the barlines.
//
// Such a note is now split at the barline into tied pieces, which is how the
// value has to be written anyway. The split is a *view* of the note stream,
// recomputed on every render: durations reflow as soon as anything earlier
// changes, so where the barlines fall can't be baked into the stored notes.
//
// Items carry srcIdx (the index of the note they came from) so selection,
// tapping, hairpins and playback all still speak in terms of real notes
// rather than pieces.
function toMeasures(notes){
  // Bar capacity is no longer one number: a pickup bar is short, and a metre
  // change resizes every bar after it. BMAX is therefore re-read for whichever
  // bar is currently being filled.
  const ms=[]; let cur=[], beats=0;
  let BMAX=beatsAt(0);
  const closeIfFull=()=>{ if(beats>=BMAX-.001){ ms.push(cur); cur=[]; beats=0; BMAX=beatsAt(ms.length); } };
  // A stored tie holds one note into the next. Every piece pushed below needs
  // to know where it sits in such a chain, so resolve that up front:
  // tiedOut(i) — note i is held into i+1; tiedIn(i) — note i continues i-1.
  // tieFrom says a piece continues something; contFrom says specifically that
  // it is the tail of the SAME stored note, split by a barline. The measure
  // operations need the second: a barline between two tied notes still has a
  // note index that means "the start of this bar", but one through the middle
  // of a single note does not.
  const tiedOut=i=>tieHoldsAt(notes,i);
  const tiedIn=i=>i>0&&tieHoldsAt(notes,i-1);
  // How long the whole held chain starting at i sounds for. Playback and MIDI
  // read soundBeats off the piece that actually speaks (the one without
  // tieFrom), so a chain has to report its total there, not its first note's
  // written value. Walked backwards so each note can reuse the next one's sum.
  const chain=new Array(notes.length).fill(0);
  for(let i=notes.length-1;i>=0;i--) chain[i]=noteBeats(notes[i])+(tiedOut(i)?chain[i+1]:0);
  notes.forEach((n,srcIdx)=>{
    // Measure repeats and tuplet members are never split: a repeat glyph owns
    // a whole bar by definition, and cutting a tuplet apart would destroy the
    // ratio the group is drawn and played with.
    const atomic=n.repeatBars||tupletNumOf(n.dur);
    let left=noteBeats(n), first=true;
    if(atomic){
      cur.push({...n,srcIdx,tieFrom:tiedIn(srcIdx),tieTo:tiedOut(srcIdx),tieToNext:tiedOut(srcIdx),contFrom:false,soundBeats:chain[srcIdx]});
      beats+=left; closeIfFull(); return;
    }
    while(left>1e-6){
      const space=BMAX-beats;
      if(space<=1e-6){ ms.push(cur); cur=[]; beats=0; BMAX=beatsAt(ms.length); continue; }
      if(left<=space+1e-6){
        if(first){
          // Untouched note — keep its own duration string so dots and rests
          // survive exactly as written. Its tie flags are whatever the stored
          // tie says, since nothing was split here.
          cur.push({...n,srcIdx,tieFrom:tiedIn(srcIdx),tieTo:tiedOut(srcIdx),tieToNext:tiedOut(srcIdx),contFrom:false,soundBeats:chain[srcIdx]});
        }else{
          // Tail of a split. It has to be written as whatever is actually
          // left, not the note's original value — carrying the full duration
          // over was what made the following bar overfull in turn.
          const tail=beatsToDurs(left);
          tail.forEach((pd,k)=>{
            const last=k===tail.length-1;
            cur.push({...n,dur:durWithFlags(pd,n),srcIdx,tieFrom:true,contFrom:true,
              tieTo:last?tiedOut(srcIdx):true,tieToNext:last&&tiedOut(srcIdx),soundBeats:chain[srcIdx]});
          });
        }
        beats+=left; left=0;
      }else{
        // Fill what's left of this bar, then carry the remainder over.
        const pieces=beatsToDurs(space);
        pieces.forEach((pd,k)=>{
          cur.push({...n,dur:durWithFlags(pd,n),srcIdx,contFrom:!first||k>0,
            tieFrom:(!first||k>0)?true:tiedIn(srcIdx),tieTo:true,tieToNext:false,soundBeats:chain[srcIdx]});
        });
        beats+=space; left-=space; first=false;
      }
      closeIfFull();
    }
  });
  if(cur.length)ms.push(cur);
  return ms;
}
// Which measure (0-based) a given note index in a part falls into.
function measureIndexOfNote(partIdx, noteIdx){
  // Derived from toMeasures rather than re-deriving the accumulation, so a
  // note that got split at a barline reports the bar it starts in and the two
  // can never disagree.
  const ms=toMeasures(parts[partIdx]?.notes||[]);
  for(let mi=0;mi<ms.length;mi++){
    if(ms[mi].some(it=>it.srcIdx===noteIdx)) return mi;
  }
  return Math.max(0,ms.length-1);
}
function toggleRepeatStart(){
  if(!selectedNote){ toast('Select a note first — the repeat marks that note’s bar.','warn'); return; }
  const mi=measureIndexOfNote(selectedNote.partIdx, selectedNote.noteIdx);
  const idx=repeatStartMeasures.indexOf(mi);
  if(idx>=0) repeatStartMeasures.splice(idx,1); else repeatStartMeasures.push(mi);
  render();
}
function toggleRepeatEnd(){
  if(!selectedNote){ toast('Select a note first — the repeat marks that note’s bar.','warn'); return; }
  const mi=measureIndexOfNote(selectedNote.partIdx, selectedNote.noteIdx);
  const idx=repeatEndMeasures.indexOf(mi);
  if(idx>=0) repeatEndMeasures.splice(idx,1); else repeatEndMeasures.push(mi);
  render();
}
// A measure-repeat ("simile") symbol replaces an entire measure's content —
// only valid to insert right at a fresh measure boundary. An n-bar repeat
// fills n whole measures (each looking n bars back), so a single "Repeat Last
// 2/4" tap reproduces the entire previous 2- or 4-bar phrase — you no longer
// have to stamp the symbol once per bar.
function addMeasureRepeat(n){
  const part=parts[apIdx];
  let beats=0, completedMeasures=0, BMAX=beatsAt(0);
  part.notes.forEach(nn=>{ beats+=noteBeats(nn,completedMeasures); if(beats>=BMAX-.001){ beats=0; completedMeasures++; BMAX=beatsAt(completedMeasures); } });
  if(beats>0.001){ toast('A measure repeat only goes at the start of a new bar.','warn'); return; }
  if(completedMeasures<n){ toast('Need at least '+n+' previous bar'+(n>1?'s':'')+' to repeat.','warn'); return; }
  for(let k=0;k<n;k++){
    part.notes.push({repeatBars:n, rest:false, keys:['b/4'], midiVals:[], dur:'w', vfAccs:[null], lyric:null, dyn:null, arts:[], tempo:null, rud:null, grace:[], sticking:null});
  }
  selectedNote=null;
  render(); scrollToNoteEnd(apIdx);
}

// Resolves the clef a part actually renders/plays in: an explicit per-part
// override wins, otherwise fall back to the instrument's idiomatic clef.
function partClefFor(p){
  const inst=IMAP[p.instId]||IMAP['piano'];
  return p.clef||(inst.clef==='percussion'?'percussion':(inst.clef||'treble'));
}

const BASE_MW=190, PX_PER_NOTE=46, FX=115, PG=90, TP=22;
// Notes need horizontal room roughly proportional to their duration — counting
// every note as the same 1 unit (regardless of whether it's a whole note or a
// 32nd) squashed long-note measures and over-spread short-note ones, which is
// most of what read as "wonky spacing."
const DUR_WIDTH_UNITS={w:3.5,h:2.2,q:1.4,'8':1,'16':.75,'32':.6};
// Duration-proportional spacing alone underestimates a bar packed with short
// notes: sixteenths get 0.75 units (~35px) each, but a notehead plus its
// accidental, dot and the gap to the next note simply cannot be drawn in that.
// VexFlow then formatted past the stave and the last notes of dense bars were
// laid down on top of, or beyond, the barline. These are the floors below
// which a note cannot be squeezed, whatever its value.
const MIN_NOTE_PX=46, ACC_PX=18, DOT_PX=10;
// The floors above describe the room the *notes* need; the stave also gives up
// EDGE_PAD before its barline (see the Formatter call in drawVoice), so the
// measure has to be that much wider or the last note lands on the barline.
const EDGE_PAD=30;
function calcMW(allM, mi){
  let maxW=0;
  for(const pm of allM){
    const md=pm[mi]||[]; let units=0, floor=0;
    md.forEach(n=>{
      const base=decomposeDur(n.dur).base;
      units+=DUR_WIDTH_UNITS[base]??1;
      floor+=MIN_NOTE_PX;
      if(n.dur.includes('d')){ units+=0.35; floor+=DOT_PX; }
      const accs=(n.vfAccs||[]).filter(a=>a&&a!=='n').length;
      units+=accs*0.5; floor+=accs*ACC_PX;
    });
    maxW=Math.max(maxW, units*PX_PER_NOTE, floor);
  }
  // A bar that opens with a new key or metre has to fit those glyphs before
  // its first note, or the change crowds the music it introduces.
  let extra=0;
  if(sigChangeAt(mi)) extra+=28;
  if(keyChangeAt(mi)) extra+=14+11*Math.max(Math.abs(partFifths(parts[0],mi)),Math.abs(partFifths(parts[0],mi-1)));
  // A short bar gets a proportionally smaller floor, so a one-beat pickup is
  // drawn as the short bar it is rather than a full-width bar holding one note.
  const cap=beatsAt(mi), full=timeSigAt(mi).beats;
  const floorW=BASE_MW*Math.max(0.35,Math.min(1,cap/(full||4)));
  return Math.max(floorW, Math.round(maxW)+EDGE_PAD+extra);
}

// ═══════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════
// How much off-screen music to keep drawn either side of the viewport, in
// screenfuls. Enough that ordinary scrolling and note entry stay ahead of the
// window, without paying to draw the whole piece.
const RENDER_MARGIN=1.5;
// The measure the user is working in. It is drawn no matter where the score is
// scrolled, so the code that runs straight after a render — scrollToNoteEnd(),
// renderCaret(), the tap hit-test — always finds the note it just placed.
function focusMeasureIndex(){
  try{
    if(selectedNote) return measureIndexOfNote(selectedNote.partIdx,selectedNote.noteIdx);
    if(caretGap) return measureIndexOfNote(caretGap.partIdx,Math.max(0,caretGap.index-1));
    const n=parts[apIdx]?.notes.length||0;
    return n?measureIndexOfNote(apIdx,n-1):0;
  }catch(e){ return 0; }
}
// Which measures are worth painting, given the scroll position. Measure x
// positions come from the full layout, so the SVG keeps its true width and
// scrolling geometry is identical whether or not a measure was drawn.
function measureWindow(measureXs,mws,numM){
  const wrap=document.getElementById('score-wrap');
  const cw=wrap?.clientWidth||900, sl=wrap?.scrollLeft||0;
  const lo=sl-cw*RENDER_MARGIN, hi=sl+cw*(1+RENDER_MARGIN);
  let first=numM, last=-1;
  for(let mi=0;mi<numM;mi++){
    const x0=measureXs[mi], x1=x0+mws[mi];
    if(x1>=lo && x0<=hi){ if(mi<first)first=mi; if(mi>last)last=mi; }
  }
  if(last<0){ first=0; last=Math.min(numM-1,0); }
  // The cursor's measure is kept drawn as a separate small band, not by
  // stretching the visible range to reach it — with the cursor at bar 90 and
  // the view at bar 1, merging the two would mean drawing the whole piece.
  const fm=focusMeasureIndex();
  const fFirst=Math.max(0,Math.min(numM-1,fm-1)), fLast=Math.max(0,Math.min(numM-1,fm+1));
  return {first,last,fFirst,fLast};
}
function inWindow(win,mi){
  return (mi>=win.first&&mi<=win.last)||(mi>=win.fFirst&&mi<=win.fLast);
}
let _lastWindow='';
const windowKey=w=>w.first+':'+w.last+':'+w.fFirst+':'+w.fLast;
// Paint only. render() is for "the music changed"; this is for "the view
// moved", and must not touch undo history or autosave.
function redraw(){ drawScore(); renderCaret(); }
function render(){
  drawScore();
  renderCaret();
  renderClefGutter();
  updatePartPill();
  scheduleScoreOutline();
  maybeRecordHistory();
  scheduleAutosave();
}
function drawScore(){
  const VF=Vex.Flow;
  const{Renderer,Stave,StaveNote,Voice,Formatter,Accidental,StaveConnector,Beam,Annotation,Articulation,StaveHairpin,StaveTie,Dot,Barline}=VF;
  const div=document.getElementById('score-div');
  div.innerHTML='';
  notePositions=[];

  const allM=parts.map(p=>toMeasures(p.notes));
  const numM=Math.max(...allM.map(m=>m.length),1);
  const numP=parts.length;
  const kd=KMAP[currentKeyId];
  const partClefs=parts.map(partClefFor);

  const mws=Array.from({length:numM},(_,mi)=>calcMW(allM,mi));
  const totalW=FX+mws.reduce((a,b)=>a+b,0)+40;
  const totalH=TP+numP*PG+30;

  // Per-measure duration (beats), used by playScore() to time the playback auto-scroll.
  measureBeats=Array.from({length:numM},(_,mi)=>{
    let mx=0;
    allM.forEach(pm=>{ const arr=pm[mi]||[]; const b=arr.reduce((s,n)=>s+noteBeats(n),0); if(b>mx)mx=b; });
    return mx||beatsAt(mi);
  });
  measureXs=[];

  const renderer=new Renderer(div,Renderer.Backends.SVG);
  // Scale the surface and the drawing context rather than CSS-transforming
  // the result, so the notation is re-rasterised at the new size and stays
  // crisp instead of being blown up.
  renderer.resize(Math.round(totalW*scoreZoom),Math.round(totalH*scoreZoom));
  const ctx=renderer.getContext();
  if(scoreZoom!==1) ctx.scale(scoreZoom,scoreZoom);

  const vfRefs=parts.map(()=>({}));
  const partOff=new Array(numP).fill(0);
  pendingTieOut=[]; pendingTieIn=[];

  // Full layout first — every measure's x and width. This is pure arithmetic
  // and cheap; it's the drawing that costs, so the window below decides what
  // to paint while the geometry stays complete for scrolling and playback.
  {
    let lx=10;
    // Stored scaled: every consumer (the render window, scrollToMeasure)
    // compares these against scrollLeft, which is screen pixels.
    for(let mi=0;mi<numM;mi++){ measureXs.push(lx*scoreZoom); lx+=(mi===0?mws[mi]+FX:mws[mi]); }
  }
  measureWs=mws.map((w,i)=>(i===0?w+FX:w)*scoreZoom);
  const win=measureWindow(measureXs,measureWs,numM);
  _lastWindow=windowKey(win);

  let x=10;
  for(let mi=0;mi<numM;mi++){
    const first=mi===0;
    const mw=first?mws[mi]+FX:mws[mi];

    // Outside the window: skip the drawing entirely, but keep each part's
    // running note offset advancing, or every noteIdx after this measure
    // would be wrong.
    if(!inWindow(win,mi)){
      parts.forEach((p,pi)=>{ partOff[pi]+=(allM[pi][mi]||[]).length; });
      x+=mw;
      continue;
    }

    const staves=parts.map((p,pi)=>{
      const inst=IMAP[p.instId]||IMAP['piano'];
      const cl=partClefs[pi];
      const sy=TP+pi*PG;
      const st=new Stave(x,sy,mw);
      if(inst.staffLines===1)st.setConfigForLines([{visible:false},{visible:false},{visible:true},{visible:false},{visible:false}]);
      // The opening bar carries clef, key and metre; later bars carry only
      // what actually changes there.
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
        const i0=IMAP[parts[0].instId],i1=IMAP[parts[1].instId];
        if(i0&&i1&&i0.cat==='Keyboard'&&i1.cat==='Keyboard'&&parts[0].clef!==parts[1].clef){
          try{new StaveConnector(staves[0],staves[1]).setType('brace').setContext(ctx).draw();}catch(e){}
        }
        new StaveConnector(staves[0],staves[numP-1]).setType('singleLeft').setContext(ctx).draw();
      }
      new StaveConnector(staves[0],staves[numP-1]).setType('singleRight').setContext(ctx).draw();
    }

    staves.forEach((st,pi)=>{
      const noteData=allM[pi][mi]||[];
      const vfNotes=drawVoice(ctx,st,noteData,mw,VF,pi,partOff[pi],partClefs[pi],parts[pi],timeSigAt(mi),mi);
      noteData.forEach((it,li)=>{if(vfNotes[li])vfRefs[pi][(it.srcIdx!=null)?it.srcIdx:partOff[pi]+li]={vfNote:vfNotes[li],stave:st};});
      partOff[pi]+=noteData.length;
    });
    x+=mw;
  }

  parts.forEach((part,pi)=>{
    (part.hairpins||[]).forEach(hp=>{
      const s=vfRefs[pi][hp.start],e=vfRefs[pi][hp.end];
      if(!s||!e)return;
      try{
        const h=new StaveHairpin({first_note:s.vfNote,last_note:e.vfNote,first_indices:[0],last_indices:[0]},
          hp.type==='cresc'?StaveHairpin.type.CRESC:StaveHairpin.type.DECRESC);
        h.setContext(ctx).setStave(s.stave).draw();
      }catch(err){console.warn('Hairpin:',err.message);}
    });
  });

  // Ties that cross a barline: match each note leaving a bar with the same
  // note arriving in the next one. Both ends exist only when both bars are
  // inside the render window, which is why this runs after the whole loop.
  pendingTieOut.forEach(o=>{
    const i=pendingTieIn.find(v=>v.partIdx===o.partIdx&&v.srcIdx===o.matchIdx);
    if(!i)return;
    try{
      new StaveTie({first_note:o.vfNote,last_note:i.vfNote,first_indices:[0],last_indices:[0]})
        .setContext(ctx).draw();
    }catch(e){}
  });

  drawPartLabels(div.querySelector('svg'),Math.round(4*scoreZoom));

  // VexFlow reports note metrics in unscaled user units. Everything that
  // consumes notePositions — the tap hit-test, the caret, scrollToNoteEnd —
  // works in screen pixels, so convert once here.
  if(scoreZoom!==1) notePositions.forEach(q=>{ q.x*=scoreZoom; q.y*=scoreZoom; q.h*=scoreZoom; });

  renderCaret();
  renderClefGutter();
  updatePartPill();
  maybeRecordHistory();
  scheduleAutosave();
}

// Draws the frozen clef+key overlay: one stave per part at the same vertical
// geometry as the real score, so the glyphs line up exactly with the staff
// lines scrolling behind them. Deliberately omits the time signature — that
// applies at the start of the piece, and repeating it beside bar 30 would
// assert a meter change that isn't there.

// Which instrument each staff is. On a multi-part score you would otherwise
// have to scroll back to the top, or count staves, to know which line you are
// writing into — so the name sits under every staff, and the one you are
// actually editing is picked out in the accent colour.
const SVGNS='http://www.w3.org/2000/svg';
function partLabelText(p){
  const inst=IMAP[p.instId];
  const nm=(inst&&inst.label)||p.name||'Part';
  return (p.name&&p.name!==nm)?(p.name+' · '+nm):nm;
}
function drawPartLabels(svg,xPx){
  if(!svg)return 0;
  let widest=0;
  parts.forEach((p,pi)=>{
    const t=document.createElementNS(SVGNS,'text');
    t.setAttribute('x',xPx);
    // In the gap below this staff's five lines, clear of both the clef above
    // and the next staff below.
    t.setAttribute('y',Math.round((TP+pi*PG+93)*scoreZoom));
    t.setAttribute('font-size',Math.round(9*scoreZoom));
    t.setAttribute('font-family','-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif');
    t.setAttribute('font-weight',pi===apIdx?'700':'400');
    t.setAttribute('fill',pi===apIdx?'#c62b45':'#000');
    t.setAttribute('opacity',pi===apIdx?'0.9':'0.38');
    t.setAttribute('pointer-events','none');
    t.textContent=partLabelText(p);
    svg.appendChild(t);
    // Keep clear of the first notehead — a long name like
    // "Marching Bass · Marching Bass" would otherwise run under the music.
    try{
      // Bar 0's first notehead sits ~75px in even in C major (the tightest
      // key signature), so stay well short of it — stems from the staff above
      // reach down into this band.
      const cap=62*scoreZoom;
      let txt=t.textContent;
      while(t.getComputedTextLength()>cap && txt.length>4){
        txt=txt.slice(0,-2); t.textContent=txt+'…';
      }
      widest=Math.max(widest,t.getComputedTextLength());
    }catch(e){}
  });
  return widest;
}
let pendingTieOut=[], pendingTieIn=[];
let _gutterW=0;
function renderClefGutter(){
  const host=document.getElementById('clef-gutter');
  if(!host)return;
  host.innerHTML='';
  if(!parts.length){ host.style.display='none'; return; }
  const VF=Vex.Flow, {Renderer,Stave,StaveConnector}=VF;
  const kd=KMAP[currentKeyId];
  const numP=parts.length;
  const PROBE=260;  // generous stave width; the host clips to what's used
  try{
    const renderer=new Renderer(host,Renderer.Backends.SVG);
    // Matches the staff's own zoom, or the frozen clef would drift out of
    // alignment with the staff lines scrolling behind it.
    renderer.resize(Math.round(PROBE*scoreZoom),Math.round((TP+numP*PG+30)*scoreZoom));
    const ctx=renderer.getContext();
    if(scoreZoom!==1) ctx.scale(scoreZoom,scoreZoom);
    let endX=0;
    const staves=parts.map((p,pi)=>{
      const inst=IMAP[p.instId]||IMAP['piano'];
      const st=new Stave(10,TP+pi*PG,PROBE);
      if(inst.staffLines===1)st.setConfigForLines([{visible:false},{visible:false},{visible:true},{visible:false},{visible:false}]);
      st.addClef(partClefFor(p)).addKeySignature(partVfSig(p));
      st.setContext(ctx).draw();
      endX=Math.max(endX,st.getNoteStartX());
      return st;
    });
    if(numP>=2) new StaveConnector(staves[0],staves[numP-1]).setType('singleLeft').setContext(ctx).draw();
    const labelW=drawPartLabels(host.querySelector('svg'),Math.round(4*scoreZoom));
    // Wide enough for the clef and key, or the longest instrument name.
    _gutterW=Math.round(Math.max(Math.min(PROBE,endX+4)*scoreZoom, labelW+20*scoreZoom));
    host.style.width=_gutterW+'px';
    host.style.height=Math.round((TP+numP*PG+30)*scoreZoom)+'px';
  }catch(e){ host.innerHTML=''; _gutterW=0; }
  syncClefGutter();
}
// Pins the overlay to the left edge of the scroll viewport. Absolute children
// of the scroller scroll with the content, so left must track scrollLeft;
// top stays 0 so it scrolls vertically with the staves it belongs to.
function syncClefGutter(){
  const wrap=document.getElementById('score-wrap');
  const host=document.getElementById('clef-gutter');
  if(!wrap||!host||!_gutterW)return;
  const sl=wrap.scrollLeft;
  // Below this the real clef is still on screen and the overlay would just
  // be a smudged double image of it.
  if(sl<=6){ host.style.display='none'; return; }
  host.style.display='block';
  host.style.left=sl+'px';
}
// Scrolling moves the render window, so the staff has to be repainted as new
// measures come into range — but only when the window actually changes, and
// never through render() (that would spam undo history and autosave with
// entries for merely looking at the score).
let _scrollRaf=0;
function onScoreScroll(){
  syncClefGutter();
  if(_scrollRaf)return;
  _scrollRaf=requestAnimationFrame(()=>{
    _scrollRaf=0;
    if(!measureXs.length||!measureWs.length)return;
    const w=measureWindow(measureXs,measureWs,measureXs.length);
    if(windowKey(w)!==_lastWindow) redraw();
  });
}
document.getElementById('score-wrap').addEventListener('scroll',onScoreScroll,{passive:true});

// ═══════════════════════════════════════════════════════
// Pinch to zoom the staff
// ═══════════════════════════════════════════════════════
// Spread two fingers to make the music bigger, pinch them together to make it
// smaller. Only the staff scales — the controls stay the size they were, which
// is the whole reason this exists rather than leaning on the browser's page
// zoom. #score-wrap declares touch-action:pan-x pan-y so the browser hands us
// the two-finger gesture instead of zooming the page out from under us.
let _pinch=null, _zoomRaf=0;
function clampZoom(z){ return Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,z)); }
function touchDist(t){
  const dx=t[0].clientX-t[1].clientX, dy=t[0].clientY-t[1].clientY;
  return Math.hypot(dx,dy)||1;
}
function touchMid(t){
  return {x:(t[0].clientX+t[1].clientX)/2, y:(t[0].clientY+t[1].clientY)/2};
}
// Zoom about a fixed point on screen: whatever bar was under the midpoint of
// your fingers stays under it, so the music grows around what you're looking
// at instead of sliding away toward bar 1.
function setScoreZoom(z,anchor){
  const wrap=document.getElementById('score-wrap');
  const prev=scoreZoom;
  const next=clampZoom(z);
  if(Math.abs(next-prev)<0.001) return;
  let ax=0, ay=0, sx=0, sy=0;
  if(wrap&&anchor){
    const r=wrap.getBoundingClientRect();
    ax=anchor.x-r.left; ay=anchor.y-r.top;
    sx=(wrap.scrollLeft+ax)/prev; sy=(wrap.scrollTop+ay)/prev;   // score-space point under the fingers
  }
  scoreZoom=next;
  redraw();
  renderClefGutter();
  if(wrap&&anchor){
    wrap.scrollLeft=Math.max(0,sx*next-ax);
    wrap.scrollTop=Math.max(0,sy*next-ay);
  }
  syncClefGutter();
  showZoomBadge();
  // Someone who needs 150% to read the staff should not have to set it again
  // every session — and they are the least likely to enjoy doing so.
  safeStore.set('mn_zoom',String(scoreZoom));
}
function resetScoreZoom(){ setScoreZoom(1,null); }
// Deliberately coarse: pinching to half size means bringing your fingers all
// the way together, so the buttons get there in two taps instead.
const ZOOM_STEPS=[0.5,0.75,1,1.5,2,3];
function stepZoom(dir){
  const eps=0.01;
  let next;
  if(dir>0) next=ZOOM_STEPS.find(z=>z>scoreZoom+eps) ?? ZOOM_STEPS[ZOOM_STEPS.length-1];
  else{ const below=ZOOM_STEPS.filter(z=>z<scoreZoom-eps); next=below.length?below[below.length-1]:ZOOM_STEPS[0]; }
  // Zoom about the middle of the visible staff so the bar you are reading stays put.
  const wrap=document.getElementById('score-wrap');
  const r=wrap?wrap.getBoundingClientRect():null;
  setScoreZoom(next, r?{x:r.left+r.width/2,y:r.top+r.height/2}:null);
}

let _zoomBadgeTimer=0;
function showZoomBadge(){
  const el=document.getElementById('zoom-badge'); if(!el)return;
  const wrap=document.getElementById('score-wrap');
  el.textContent=Math.round(scoreZoom*100)+'%';
  el.style.display='block';
  // Anchored to the score pane's top-right corner, which sits in a different
  // place in portrait than in the landscape two-column grid.
  if(wrap){
    const r=wrap.getBoundingClientRect();
    el.style.left=Math.round(r.right-el.offsetWidth-10)+'px';
    el.style.top=Math.round(r.top+8)+'px';
  }
  clearTimeout(_zoomBadgeTimer);
  _zoomBadgeTimer=setTimeout(()=>{ el.style.display='none'; },1100);
}

(function initPinch(){
  const wrap=document.getElementById('score-wrap');
  if(!wrap)return;
  wrap.addEventListener('touchstart',e=>{
    if(e.touches.length===2){
      // Claim the gesture here. touch-action:pan-x pan-y stops the browser
      // page-zooming, but it still treats two fingers as a pan and will
      // swallow the rest of the moves unless the sequence is cancelled at
      // its start — which is what leaves a pinch applying only its first
      // increment and then dying.
      e.preventDefault();
      _pinch={d:touchDist(e.touches), z:scoreZoom, target:0, mid:touchMid(e.touches)};
      selectedNoteSuppressed=true;   // a two-finger gesture is not a note tap
    }
  },{passive:false});
  wrap.addEventListener('touchmove',e=>{
    if(!_pinch||e.touches.length!==2)return;
    e.preventDefault();
    // Keep only the newest target and let the frame apply that. Capturing the
    // value in the scheduled callback instead would pin the zoom to whichever
    // move happened to win the race and silently drop the rest of the gesture,
    // so a big spread would land far short of where the fingers went.
    _pinch.target=_pinch.z*(touchDist(e.touches)/_pinch.d);
    _pinch.mid=touchMid(e.touches);
    if(_zoomRaf)return;
    _zoomRaf=requestAnimationFrame(()=>{
      _zoomRaf=0;
      if(_pinch) setScoreZoom(_pinch.target,_pinch.mid);
    });
  },{passive:false});
  const end=e=>{
    if(_pinch&&(!e.touches||e.touches.length<2)){
      // Settle on where the fingers actually finished — a pending frame that
      // fires after this would otherwise be discarded mid-gesture.
      const t=_pinch.target, m=_pinch.mid;
      _pinch=null;
      if(t) setScoreZoom(t,m);
      // Let the tap handler run again only after the fingers are fully off,
      // or lifting one finger from a pinch would drop a cursor.
      setTimeout(()=>{ selectedNoteSuppressed=false; },80);
    }
  };
  // Bound on document, not just the staff: a finger that drifts off the score
  // before lifting ends the gesture somewhere else entirely, and if we miss
  // that the tap handler would stay suppressed and the score would go dead to
  // touch until reload.
  wrap.addEventListener('touchend',end);
  wrap.addEventListener('touchcancel',end);
  document.addEventListener('touchend',end,true);
  document.addEventListener('touchcancel',end,true);
  // Last-resort release. Nothing should reach this, but "the score stopped
  // responding to taps" is too costly a failure to leave to event bookkeeping.
  setInterval(()=>{
    if(selectedNoteSuppressed&&!_pinch) selectedNoteSuppressed=false;
  },1500);
  // Trackpad and mouse: ctrl/⌘ + wheel is the usual convention for zoom.
  wrap.addEventListener('wheel',e=>{
    if(!(e.ctrlKey||e.metaKey))return;
    e.preventDefault();
    setScoreZoom(scoreZoom*(e.deltaY<0?1.1:1/1.1),{x:e.clientX,y:e.clientY});
  },{passive:false});
})();

// Keep the note just written visible — scroll the staff view only if it's
// currently out of frame, so composing never requires manually scrolling right.
function scrollToNoteEnd(partIdx){
  const wrap=document.getElementById('score-wrap');
  const cands=notePositions.filter(p=>p.partIdx===partIdx);
  if(!cands.length)return;
  const last=cands[cands.length-1];
  const margin=90;
  if(last.x+margin>wrap.scrollLeft+wrap.clientWidth || last.x<wrap.scrollLeft){
    wrap.scrollTo({left:Math.max(0,last.x+margin-wrap.clientWidth),top:wrap.scrollTop,behavior:SCROLL_BEHAVIOR});
  }
}

// Follows the currently-playing measure during playback (see the schedule
// calls in playScore()) — always scrolls, unlike scrollToNoteEnd's "only if
// offscreen" check, since during playback the view should actively track.
function scrollToMeasure(mi){
  const wrap=document.getElementById('score-wrap');
  const tx=measureXs[mi];
  if(tx==null)return;
  wrap.scrollTo({left:Math.max(0,tx-30),top:wrap.scrollTop,behavior:SCROLL_BEHAVIOR});
}

// ── Playhead ────────────────────────────────────────────
// Playback scrolled the staff and marked nothing, so in a dense bar there was
// no way to tell where you were. This sweeps a line across the bar being
// played, driven by rAF against the transport clock rather than by scheduling
// an event per note.
let _phRaf=0, _phPlan=null;
function ensurePlayhead(){
  const div=document.getElementById('score-div');
  if(!div) return null;
  let ph=document.getElementById('score-playhead');
  if(!ph){ ph=document.createElement('div'); ph.id='score-playhead'; div.appendChild(ph); }
  return ph;
}
// plan: [{mi, startSec, endSec}] in playback order.
function startPlayhead(plan,offsetSec){
  _phPlan={plan,offset:offsetSec||0};
  const ph=ensurePlayhead(); if(!ph)return;
  ph.style.display='block';
  const step=()=>{
    if(!playing||!_phPlan){ stopPlayhead(); return; }
    const now=Tone.getTransport().seconds+_phPlan.offset;
    const seg=_phPlan.plan.find(s=>now>=s.startSec&&now<s.endSec);
    if(seg){
      const x0=measureXs[seg.mi], w=measureWs[seg.mi]||0;
      if(x0!=null){
        const frac=Math.max(0,Math.min(1,(now-seg.startSec)/Math.max(.001,seg.endSec-seg.startSec)));
        ph.style.transform='translateX('+(x0+w*frac)+'px)';
        // Same staff band the caret uses: VexFlow starts the 5 lines ~34px
        // below the stave's y, and each part sits PG below the one above.
        ph.style.top=((TP+34)*scoreZoom)+'px';
        ph.style.height=(((parts.length-1)*PG+52)*scoreZoom)+'px';
      }
    }
    _phRaf=requestAnimationFrame(step);
  };
  cancelAnimationFrame(_phRaf);
  _phRaf=requestAnimationFrame(step);
}
function stopPlayhead(){
  cancelAnimationFrame(_phRaf); _phRaf=0; _phPlan=null;
  const ph=document.getElementById('score-playhead');
  if(ph) ph.style.display='none';
}

// The note's letter, printed inside its head. Drawn through VexFlow's own
// render context rather than patched into the DOM afterwards, so the print and
// PDF paths — which call drawVoice() too — get it without knowing about it.
// Must run after voice.draw(), which is what gives the notes their geometry.
function drawNoteLetters(ctx,vfNotes,noteData,part,mi){
  if(!noteLetters)return;
  vfNotes.forEach((vn,li)=>{
    const n=noteData[li];
    if(!n||n.rest||n.repeatBars||!vn)return;
    let ys,x0,x1;
    try{ ys=vn.getYs(); x0=vn.getNoteHeadBeginX(); x1=vn.getNoteHeadEndX(); }catch(e){ return; }
    if(!ys||!ys.length||!isFinite(x0)||!isFinite(x1))return;
    const disp=part?displayKeys(n,part,mi):{keys:n.keys};
    const cx=(x0+x1)/2, w=Math.abs(x1-x0);
    // VexFlow's setFont takes points, not pixels, so this reads ~1.33x larger
    // than the number suggests. A notehead is about 12 wide and 10 tall, and
    // the letter has to sit inside that with room to spare.
    const size=Math.max(4,Math.min(6.5,w*0.45));
    disp.keys.forEach((k,i)=>{
      const y=ys[i]; if(y==null)return;
      const letter=noteLetterOfKey(k); if(!letter)return;
      // On a coloured head the ink has to contrast with that colour; on a
      // plain black head the letter has to be white to be seen at all.
      const head=noteheadColor(k,mi);
      try{
        ctx.save();
        ctx.setFont('Arial',size,'bold');
        ctx.setFillStyle(head?readableInk(head):'#fff');
        ctx.fillText(letter,cx,y);
        // measureText() on an SVG context is unreliable enough to visibly
        // mis-centre a 7px letter, so centre it the way SVG itself can: anchor
        // the text at the notehead's middle and let the renderer do the
        // centring. The element just created is the context's last child.
        const host=ctx.parent||ctx.svg;
        const t=host&&host.lastElementChild;
        if(t&&t.tagName==='text'){
          t.setAttribute('text-anchor','middle');
          t.setAttribute('dominant-baseline','central');
          t.setAttribute('x',cx); t.setAttribute('y',y);
          t.setAttribute('pointer-events','none');
        }
        ctx.restore();
      }catch(e){}
    });
  });
}
function drawVoice(ctx,stave,noteData,mw,VF,partIdx,partOffset,clef,part,ts,mi){
  const{StaveNote,Voice,Formatter,Accidental,Beam,Annotation,Articulation,Dot,Tremolo,Ornament,GraceNote,GraceNoteGroup,RepeatNote,Tuplet}=VF;
  if(!noteData.length)return[];
  let vfNotes;
  try{
    vfNotes=noteData.map((n,li)=>{
      const globalIdx=(n.srcIdx!=null)?n.srcIdx:partOffset+li;
      // A measure-repeat marker replaces the whole measure with one glyph —
      // give it a 'w' duration so it fills the voice like a full measure would.
      if(n.repeatBars) return new RepeatNote(n.repeatBars,{duration:'w'});
      const isSelected=selectedNote&&selectedNote.partIdx===partIdx&&selectedNote.noteIdx===globalIdx;
      const inCopyRange=copyRangeSel&&copyRangeSel.partIdx===partIdx&&globalIdx>=Math.min(copyRangeSel.startIdx,copyRangeSel.endIdx)&&globalIdx<=Math.max(copyRangeSel.startIdx,copyRangeSel.endIdx);
      // clef must be passed explicitly — VexFlow's StaveNote silently defaults
      // to treble-clef line positions otherwise, mispositioning every note on
      // a non-treble stave even though the stave itself draws the right clef.
      // 't<N>' (our tuplet marker) isn't a VexFlow duration token, so strip it here.
      // Written pitch for a transposing part; the stored spelling otherwise.
      const disp=part?displayKeys(n,part,mi):{keys:n.keys,vfAccs:n.vfAccs};
      const sn=new StaveNote({keys:disp.keys,duration:stripTuplet(n.dur),clef});
      if(isSelected) sn.setStyle({fillStyle:'#2980b9',strokeStyle:'#2980b9'});
      else if(inCopyRange) sn.setStyle({fillStyle:'#27ae60',strokeStyle:'#27ae60'});
      // Pitch colour goes on the noteheads alone, leaving stems and flags
      // black — a coloured stem reads as a highlight, a coloured head reads as
      // the note's identity, which is the whole point. Skipped while the note
      // is selected or in a copy range so those keep saying what they mean;
      // rests have no pitch to colour.
      else if(noteColorMode!=='off'&&!n.rest){
        disp.keys.forEach((k,i)=>{
          const c=noteheadColor(k,mi);
          if(c)try{sn.setKeyStyle(i,{fillStyle:c,strokeStyle:c});}catch(e){}
        });
      }
      const accs=disp.vfAccs||[];
      accs.forEach((acc,i)=>{if(acc)try{sn.addModifier(new Accidental(acc),i);}catch(e){};});
      if(n.dur.includes('d'))try{Dot.buildAndAttach([sn],{all:true});}catch(e){}
      if(n.lyric)try{const a=new Annotation(n.lyric);a.setVerticalJustification(Annotation.VerticalJustify.BOTTOM);a.setFont({family:'Arial',size:9});sn.addModifier(a,0);}catch(e){}
      if(n.sticking)try{const a=new Annotation(n.sticking);a.setVerticalJustification(Annotation.VerticalJustify.BOTTOM);a.setFont({family:'Arial',size:9,weight:'bold'});sn.addModifier(a,0);}catch(e){}
      if(n.dyn)try{const a=new Annotation(n.dyn);a.setVerticalJustification(Annotation.VerticalJustify.BOTTOM);a.setFont({family:'serif',size:10,style:'italic bold'});sn.addModifier(a,0);}catch(e){}
      if(n.tempo)try{const a=new Annotation(n.tempo);a.setVerticalJustification(Annotation.VerticalJustify.TOP);a.setFont({family:'serif',size:10,style:'italic'});sn.addModifier(a,0);}catch(e){}
      (n.arts||[]).forEach(a=>{
        if(a==='tr')try{const ann=new Annotation('tr');ann.setFont({family:'serif',size:10,style:'italic'});sn.addModifier(ann,0);}catch(e){}
        else try{sn.addModifier(new Articulation(a),0);}catch(e){}
      });
      if(n.rud){
        try{
          if(n.rud==='trem1')sn.addModifier(new Tremolo(1),0);
          else if(n.rud==='trem2')sn.addModifier(new Tremolo(2),0);
          else if(n.rud==='trem3')sn.addModifier(new Tremolo(3),0);
          else if(n.rud==='buzz'){const ann=new Annotation('Z');ann.setFont({family:'serif',size:15,style:'bold'});ann.setVerticalJustification(Annotation.VerticalJustify.TOP);sn.addModifier(ann,0);}
          else if(n.rud==='press')sn.addModifier(new Ornament('mordent_inverted'),0);
        }catch(e){}
      }
      if(n.grace&&n.grace.length){
        try{
          const gSemis=part?writtenSemis(part):0;
          const gScale=part?partScale(part,mi):null;
          const gFlat=part?partFifths(part,mi)<0:false;
          const gns=n.grace.map(g=>{
            let gKeys=g.keys, gAcc=g.vfAcc;
            if(gSemis&&g.midi!=null){
              const sp=spellInScale(g.midi+gSemis,gScale,gFlat);
              gKeys=[sp.name+'/'+sp.oct]; gAcc=sp.vfAcc;
            }
            const gn=new GraceNote({keys:gKeys,duration:g.dur,slash:true,clef});
            if(gAcc)try{gn.addModifier(new Accidental(gAcc),0);}catch(e){}
            return gn;
          });
          const grp=new GraceNoteGroup(gns,false);
          if(gns.length>1)grp.beamNotes();
          sn.addModifier(grp,0);
        }catch(e){}
      }
      return sn;
    });
  }catch(e){console.warn('Note create:',e.message);return[];}

  // Tuplets: consecutive runs of exactly N notes sharing the same tuplet size
  // (set via the N-tuplet toggle/stepper) become one bracketed group. Must
  // happen before addTickables() below — Tuplet() rewrites each note's tick
  // duration to the N:notesOccupied ratio, which the Voice/Formatter then
  // relies on for layout.
  const tuplets=[];
  try{
    let ti=0;
    while(ti<noteData.length){
      const num=noteData[ti].repeatBars?0:tupletNumOf(noteData[ti].dur);
      if(num){
        let tj=ti;
        while(tj<noteData.length && !noteData[tj].repeatBars && tupletNumOf(noteData[tj].dur)===num && (tj-ti)<num) tj++;
        // VexFlow 4's Tuplet options are snake_case (num_notes/notes_occupied);
        // camelCase is silently ignored and falls back to a default 2:notes_occupied
        // ratio, so this must match exactly.
        if(tj-ti===num) tuplets.push(new Tuplet(vfNotes.slice(ti,tj),{num_notes:num,notes_occupied:tupletOccupied(num)}));
        ti=tj;
      } else ti++;
    }
  }catch(e){console.warn('Tuplet:',e.message);}

  try{
    const vts=ts||currentTimeSig;
    const voice=new Voice({numBeats:vts.vfB,beatValue:vts.vfV}).setMode(2);
    voice.addTickables(vfNotes);
    // Width actually available to notes: the stave's own width less whatever
    // the clef/key/time signatures and any begin-repeat consumed on the left,
    // less a little breathing room before the barline.
    const leftUsed=Math.max(0,stave.getNoteStartX()-stave.getX());
    new Formatter().joinVoices([voice]).format([voice],Math.max(60,mw-leftUsed-26));
    const beamable=vfNotes.filter((_,i)=>{const b=decomposeDur(noteData[i].dur).base;return !noteData[i].rest&&['8','16','32'].includes(b);});
    const beams=beamable.length>=2?Beam.generateBeams(beamable):[];
    voice.draw(ctx,stave);
    drawNoteLetters(ctx,vfNotes,noteData,part,mi);
    beams.forEach(b=>b.setContext(ctx).draw());
    tuplets.forEach(t=>{ try{ t.setContext(ctx).draw(); }catch(e){} });
    // Ties between the pieces of a split note. Drawn here, per measure, for
    // pieces that sit in the same bar; the ones that straddle a barline are
    // stitched together in drawScore(), which can see both bars.
    for(let li=0;li+1<noteData.length;li++){
      // Adjacent pieces whose flags meet are tied. The srcIdx no longer has to
      // match: a split note ties to itself, a stored tie joins two notes.
      if(noteData[li].tieTo && noteData[li+1].tieFrom){
        try{ new VF.StaveTie({first_note:vfNotes[li],last_note:vfNotes[li+1],first_indices:[0],last_indices:[0]}).setContext(ctx).draw(); }catch(e){}
      }
    }
    // The last piece of a bar that ties onward, and the first that ties back,
    // are reported so drawScore() can join them across the barline.
    noteData.forEach((it,li)=>{
      if(!vfNotes[li])return;
      // A tie leaving the bar lands either on the rest of the same note (a
      // split) or on the next note (a stored tie), so it has to say which.
      if(it.tieTo&&li===noteData.length-1)
        pendingTieOut.push({partIdx,srcIdx:it.srcIdx,matchIdx:it.tieToNext?it.srcIdx+1:it.srcIdx,vfNote:vfNotes[li],stave});
      if(it.tieFrom&&li===0) pendingTieIn.push({partIdx,srcIdx:it.srcIdx,vfNote:vfNotes[li],stave});
    });
    vfNotes.forEach((vn,li)=>{
      try{
        const nx=vn.getAbsoluteX();
        const bb=vn.getBoundingBox?.();
        notePositions.push({partIdx,noteIdx:(noteData[li]&&noteData[li].srcIdx!=null)?noteData[li].srcIdx:partOffset+li,x:nx,y:bb?bb.y:0,h:bb?bb.h:80});
      }catch(ex){}
    });
  }catch(e){console.warn('Voice draw:',e.message);}
  return vfNotes;
}
