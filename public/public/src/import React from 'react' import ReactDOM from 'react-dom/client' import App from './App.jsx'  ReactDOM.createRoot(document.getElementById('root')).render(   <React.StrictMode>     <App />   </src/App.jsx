import { useState, useEffect, useRef, useCallback } from "react";

// ── String config ─────────────────────────────────────────────────────────────
const STRING_NAMES = ["E", "A", "D", "G", "B", "e"];
const STRING_COLORS = ["#ff4444", "#ff8c00", "#ffd700", "#44ff88", "#44aaff", "#cc44ff"];
const OPEN_MIDI = [40, 45, 50, 55, 59, 64];
const OPEN_FREQS = [82.41, 110.0, 146.83, 196.0, 246.94, 329.63];
const NUM_FRETS = 12;
const MARKER_FRETS = [3, 5, 7, 9, 12];
const FRETBOARD_H = 130;
const LOOKAHEAD = 3.5;

const CHORDS = {
  "Em":[0,2,2,0,0,0],"Am":[-1,0,2,2,1,0],
  "C":[-1,3,2,0,1,0],"G":[3,2,0,0,0,3],
  "D":[-1,-1,0,2,3,2],"A":[-1,0,2,2,2,0],
  "E":[0,2,2,1,0,0],"F":[1,3,3,2,1,1],
};

function midiNoteToTab(midiNote) {
  let best = null;
  for (let s = 5; s >= 0; s--) {
    const fret = midiNote - OPEN_MIDI[s];
    if (fret >= 0 && fret <= NUM_FRETS) {
      if (!best || fret < best.fret) best = { string: s, fret };
    }
  }
  return best;
}

function parseMidi(buf) {
  const b = new Uint8Array(buf); let p = 0;
  const byte = () => b[p++];
  const u16 = () => (byte()<<8)|byte();
  const u32 = () => ((byte()<<24)|(byte()<<16)|(byte()<<8)|byte())>>>0;
  const vlen = () => { let v=0,c; do{c=byte();v=(v<<7)|(c&127);}while(c&128);return v; };
  u32();u32();
  const format=u16(),nTracks=u16(),division=u16();
  const tracks=[];
  for(let t=0;t<nTracks;t++){
    u32();const end=p+u32();
    const evs=[];let tick=0,ls=0;
    while(p<end){
      tick+=vlen();let s=b[p];
      if(s&128){ls=s;p++;}else s=ls;
      const tp=s&0xf0;
      if(tp===0x80||tp===0x90){const note=byte(),vel=byte();evs.push({tick,type:(tp===0x90&&vel)?"on":"off",ch:s&0x0f,note,vel});}
      else if(tp===0xa0||tp===0xb0||tp===0xe0){byte();byte();}
      else if(tp===0xc0||tp===0xd0){byte();}
      else if(s===0xff){const mt=byte(),ml=vlen();if(mt===0x51&&ml===3)evs.push({tick,type:"tempo",tempo:(byte()<<16)|(byte()<<8)|byte()});else p+=ml;}
      else if(s===0xf0||s===0xf7){p+=vlen();}else p++;
    }
    p=end;tracks.push(evs);
  }
  return{division,tracks};
}

function buildTabs(midi) {
  const{division,tracks}=midi;
  const all=[];
  tracks.forEach((tr)=>tr.forEach(ev=>all.push({...ev})));
  all.sort((a,b)=>a.tick!==b.tick?a.tick-b.tick:(a.type==="tempo"?-1:1));
  let tempo=500000,lt=0,ltime=0;
  const timed=all.map(ev=>{ltime+=(ev.tick-lt)/division*tempo/1e6;lt=ev.tick;if(ev.type==="tempo")tempo=ev.tempo;return{...ev,time:ltime};});
  const active={},tabs=[];
  timed.forEach(ev=>{
    const k=`${ev.note}_${ev.ch}`;
    if(ev.type==="on")active[k]={note:ev.note,start:ev.time,vel:ev.vel};
    else if(ev.type==="off"&&active[k]){
      const tab=midiNoteToTab(active[k].note);
      if(tab)tabs.push({...tab,start:active[k].start,dur:Math.max(ev.time-active[k].start,0.1)});
      delete active[k];
    }
  });
  return tabs;
}

const DEFAULT_TABS = [
  {string:0,fret:0,start:0.5,dur:0.4},{string:0,fret:3,start:1.0,dur:0.3},
  {string:0,fret:5,start:1.5,dur:0.3},{string:1,fret:0,start:2.0,dur:0.4},
  {string:1,fret:2,start:2.5,dur:0.3},{string:2,fret:0,start:3.0,dur:0.4},
  {string:2,fret:2,start:3.5,dur:0.3},{string:2,fret:4,start:4.0,dur:0.3},
  {string:3,fret:0,start:4.5,dur:0.4},{string:4,fret:0,start:5.0,dur:0.4},
  {string:5,fret:0,start:5.5,dur:0.6},{string:5,fret:3,start:6.5,dur:0.3},
  {string:5,fret:5,start:7.0,dur:0.5},
];

// ── Better Guitar Audio ───────────────────────────────────────────────────────
function playGuitarNote(audioCtx, freq, duration = 0.5, muted = false) {
  if (!audioCtx || muted) return;
  const now = audioCtx.currentTime;

  // Karplus-Strong inspired: noise burst → lowpass → decay
  const bufSize = Math.floor(audioCtx.sampleRate / freq);
  const buffer = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;

  // Body resonance
  const body = audioCtx.createBiquadFilter();
  body.type = "peaking";
  body.frequency.value = 250;
  body.gain.value = 4;
  body.Q.value = 0.8;

  // Presence
  const presence = audioCtx.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 2000;
  presence.gain.value = 3;
  presence.Q.value = 1;

  // Cut harshness
  const hi = audioCtx.createBiquadFilter();
  hi.type = "lowpass";
  hi.frequency.value = 4000;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.5, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.3, now + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.001, now + Math.min(duration + 0.3, 1.8));

  src.connect(body);
  body.connect(presence);
  presence.connect(hi);
  hi.connect(gain);
  gain.connect(audioCtx.destination);

  src.start(now);
  src.stop(now + Math.min(duration + 0.4, 2.0));
}

function strumChord(audioCtx, chordFrets, direction = "down", muted = false) {
  if (!audioCtx || muted) return;
  const strings = direction === "down" ? [0,1,2,3,4,5] : [5,4,3,2,1,0];
  strings.forEach((si, i) => {
    const fret = chordFrets[si];
    if (fret < 0) return;
    setTimeout(() => playGuitarNote(audioCtx, OPEN_FREQS[si] * Math.pow(2, fret/12), 0.8, false), i * 35);
  });
}

// ── Pitch Detection (YIN-lite) ────────────────────────────────────────────────
function detectPitch(buffer, sampleRate) {
  const SIZE = buffer.length;
  const HALF = Math.floor(SIZE / 2);
  const yinBuffer = new Float32Array(HALF);

  // Difference function
  for (let tau = 1; tau < HALF; tau++) {
    let sum = 0;
    for (let i = 0; i < HALF; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    yinBuffer[tau] = sum;
  }

  // Cumulative mean normalisation
  yinBuffer[0] = 1;
  let runSum = 0;
  for (let tau = 1; tau < HALF; tau++) {
    runSum += yinBuffer[tau];
    yinBuffer[tau] *= tau / runSum;
  }

  // Find first dip below threshold
  const THRESHOLD = 0.12;
  for (let tau = 2; tau < HALF; tau++) {
    if (yinBuffer[tau] < THRESHOLD) {
      while (tau + 1 < HALF && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
      return sampleRate / tau;
    }
  }
  return -1;
}

function freqToMidi(freq) {
  if (freq <= 0) return -1;
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function GuitarTabSynthesia() {
  const canvasRef = useRef(null);
  const sr = useRef({playing:false,offset:0,startWall:0,raf:null,loopA:null,loopB:null,pausedAtB:false,lastPlayedIdx:new Set()});
  const progressRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const micStreamRef = useRef(null);
  const pitchRafRef = useRef(null);
  const dragging = useRef(null);

  const [tabs, setTabs] = useState(DEFAULT_TABS);
  const [totalDur, setTotalDur] = useState(Math.max(...DEFAULT_TABS.map(t=>t.start+t.dur))+1.5);
  const [fileName, setFileName] = useState("Demo Riff");
  const [ui, setUi] = useState({playing:false});
  const [progress, setProgress] = useState(0);
  const [loopA, setLoopA] = useState(null);
  const [loopB, setLoopB] = useState(null);
  const [loopActive, setLoopActive] = useState(false);
  const [pausedAtB, setPausedAtB] = useState(false);
  const [selectedChord, setSelectedChord] = useState("Em");
  const [strumDir, setStrumDir] = useState("down");
  const [mode, setMode] = useState("tabs");
  const [muted, setMuted] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [detectedNote, setDetectedNote] = useState(null); // {midi, correct}
  const [micError, setMicError] = useState(null);

  const tabsRef = useRef(DEFAULT_TABS);
  const totalDurRef = useRef(Math.max(...DEFAULT_TABS.map(t=>t.start+t.dur))+1.5);
  const mutedRef = useRef(false);

  const initAudio = () => {
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume();
    return audioCtxRef.current;
  };

  const getT = () => {
    const st = sr.current;
    return st.playing ? st.offset + (performance.now() - st.startWall) / 1000 : st.offset;
  };

  // ── Mic / Pitch ─────────────────────────────────────────────────────────────
  const startMic = async () => {
    try {
      setMicError(null);
      const ac = initAudio();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      micStreamRef.current = stream;

      const source = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 4096;
      source.connect(analyser);
      analyserRef.current = analyser;

      setMicOn(true);

      const buf = new Float32Array(analyser.fftSize);
      const detectLoop = () => {
        analyser.getFloatTimeDomainData(buf);

        // RMS check — only detect if signal strong enough
        let rms = 0;
        for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / buf.length);

        if (rms > 0.01) {
          const freq = detectPitch(buf, ac.sampleRate);
          if (freq > 60 && freq < 1400) {
            const midi = freqToMidi(freq);
            // Check against active tabs
            const t = getT();
            const activeTabs = tabsRef.current.filter(tab => tab.start <= t && (tab.start + tab.dur) >= t);
            let correct = false;
            if (activeTabs.length > 0) {
              correct = activeTabs.some(tab => {
                const expectedMidi = OPEN_MIDI[tab.string] + tab.fret;
                return Math.abs(midi - expectedMidi) <= 1;
              });
            }
            setDetectedNote({ midi, freq: Math.round(freq), correct, active: activeTabs.length > 0 });
          } else {
            setDetectedNote(null);
          }
        } else {
          setDetectedNote(null);
        }
        pitchRafRef.current = requestAnimationFrame(detectLoop);
      };
      detectLoop();
    } catch (err) {
      setMicError("Mic access denied");
      console.error(err);
    }
  };

  const stopMic = () => {
    if (pitchRafRef.current) cancelAnimationFrame(pitchRafRef.current);
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop());
    analyserRef.current = null;
    micStreamRef.current = null;
    setMicOn(false);
    setDetectedNote(null);
  };

  const toggleMic = () => { micOn ? stopMic() : startMic(); };

  const handleMidiFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const midi = parseMidi(ev.target.result);
        const newTabs = buildTabs(midi);
        if (!newTabs.length) { alert("No notes found."); return; }
        const dur = Math.max(...newTabs.map(t => t.start + t.dur)) + 1.5;
        tabsRef.current = newTabs; totalDurRef.current = dur;
        setTabs(newTabs); setTotalDur(dur); setFileName(file.name);
        const st = sr.current;
        cancelAnimationFrame(st.raf);
        st.offset = 0; st.playing = false; st.lastPlayedIdx.clear();
        setUi({playing:false}); setProgress(0);
        setLoopA(null); setLoopB(null); setLoopActive(false);
        st.loopA = null; st.loopB = null;
      } catch(err) { console.error(err); alert("Couldn't parse MIDI."); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const noteAreaH = H - FRETBOARD_H;
    const t = getT();
    const currentTabs = tabsRef.current;
    const dur = totalDurRef.current;

    if (dur > 0) setProgress(Math.min(t / dur, 1));

    ctx.fillStyle = "#0a0a0f"; ctx.fillRect(0, 0, W, H);

    const laneW = W / STRING_NAMES.length;
    STRING_NAMES.forEach((_, i) => {
      const laneX = laneW * i, laneCX = laneX + laneW / 2;
      ctx.fillStyle = STRING_COLORS[i] + "12"; ctx.fillRect(laneX, 0, laneW, noteAreaH);
      if (i > 0) { ctx.fillStyle = "#ffffff08"; ctx.fillRect(laneX, 0, 1, noteAreaH); }
      ctx.fillStyle = STRING_COLORS[i] + "99";
      ctx.font = "bold 12px 'Courier New'"; ctx.textAlign = "center";
      ctx.fillText(STRING_NAMES[i], laneCX, 18); ctx.textAlign = "left";
    });

    const lineGrad = ctx.createLinearGradient(0, noteAreaH - 2, W, noteAreaH - 2);
    lineGrad.addColorStop(0, "#ffffff20"); lineGrad.addColorStop(0.5, "#ffffff80"); lineGrad.addColorStop(1, "#ffffff20");
    ctx.fillStyle = lineGrad; ctx.fillRect(0, noteAreaH - 2, W, 3);

    const activeStrings = {};
    const activeTabIndices = new Set();

    currentTabs.forEach((tab, idx) => {
      if (tab.start <= t && (tab.start + tab.dur) >= t) activeTabIndices.add(idx);
    });

    currentTabs.forEach((tab, idx) => {
      const fs = tab.start - t, fe = tab.start + tab.dur - t;
      if (fe < 0 || fs > LOOKAHEAD) return;
      const laneX = laneW * tab.string, laneCX = laneX + laneW / 2;
      const noteW = Math.min(laneW - 8, 48);
      const noteX = laneCX - noteW / 2;
      const noteH = Math.max((tab.dur / LOOKAHEAD) * noteAreaH, 10);
      const noteY = noteAreaH - (fs / LOOKAHEAD) * noteAreaH - noteH;
      if (noteY > noteAreaH || noteY + noteH < 0) return;

      const isActive = activeTabIndices.has(idx);
      const color = STRING_COLORS[tab.string];

      if (isActive) {
        activeStrings[tab.string] = { fret: tab.fret, color };
        if (!sr.current.lastPlayedIdx.has(idx)) {
          sr.current.lastPlayedIdx.add(idx);
          playGuitarNote(audioCtxRef.current, OPEN_FREQS[tab.string] * Math.pow(2, tab.fret / 12), tab.dur, mutedRef.current);
        }
      }

      if (isActive) { ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 22; }
      const grad = ctx.createLinearGradient(noteX, noteY, noteX, noteY + noteH);
      grad.addColorStop(0, color + "ff"); grad.addColorStop(1, color + "77");
      ctx.fillStyle = grad; ctx.beginPath(); ctx.roundRect(noteX, noteY, noteW, noteH, 7); ctx.fill();
      ctx.fillStyle = "#ffffff35"; ctx.beginPath(); ctx.roundRect(noteX + 3, noteY + 3, noteW - 6, 4, 3); ctx.fill();
      if (isActive) ctx.restore();

      ctx.fillStyle = "#fff";
      ctx.font = `bold ${noteH > 22 ? 18 : 12}px 'Courier New'`;
      ctx.textAlign = "center";
      ctx.fillText(tab.fret === 0 ? "O" : String(tab.fret), laneCX, noteY + noteH / 2 + 6);
      ctx.textAlign = "left";
    });

    currentTabs.forEach((tab, idx) => { if (t > tab.start + tab.dur + 0.1) sr.current.lastPlayedIdx.delete(idx); });

    // ── Fretboard ─────────────────────────────────────────────────────────────
    const fb = noteAreaH;
    const woodGrad = ctx.createLinearGradient(0, fb, 0, H);
    woodGrad.addColorStop(0, "#3d2008"); woodGrad.addColorStop(0.5, "#5c3010"); woodGrad.addColorStop(1, "#2a1505");
    ctx.fillStyle = woodGrad; ctx.fillRect(0, fb, W, FRETBOARD_H);

    const nutX = 55, fretW = (W - nutX) / NUM_FRETS;
    const fretPos = [];
    for (let i = 0; i <= NUM_FRETS; i++) fretPos.push(nutX + fretW * i);

    MARKER_FRETS.forEach(fret => {
      if (fret <= NUM_FRETS) {
        const mx = (fretPos[fret-1] + fretPos[fret]) / 2;
        ctx.fillStyle = "#9b7a1a"; ctx.beginPath(); ctx.arc(mx, fb + FRETBOARD_H / 2, fret === 12 ? 7 : 5, 0, Math.PI * 2); ctx.fill();
      }
    });

    fretPos.forEach((x, i) => {
      ctx.strokeStyle = i === 0 ? "#e0e0e0" : "#777"; ctx.lineWidth = i === 0 ? 5 : 1.5;
      ctx.beginPath(); ctx.moveTo(x, fb + 6); ctx.lineTo(x, H - 6); ctx.stroke();
      if (i > 0) { ctx.fillStyle = "#666"; ctx.font = "9px 'Courier New'"; ctx.textAlign = "center"; ctx.fillText(String(i), x - fretW / 2, H - 3); ctx.textAlign = "left"; }
    });

    const strSpacing = FRETBOARD_H / (STRING_NAMES.length + 1);
    STRING_NAMES.forEach((name, i) => {
      const sy = fb + strSpacing * (i + 1);
      const isActive = activeStrings[i] !== undefined;
      const color = isActive ? activeStrings[i].color : "#999";
      const thickness = i < 3 ? 3 : 1.5;
      if (isActive) { ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.strokeStyle = color; ctx.lineWidth = isActive ? thickness + 1 : thickness;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
      if (isActive) ctx.restore();
      ctx.fillStyle = isActive ? color : "#888"; ctx.font = "bold 11px 'Courier New'"; ctx.fillText(name, 8, sy + 4);
      if (isActive) {
        const fret = activeStrings[i].fret;
        const dotX = fret === 0 ? 30 : (fretPos[fret - 1] + fretPos[fret]) / 2;
        ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 18;
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(dotX, sy, 9, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.font = "bold 9px 'Courier New'"; ctx.textAlign = "center";
        ctx.fillText(fret === 0 ? "O" : String(fret), dotX, sy + 3); ctx.textAlign = "left";
        ctx.restore();
      }
    });
  }, []);

  const loop = useCallback(() => {
    draw();
    const st = sr.current;
    const t = st.playing ? st.offset + (performance.now() - st.startWall) / 1000 : st.offset;
    const dur = totalDurRef.current;
    if (st.playing && st.loopB !== null && t >= st.loopB) {
      st.offset = st.loopB; st.playing = false; st.pausedAtB = true; st.lastPlayedIdx.clear();
      cancelAnimationFrame(st.raf); setUi({playing:false}); setPausedAtB(true); draw(); return;
    }
    if (st.playing && t > dur + 0.5) {
      st.offset = 0; st.playing = false; st.lastPlayedIdx.clear();
      cancelAnimationFrame(st.raf); setUi({playing:false}); setProgress(0); draw(); return;
    }
    st.raf = requestAnimationFrame(loop);
  }, [draw]);

  const togglePlay = () => {
    initAudio();
    const st = sr.current;
    if (st.playing) {
      st.offset += (performance.now() - st.startWall) / 1000; st.playing = false; cancelAnimationFrame(st.raf); setUi({playing:false});
    } else {
      if (st.loopA !== null && st.loopB !== null && st.offset >= st.loopB) { st.offset = st.loopA; st.lastPlayedIdx.clear(); }
      st.startWall = performance.now(); st.playing = true; st.pausedAtB = false;
      setPausedAtB(false); setUi({playing:true}); loop();
    }
  };

  const replayLoop = () => {
    initAudio(); const st = sr.current;
    cancelAnimationFrame(st.raf);
    st.offset = st.loopA !== null ? st.loopA : 0; st.lastPlayedIdx.clear();
    st.playing = true; st.startWall = performance.now(); st.pausedAtB = false;
    setPausedAtB(false); setUi({playing:true}); loop();
  };

  const restart = () => {
    const st = sr.current; cancelAnimationFrame(st.raf);
    st.offset = 0; st.playing = false; st.pausedAtB = false; st.lastPlayedIdx.clear();
    setUi({playing:false}); setProgress(0); setPausedAtB(false); draw();
  };

  const setA = () => {
    const t = getT(); const st = sr.current;
    const newB = st.loopB !== null && st.loopB > t ? st.loopB : null;
    st.loopA = t; st.loopB = newB; setLoopA(t); setLoopB(newB); setLoopActive(newB !== null);
  };

  const setB = () => {
    const t = getT(); const st = sr.current;
    if (st.loopA === null || t <= st.loopA) return;
    st.loopB = t; setLoopB(t); setLoopActive(true);
  };

  const clearLoop = () => {
    const st = sr.current; st.loopA = null; st.loopB = null; st.pausedAtB = false;
    setLoopA(null); setLoopB(null); setLoopActive(false); setPausedAtB(false);
  };

  const toggleMute = () => {
    const newMuted = !muted;
    setMuted(newMuted);
    mutedRef.current = newMuted;
  };

  const handleBarClick = (e) => {
    if (dragging.current) return;
    const bar = progressRef.current; const rect = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
    const st = sr.current; const dur = totalDurRef.current;
    st.offset = frac * dur; st.lastPlayedIdx.clear();
    if (st.playing) st.startWall = performance.now();
    st.pausedAtB = false; setPausedAtB(false); setProgress(frac);
  };

  const handleBarMouseDown = (e, marker) => { e.stopPropagation(); dragging.current = marker; };
  const handleMouseMove = useCallback((e) => {
    if (!dragging.current) return;
    const bar = progressRef.current; if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
    const t = frac * totalDurRef.current;
    if (dragging.current === 'a') { sr.current.loopA = t; setLoopA(t); }
    if (dragging.current === 'b') { sr.current.loopB = t; setLoopB(t); }
  }, []);
  const handleMouseUp = useCallback(() => { dragging.current = null; }, []);

  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => { window.removeEventListener("mousemove", handleMouseMove); window.removeEventListener("mouseup", handleMouseUp); };
  }, [handleMouseMove, handleMouseUp]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const resize = () => { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; draw(); };
    resize(); window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); cancelAnimationFrame(sr.current.raf); stopMic(); };
  }, [draw]);

  const aFrac = loopA !== null ? loopA / totalDur : null;
  const bFrac = loopB !== null ? loopB / totalDur : null;
  const btnBase = { borderRadius: 3, cursor: "pointer", fontFamily: "inherit", fontWeight: 700, letterSpacing: 1, border: "1px solid", fontSize: 10, padding: "7px 10px" };

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:"#0a0a0f",color:"#fff",fontFamily:"'Courier New',monospace",overflow:"hidden"}}>

      {/* Header */}
      <div style={{padding:"5px 8px",display:"flex",alignItems:"center",gap:6,background:"#0f0f1a",borderBottom:"1px solid #1a1a30",flexShrink:0,flexWrap:"wrap"}}>
        <span style={{fontSize:11,fontWeight:700,letterSpacing:2,color:"#ff8c00"}}>🎸 GUITAR TAB SYNTHESIA</span>
        <span style={{fontSize:8,opacity:0.3}}>· {fileName} · {tabs.length} notes</span>
        <div style={{marginLeft:"auto",display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
          <a href="https://www.freemidi.org" target="_blank" rel="noopener noreferrer"
            style={{color:"#cc44ff",border:"1px solid #cc44ff",padding:"3px 7px",borderRadius:3,fontSize:9,fontWeight:700,letterSpacing:1,textDecoration:"none"}}>
            freemidi ↗
          </a>
          <a href="https://bitmidi.com" target="_blank" rel="noopener noreferrer"
            style={{color:"#44ff88",border:"1px solid #44ff88",padding:"3px 7px",borderRadius:3,fontSize:9,fontWeight:700,letterSpacing:1,textDecoration:"none"}}>
            bitmidi ↗
          </a>
          <label style={{color:"#44aaff",border:"1px solid #44aaff",padding:"3px 8px",borderRadius:3,cursor:"pointer",fontSize:9,fontWeight:700,letterSpacing:1}}>
            ▲ MIDI
            <input type="file" accept=".mid,.midi" onChange={handleMidiFile} style={{display:"none"}}/>
          </label>
        </div>
      </div>

      {/* Mode tabs */}
      <div style={{display:"flex",background:"#0d0d1a",borderBottom:"1px solid #1a1a30",flexShrink:0}}>
        {["tabs","strum"].map(m=>(
          <button key={m} onClick={()=>setMode(m)}
            style={{flex:1,padding:"5px",background:mode===m?"#ff8c0015":"transparent",color:mode===m?"#ff8c00":"#ffffff44",border:"none",borderBottom:mode===m?"2px solid #ff8c00":"2px solid transparent",cursor:"pointer",fontFamily:"inherit",fontWeight:700,fontSize:9,letterSpacing:2}}>
            {m==="tabs"?"📖 TAB MODE":"🎸 STRUM MODE"}
          </button>
        ))}
      </div>

      {/* Mic feedback bar */}
      {micOn && (
        <div style={{padding:"4px 10px",background:detectedNote ? (detectedNote.active ? (detectedNote.correct ? "#44ff8822" : "#ff444422") : "#ffffff11") : "#ffffff08",borderBottom:"1px solid #1a1a30",flexShrink:0,display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:detectedNote ? (detectedNote.active ? (detectedNote.correct ? "#44ff88" : "#ff4444") : "#ffff44") : "#ffffff33",boxShadow:detectedNote?`0 0 8px ${detectedNote.active?(detectedNote.correct?"#44ff88":"#ff4444"):"#ffff44"}`:"none"}}/>
          <span style={{fontSize:9,color:detectedNote?(detectedNote.active?(detectedNote.correct?"#44ff88":"#ff4444"):"#ffff44"):"#ffffff44",letterSpacing:1}}>
            {detectedNote
              ? detectedNote.active
                ? detectedNote.correct ? "✓ CORRECT NOTE" : "✗ WRONG NOTE"
                : `🎵 ${detectedNote.freq}Hz detected`
              : "Listening..."}
          </span>
          {micError && <span style={{fontSize:9,color:"#ff4444",marginLeft:"auto"}}>{micError}</span>}
        </div>
      )}

      {/* Canvas */}
      <div style={{flex:1,position:"relative",overflow:"hidden"}}>
        <canvas ref={canvasRef} style={{width:"100%",height:"100%",display:"block"}}/>

        {mode==="strum"&&(
          <div style={{position:"absolute",inset:0,background:"#0a0a0fee",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12}}>
            <div style={{fontSize:12,letterSpacing:3,color:"#ff8c00",fontWeight:700}}>STRUM MODE</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,justifyContent:"center",maxWidth:300}}>
              {Object.keys(CHORDS).map(ch=>(
                <button key={ch} onClick={()=>setSelectedChord(ch)}
                  style={{...btnBase,background:selectedChord===ch?"#ff8c0033":"#ffffff08",color:selectedChord===ch?"#ff8c00":"#fff",borderColor:selectedChord===ch?"#ff8c00":"#ffffff22",fontSize:14,padding:"8px 12px"}}>
                  {ch}
                </button>
              ))}
            </div>
            <div style={{display:"flex",gap:8}}>
              {["down","up"].map(d=>(
                <button key={d} onClick={()=>setStrumDir(d)}
                  style={{...btnBase,background:strumDir===d?"#44aaff22":"#ffffff08",color:strumDir===d?"#44aaff":"#fff",borderColor:strumDir===d?"#44aaff":"#ffffff22",padding:"6px 12px"}}>
                  {d==="down"?"▼ DOWN":"▲ UP"}
                </button>
              ))}
            </div>
            <div style={{display:"flex",gap:6,alignItems:"flex-end"}}>
              {CHORDS[selectedChord].map((fret,i)=>(
                <div key={i} style={{textAlign:"center"}}>
                  <div style={{fontSize:16,fontWeight:700,color:fret<0?"#ffffff22":STRING_COLORS[i]}}>{fret<0?"✕":fret===0?"O":fret}</div>
                  <div style={{fontSize:7,color:STRING_COLORS[i]+"88"}}>{STRING_NAMES[i]}</div>
                </div>
              ))}
            </div>
            <button onClick={()=>strumChord(initAudio(),CHORDS[selectedChord],strumDir,muted)}
              style={{background:"#ff8c00",color:"#000",border:"none",borderRadius:6,padding:"12px 40px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit",letterSpacing:2,boxShadow:"0 0 20px #ff8c0066"}}>
              🎸 STRUM {selectedChord}
            </button>
          </div>
        )}
      </div>

      {/* Progress bar */}
      {mode==="tabs"&&(
        <div ref={progressRef} onClick={handleBarClick}
          style={{height:20,background:"#0d0d1e",flexShrink:0,position:"relative",cursor:"pointer",borderTop:"1px solid #1a1a30",userSelect:"none"}}>
          {aFrac!==null&&bFrac!==null&&<div style={{position:"absolute",left:`${aFrac*100}%`,width:`${(bFrac-aFrac)*100}%`,top:0,bottom:0,background:"#ff8c0018",pointerEvents:"none"}}/>}
          <div style={{position:"absolute",left:0,top:"50%",transform:"translateY(-50%)",height:3,width:`${progress*100}%`,background:"linear-gradient(90deg,#ff4444,#ff8c00,#ffd700)",pointerEvents:"none",borderRadius:2}}/>
          {aFrac!==null&&<div onMouseDown={e=>handleBarMouseDown(e,'a')} style={{position:"absolute",left:`${aFrac*100}%`,top:0,bottom:0,width:3,background:"#44ff88",cursor:"ew-resize",zIndex:2}}><div style={{position:"absolute",top:1,left:3,fontSize:7,color:"#44ff88",fontWeight:700}}>A</div></div>}
          {bFrac!==null&&<div onMouseDown={e=>handleBarMouseDown(e,'b')} style={{position:"absolute",left:`${bFrac*100}%`,top:0,bottom:0,width:3,background:"#ff8c00",cursor:"ew-resize",zIndex:2}}><div style={{position:"absolute",top:1,left:3,fontSize:7,color:"#ff8c00",fontWeight:700}}>B</div></div>}
        </div>
      )}

      {/* Controls */}
      <div style={{padding:"6px 8px",display:"flex",gap:5,alignItems:"center",background:"#0f0f1a",borderTop:"1px solid #1a1a30",flexShrink:0,flexWrap:"wrap"}}>
        {mode==="tabs"?(
          <>
            <button onClick={togglePlay} style={{...btnBase,background:ui.playing?"#ff444422":"#ff8c0022",color:ui.playing?"#ff4444":"#ff8c00",borderColor:ui.playing?"#ff4444":"#ff8c00",fontSize:11,padding:"6px 12px"}}>
              {ui.playing?"⏸":"▶"}
            </button>
            <button onClick={restart} style={{...btnBase,background:"transparent",color:"#ffffff44",borderColor:"#ffffff18",fontSize:13,padding:"5px 9px"}}>↺</button>

            {/* Mute toggle */}
            <button onClick={toggleMute}
              style={{...btnBase,background:muted?"#ff444422":"#ffffff08",color:muted?"#ff4444":"#ffffff66",borderColor:muted?"#ff4444":"#ffffff22",fontSize:13,padding:"5px 9px"}}>
              {muted?"🔇":"🔊"}
            </button>

            {/* Mic toggle */}
            <button onClick={toggleMic}
              style={{...btnBase,background:micOn?"#44ff8822":"#ffffff08",color:micOn?"#44ff88":"#ffffff66",borderColor:micOn?"#44ff88":"#ffffff22",fontSize:13,padding:"5px 9px",boxShadow:micOn?"0 0 10px #44ff8844":"none"}}>
              {micOn?"🎙️":"🎙"}
            </button>

            <div style={{width:1,height:20,background:"#1a1a30",margin:"0 2px"}}/>
            <button onClick={setA} style={{...btnBase,background:"#44ff8818",color:"#44ff88",borderColor:"#44ff8844",fontSize:9}}>SET A</button>
            <button onClick={setB} style={{...btnBase,background:"#ff8c0018",color:"#ff8c00",borderColor:"#ff8c0044",opacity:loopA!==null?1:0.35,fontSize:9}}>SET B</button>
            {loopActive&&<button onClick={clearLoop} style={{...btnBase,background:"transparent",color:"#ffffff33",borderColor:"#ffffff15",fontSize:8}}>CLR</button>}
            {loopActive&&<button onClick={replayLoop} style={{...btnBase,background:pausedAtB?"#ffd70025":"#ffd70010",color:"#ffd700",borderColor:pausedAtB?"#ffd700":"#ffd70033",fontSize:10,boxShadow:pausedAtB?"0 0 10px #ffd70055":"none",transition:"all 0.2s"}}>↩ REPLAY</button>}
            {loopActive&&loopA!==null&&loopB!==null&&<span style={{marginLeft:"auto",fontSize:8,opacity:0.4}}>{loopA.toFixed(1)}→{loopB.toFixed(1)}s</span>}
          </>
        ):(
          <span style={{fontSize:9,opacity:0.35,letterSpacing:1}}>SELECT CHORD · DIRECTION · STRUM</span>
        )}
      </div>
    </div>
  );
}
