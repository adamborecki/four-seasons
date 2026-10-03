import { Engine, DEFAULTS } from './audio.js';
import { Visuals } from './visuals.js';
import { POEMS } from './poems.js';

const $ = (s) => document.querySelector(s);
const NAMES = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter' };
const EDGE_SEASON = { top: 'spring', right: 'summer', bottom: 'autumn', left: 'winter' };
const HERO_WORD = { spring: 'sun', summer: 'sun', autumn: 'moon', winter: 'moon' };

const store = {
  get(k, d) { try { const v = localStorage.getItem('fs.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('fs.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};

const engine = new Engine();
const hero = $('#hero-hit'), recTime = $('#rec-time');
const visuals = new Visuals($('#stage'), engine, {
  onHero: (h) => {
    const d = h.r * 2.6;
    hero.style.width = hero.style.height = d + 'px';
    hero.style.transform = `translate3d(${h.x - d / 2}px, ${h.y - d / 2}px, 0)`;
    recTime.style.transform = `translate3d(${h.x - 20}px, ${h.y + h.r * 1.6}px, 0)`;
    document.documentElement.style.setProperty('--hero-hint-top', `${h.y + h.r * 1.5}px`);
  },
});

window.__fs = { engine, visuals }; // console debugging handle

let season = null;
let idx = store.get('idx', {});
let textOn = store.get('textOn', true);
let fs = store.get('fs', 1);

// ---------------------------------------------------------------- poems
function own(s) { return store.get('own.' + s, null); }
function list(s) {
  const base = POEMS[s].filter((p) => !p.slot);
  const slot = POEMS[s].find((p) => p.slot);
  const mine = own(s);
  if (!slot) return base;
  const entry = mine && mine.text ? { ...mine, own: true, hint: slot.hint } : { ...slot };
  const out = base.slice();
  if (mine && mine.text && slot.pos != null) out.splice(slot.pos, 0, entry);
  else out.push(entry);
  return out;
}

function renderPoem(dir = 0) {
  const L = list(season);
  const i = Math.min(idx[season] || 0, L.length - 1);
  idx[season] = i;
  store.set('idx', idx);
  const p = L[i];
  const poem = $('#poem');
  poem.classList.add('out');
  setTimeout(() => {
    $('#poem-num').textContent = `${NAMES[season]} · ${i + 1} / ${L.length}`;
    const body = $('#poem-body');
    body.innerHTML = '';
    body.scrollTop = 0;
    if (p.slot) {
      $('#poem-title').textContent = 'Your poem';
      $('#poem-author').textContent = '';
      $('#poem-note').textContent = '';
      const d = document.createElement('div');
      d.className = 'slot-invite';
      d.innerHTML = `<p></p><button type="button">Paste a poem</button>`;
      d.querySelector('p').textContent = p.hint;
      d.querySelector('button').onclick = openEditor;
      body.appendChild(d);
    } else {
      $('#poem-title').textContent = p.title || 'Untitled';
      $('#poem-author').textContent = p.author || '';
      $('#poem-note').textContent = p.note || '';
      let n = 0;
      for (const st of p.text.split(/\n\s*\n/)) {
        const div = document.createElement('div');
        div.className = 'stanza';
        for (const raw of st.split('\n')) {
          const sp = document.createElement('span');
          sp.className = 'line';
          const lead = raw.match(/^\s*/)[0].length;
          sp.style.setProperty('--ind', Math.round(lead / 4));
          sp.style.setProperty('--dx', `${dir * 14}px`);
          sp.style.animationDelay = `${Math.min(n++ * 45, 1400)}ms`;
          sp.textContent = raw.trim() || ' ';
          div.appendChild(sp);
        }
        body.appendChild(div);
      }
      if (p.own) {
        const b = document.createElement('button');
        b.className = 'own-edit';
        b.textContent = 'edit your poem';
        b.onclick = openEditor;
        body.appendChild(b);
      }
    }
    $('#prev').disabled = i === 0;
    $('#next').disabled = i === L.length - 1;
    poem.classList.remove('out');
  }, dir ? 300 : 0);
}

function step(d) {
  const L = list(season);
  const n = (idx[season] || 0) + d;
  if (n < 0 || n >= L.length) return;
  idx[season] = n;
  renderPoem(d);
}

// ---------------------------------------------------------------- seasons
function loadParams(s) { return { ...DEFAULTS[s], ...store.get('params.' + s, {}) }; }

function enterSeason(s) {
  season = s;
  store.set('season', s);
  document.body.dataset.season = s;
  document.body.classList.add('reading');
  document.body.classList.toggle('text-off', !textOn);
  $('#reader').hidden = false;
  engine.params = loadParams(s);
  engine.setSeason(s);
  visuals.setSeason(s);
  document.querySelectorAll('.edge').forEach((el) => {
    const target = EDGE_SEASON[el.dataset.edge];
    el.style.setProperty('--edge', target === s ? 'currentColor' : `var(--edge-${target})`);
    el.querySelector('span').textContent = target === s ? 'cover' : NAMES[target];
  });
  $('#hints .h-hero').textContent = `the ${HERO_WORD[s]} records your voice`;
  renderPoem(0);
  syncPanel();
}

function goHome() {
  if (engine.recording) engine.stopRecording();
  engine.stopPlayback();
  engine.setSeason(null);
  season = null;
  document.body.classList.remove('reading');
  $('#reader').hidden = true;
  const home = $('#home');
  home.hidden = false;
  home.classList.remove('leaving');
}

async function start(s) {
  const home = $('#home');
  home.classList.add('leaving');
  setTimeout(() => { home.hidden = true; }, 1200);
  requestMotion();
  keepAwake();
  try { await engine.init(); } catch (e) { toast('Audio could not start'); }
  enterSeason(s);
  if (!store.get('hinted', false)) {
    store.set('hinted', true);
    const h = $('#hints');
    h.hidden = false;
    setTimeout(() => h.classList.add('gone'), 7000);
    setTimeout(() => { h.hidden = true; }, 8200);
  }
}

document.querySelectorAll('.quad').forEach((q) => q.addEventListener('click', () => start(q.dataset.season)));

// edges: first tap reveals, second tap within 1.4s goes
let armed = null, armTimer = 0;
document.querySelectorAll('.edge').forEach((el) => el.addEventListener('click', () => {
  const target = EDGE_SEASON[el.dataset.edge];
  if (armed === el) {
    clearTimeout(armTimer);
    el.classList.remove('armed');
    armed = null;
    if (target === season) goHome(); else enterSeason(target);
    return;
  }
  if (armed) armed.classList.remove('armed');
  armed = el;
  el.classList.add('armed');
  clearTimeout(armTimer);
  armTimer = setTimeout(() => { el.classList.remove('armed'); armed = null; }, 1400);
}));

$('#prev').onclick = () => step(-1);
$('#next').onclick = () => step(1);

// horizontal swipe on the poem
let sw = null;
$('#poem').addEventListener('pointerdown', (e) => { sw = { x: e.clientX, y: e.clientY }; });
$('#poem').addEventListener('pointerup', (e) => {
  if (!sw) return;
  const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
  sw = null;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 45) step(dx < 0 ? 1 : -1);
});

// ---------------------------------------------------------------- recording
async function toggleRecord() {
  await engine.resume();
  if (engine.recording) { engine.stopRecording(); return; }
  try {
    const ok = await engine.startRecording();
    if (!ok) toast('Recording is not supported in this browser');
  } catch (e) {
    toast('Microphone unavailable — check permissions');
  }
}
hero.addEventListener('click', toggleRecord);

let recTimer = 0;
engine.on('rec', (on) => {
  $('#p-rec').classList.toggle('on', on);
  $('#p-rec span').textContent = on ? 'Stop' : 'Record';
  clearInterval(recTimer);
  recTime.textContent = '';
  if (on) {
    recTimer = setInterval(() => {
      const s = Math.floor(engine.ctx.currentTime - engine.recStart);
      recTime.textContent = `● ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250);
  }
});
engine.on('take', (buf) => {
  if (!buf) { toast('Too short — try again'); return; }
  status();
  engine.playTake();
});
engine.on('play', status);
engine.on('live', (on) => { syncMode(); status(); if (on) toast('Live voice on — headphones only'); });
engine.on('feedback', () => toast('Feedback detected — live voice paused'));

function status() {
  const t = engine.take;
  $('#p-play').disabled = !t;
  $('#p-save').disabled = !t || !window.MediaRecorder;
  $('#p-play').textContent = engine.playing ? 'Stop' : 'Play take';
  $('#p-status').textContent = t ? `Take · ${t.duration.toFixed(1)}s, processed through ${NAMES[season] || ''}` : 'No take yet.';
}

// ---------------------------------------------------------------- panel
const panel = $('#panel');
$('#ornament').onclick = () => { syncPanel(); panel.hidden = false; };
$('#p-close').onclick = () => { panel.hidden = true; };
panel.addEventListener('click', (e) => { if (e.target === panel) panel.hidden = true; });

function setParam(k, v) {
  engine.setParams({ [k]: v });
  store.set('params.' + season, engine.params);
}

function drawKnob(el) {
  const v = engine.params[el.dataset.param];
  const a0 = Math.PI * 0.75, a1 = a0 + v * Math.PI * 1.5;
  const pt = (a, r = 24) => [32 + Math.cos(a) * r, 32 + Math.sin(a) * r];
  const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
  el.querySelector('.k-arc').setAttribute('d', `M${x0} ${y0} A24 24 0 ${v > 2 / 3 ? 1 : 0} 1 ${x1} ${y1}`);
  const [dx, dy] = pt(a1, 15);
  const dot = el.querySelector('.k-dot');
  dot.setAttribute('cx', dx);
  dot.setAttribute('cy', dy);
}

document.querySelectorAll('.knob').forEach((el) => {
  let y0 = 0, v0 = 0, lastTap = 0;
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    y0 = e.clientY;
    v0 = engine.params[el.dataset.param];
    const now = Date.now();
    if (now - lastTap < 300) { setParam(el.dataset.param, DEFAULTS[season][el.dataset.param]); drawKnob(el); }
    lastTap = now;
  });
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    setParam(el.dataset.param, Math.min(1, Math.max(0, v0 + (y0 - e.clientY) / 160)));
    drawKnob(el);
  });
});

const xy = $('#xy');
function drawXY() {
  xy.style.setProperty('--x', `${engine.params.tone * 100}%`);
  xy.style.setProperty('--y', `${(1 - engine.params.space) * 100}%`);
}
function xyFrom(e, rect) {
  setParam('tone', Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  setParam('space', Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height)));
  drawXY();
}
xy.addEventListener('pointerdown', (e) => { xy.setPointerCapture(e.pointerId); xyFrom(e, xy.getBoundingClientRect()); });
xy.addEventListener('pointermove', (e) => { if (xy.hasPointerCapture(e.pointerId)) xyFrom(e, xy.getBoundingClientRect()); });

// the stage itself is an XY pad when the text is hidden
const stage = $('#stage');
stage.addEventListener('pointerdown', (e) => {
  if (!season || textOn) return;
  stage.setPointerCapture(e.pointerId);
  visuals.ui.xy = { x: e.clientX, y: e.clientY };
  xyFrom(e, { left: 0, top: 0, width: innerWidth, height: innerHeight });
});
stage.addEventListener('pointermove', (e) => {
  if (!visuals.ui.xy || !stage.hasPointerCapture(e.pointerId)) return;
  visuals.ui.xy = { x: e.clientX, y: e.clientY };
  xyFrom(e, { left: 0, top: 0, width: innerWidth, height: innerHeight });
});
const endXY = () => { visuals.ui.xy = null; };
stage.addEventListener('pointerup', endXY);
stage.addEventListener('pointercancel', endXY);

function syncMode() {
  document.querySelectorAll('.seg button').forEach((b) => {
    const on = b.dataset.mode === (engine.live ? 'headphones' : 'speaker');
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
}
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', async () => {
  const wantLive = b.dataset.mode === 'headphones';
  if (wantLive === engine.live) return;
  if (wantLive && !confirm('Live voice plays your microphone back as you sing. Use headphones — with speakers it can feed back. Headphones on?')) return;
  try { await engine.setLive(wantLive); } catch (e) { toast('Microphone unavailable — check permissions'); }
  syncMode();
}));

$('#p-rec').onclick = toggleRecord;
$('#p-play').onclick = () => (engine.playing ? engine.stopPlayback() : engine.playTake());
$('#p-save').onclick = async () => {
  $('#p-save').disabled = true;
  toast('Rendering — the take plays through once');
  const blob = await engine.renderTake();
  status();
  if (!blob) return;
  const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
  const name = `four-seasons-${season}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'The Four Seasons' }); return; } catch (e) { /* cancelled */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

$('#p-text').onclick = () => {
  textOn = !textOn;
  store.set('textOn', textOn);
  document.body.classList.toggle('text-off', !textOn);
  syncPanel();
  if (!textOn) toast('Drag across the picture to play');
};
function setFs(v) {
  fs = Math.min(1.6, Math.max(0.75, v));
  store.set('fs', fs);
  document.documentElement.style.setProperty('--fs', fs);
}
$('#p-smaller').onclick = () => setFs(fs - 0.08);
$('#p-bigger').onclick = () => setFs(fs + 0.08);
$('#p-own').onclick = () => { panel.hidden = true; openEditor(); };

function syncPanel() {
  if (!season) return;
  $('#p-season').textContent = NAMES[season];
  document.querySelectorAll('.knob').forEach(drawKnob);
  drawXY();
  syncMode();
  status();
  $('#p-text').textContent = textOn ? 'Hide text' : 'Show text';
  $('#p-awake').textContent = awakeMsg;
}

// ---------------------------------------------------------------- editor
const editor = $('#editor');
function openEditor() {
  const m = own(season) || {};
  $('#e-season').textContent = NAMES[season];
  $('#e-title').value = m.title || '';
  $('#e-author').value = m.author || '';
  $('#e-text').value = m.text || '';
  editor.hidden = false;
}
$('#e-cancel').onclick = () => { editor.hidden = true; };
$('#e-save').onclick = () => {
  const text = $('#e-text').value.replace(/\r/g, '').replace(/^\n+|\s+$/g, '');
  if (!text) { toast('Nothing to keep yet'); return; }
  store.set('own.' + season, { title: $('#e-title').value.trim(), author: $('#e-author').value.trim(), text });
  editor.hidden = true;
  const L = list(season);
  idx[season] = L.findIndex((p) => p.own);
  renderPoem(0);
};
$('#e-clear').onclick = () => {
  try { localStorage.removeItem('fs.own.' + season); } catch (e) { /* ignore */ }
  editor.hidden = true;
  renderPoem(0);
};

// ---------------------------------------------------------------- wake lock
let lock = null, awakeMsg = '';
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
async function keepAwake() {
  let ok = false;
  if ('wakeLock' in navigator) {
    try {
      if (!lock || lock.released) lock = await navigator.wakeLock.request('screen');
      ok = true;
    } catch (e) { /* not allowed right now */ }
  }
  if (!ok || isIOS) {
    const v = $('#awake');
    try { await v.play(); ok = true; } catch (e) { /* no fallback */ }
  }
  awakeMsg = ok ? 'Screen stays awake while this is open.' : 'This browser may let the screen sleep — raise Auto-Lock in Settings for a reading.';
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && season) { keepAwake(); engine.resume(); }
});
document.addEventListener('pointerdown', () => {
  if (!season) return;
  engine.resume();
  if ('wakeLock' in navigator && (!lock || lock.released)) keepAwake();
}, { passive: true });

// ---------------------------------------------------------------- tilt
function requestMotion() {
  const D = window.DeviceOrientationEvent;
  const listen = () => addEventListener('deviceorientation', (e) => {
    if (e.gamma == null) return;
    visuals.tilt(e.gamma / 25, (e.beta - 50) / 25);
  });
  if (D && typeof D.requestPermission === 'function') D.requestPermission().then((r) => r === 'granted' && listen()).catch(() => {});
  else if (D) listen();
}
addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') visuals.tilt((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
});

// ---------------------------------------------------------------- misc
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

addEventListener('keydown', (e) => {
  if (!season || !editor.hidden) return;
  if (e.key === 'ArrowRight') step(1);
  if (e.key === 'ArrowLeft') step(-1);
});

const root = document.documentElement.style;
root.setProperty('--fs', fs);
root.setProperty('--edge-spring', '#d9738c');
root.setProperty('--edge-summer', '#e9573c');
root.setProperty('--edge-autumn', '#d99a2b');
root.setProperty('--edge-winter', '#a9c7dd');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
