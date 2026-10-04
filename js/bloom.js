// Listening mode: the mic stays open, voice-activity detection splits what
// you say into phrases, and every pause is answered by a "bloom": your last
// words come back as an echo, then dissolve into fragments and a swell.
//
// Feedback safety: phrases are only captured while you are speaking, the
// bloom ducks under your voice, the speech threshold rises above the
// learned level of our own echo in the mic, and any phrase that started
// while an echo was sounding is played back quieter (0.6x per generation),
// so a self-sustaining loop always decays.

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const db = (x) => 20 * Math.log10(Math.max(1e-9, x));

// ---------------------------------------------------------------- Listener

export class Listener {
  constructor(engine, node) {
    this.e = engine;
    this.node = node;
    this.sr = engine.ctx.sampleRate;
    this.on = false;
    this.speaking = false;
    this.floor = -58;
    this.env = -90;
    this.above = 0;
    this.quietFor = 0;
    this.speechStart = 0;
    this.pauseSec = 0.8;
    this.maxHold = 16;
    this.pool = [];
    this.req = 0;
    this.waiting = new Map();
    this.bleed = -12;
    this.weight = 1;
    this.calibUntil = 0;
    this.hist = [];
    node.port.onmessage = (e) => this.onMsg(e.data);
  }

  start() {
    this.on = true;
    this.speaking = false;
    this.above = 0;
    this.quietFor = 0;
    this.hist = [];
  }

  stop() {
    this.on = false;
    if (this.speaking) { this.speaking = false; this.e.onSpeak(false); }
  }

  onMsg(d) {
    if (d.seg !== undefined) {
      const cb = this.waiting.get(d.id);
      this.waiting.delete(d.id);
      if (cb) cb(d.seg);
      return;
    }
    if (!this.on || d.rms === undefined) return;
    const e = this.e;
    const frame = d.n / this.sr;
    const env = (this.env = db(d.rms));
    const echoDb = e.bloomDb();
    const echoing = echoDb > -48;
    const t = e.ctx.currentTime;

    // Right after a pause the reader is silent: learn how loud our own echo
    // is in the mic, relative to what we are sending out.
    if (echoing && !this.speaking && t < this.calibUntil) {
      this.bleed += (env - echoDb - this.bleed) * 0.25;
      this.bleed = clamp(this.bleed, -45, 12);
    }
    // Noise floor = a low percentile of the last ~3 s (the gaps between
    // words), ignoring moments when our own echo is sounding.
    if (!echoing) {
      this.hist.push(env);
      if (this.hist.length > 150) this.hist.shift();
      const sorted = this.hist.slice().sort((x, y) => x - y);
      this.floor = clamp(sorted[Math.floor(sorted.length * 0.1)], -80, -30);
    }
    if (this.hist.length < 25) return; // ~0.5 s to learn the room
    let on = Math.max(this.floor + 11, -54);
    if (echoing) on = Math.max(on, echoDb + this.bleed + 9);

    if (!this.speaking) {
      this.above = env > on ? this.above + 1 : 0;
      if (this.above * frame >= 0.06) {
        this.speaking = true;
        this.quietFor = 0;
        this.speechStart = d.pos - Math.round((this.above * frame + 0.25) * this.sr);
        // Barely louder than our own predicted echo? It may be the phone
        // hearing itself, so its answer will be quieter (and decays).
        const margin = env - (echoDb + this.bleed);
        this.weight = echoing && margin < 15 ? this.weight * 0.6 : 1;
        e.onSpeak(true);
      }
      return;
    }
    const off = echoing ? on - 4 : Math.max(this.floor + 6, -60);
    this.quietFor = env < off ? this.quietFor + frame : 0;
    if (this.quietFor >= this.pauseSec) {
      this.speaking = false;
      e.onSpeak(false);
      this.capture(this.speechStart, d.pos - Math.round((this.quietFor - 0.2) * this.sr), true);
    } else if ((d.pos - this.speechStart) / this.sr >= this.maxHold) {
      // never paused: it has to go eventually, so bloom underneath
      this.capture(this.speechStart, d.pos, false);
      this.speechStart = d.pos;
    }
  }

  capture(a, b, paused) {
    if ((b - a) / this.sr < 0.35) return;
    const id = ++this.req;
    const weight = this.weight;
    this.waiting.set(id, (seg) => {
      if (!seg || seg.length < this.sr * 0.3) return;
      const buf = this.e.ctx.createBuffer(1, seg.length, this.sr);
      const ch = buf.getChannelData(0);
      ch.set(seg);
      const f = Math.min(600, seg.length >> 3);
      for (let i = 0; i < f; i++) { ch[i] *= i / f; ch[seg.length - 1 - i] *= i / f; }
      const phrase = { buf, weight };
      this.pool.push(phrase);
      let total = this.pool.reduce((s, p) => s + p.buf.duration, 0);
      while (this.pool.length > 8 || (total > 45 && this.pool.length > 1)) total -= this.pool.shift().buf.duration;
      this.calibUntil = this.e.ctx.currentTime + 0.7;
      this.e.onPhrase(phrase, this.pool, paused);
    });
    this.node.port.postMessage({ get: { a, b, id } });
  }
}

// ---------------------------------------------------------------- Bloom

const BLOOM = {
  spring: {
    delay: 0.375, fb: 0.42, filt: ['highpass', 350], mix: 0.5, pan: 0.5,
    doubles: [[2, 0.16]], grain: [0.08, 0.22], density: [6, 18], rates: [2, 1.5, 2, 3, 1.5],
    chord: [1, 1.5, 2], chordGain: 0.1, grainGain: 0.34, width: 0.9,
  },
  summer: {
    delay: 0.5, fb: 0.38, filt: ['lowpass', 3200], mix: 0.45, pan: -0.4,
    doubles: [[1.008, 0.25], [0.992, 0.25]], grain: [0.15, 0.35], density: [4, 12], rates: [1.5, 1.26, 0.75, 1.414],
    chord: [1, 1.26, 1.5], chordGain: 0.09, grainGain: 0.32, width: 0.7,
  },
  autumn: {
    delay: 0.62, fb: 0.5, filt: ['lowpass', 1600], mix: 0.55, pan: 0.4,
    doubles: [[0.5, 0.18]], grain: [0.2, 0.5], density: [3, 9], rates: [0.5, 0.75, 1.5, 0.667],
    chord: [0.5, 0.75, 1], chordGain: 0.11, grainGain: 0.3, width: 0.8,
  },
  winter: {
    delay: 0.28, fb: 0.28, filt: ['highpass', 700], mix: 0.35, pan: -0.5,
    doubles: [[1.5, 0.12]], grain: [0.04, 0.12], density: [5, 16], rates: [2, 4, 1.5, 2],
    chord: [1, 2, 3], chordGain: 0.07, grainGain: 0.38, width: 1,
  },
};

export class Bloom {
  constructor(rig) {
    this.r = rig;
    const c = (this.c = rig.c);
    const cfg = (this.cfg = BLOOM[rig.id]);
    this.input = c.createGain();
    this.duck = c.createGain();
    this.level = c.createGain();
    this.input.connect(this.duck);
    this.duck.connect(this.level);
    this.level.connect(rig.voiceIn);

    const d = c.createDelay(2);
    d.delayTime.value = cfg.delay;
    const f = c.createBiquadFilter();
    f.type = cfg.filt[0];
    f.frequency.value = cfg.filt[1];
    const fb = c.createGain();
    fb.gain.value = cfg.fb;
    this.level.connect(d);
    d.connect(f);
    f.connect(fb);
    fb.connect(d);
    const mix = c.createGain();
    mix.gain.value = cfg.mix;
    f.connect(mix);
    mix.connect(rig.pan(cfg.pan, rig.voiceIn));

    this.meter = c.createAnalyser();
    this.meter.fftSize = 512;
    this.mbuf = new Float32Array(this.meter.fftSize);
    this.level.connect(this.meter);
    this.plan = null;
  }

  db() {
    this.meter.getFloatTimeDomainData(this.mbuf);
    let s = 0;
    for (let i = 0; i < this.mbuf.length; i++) s += this.mbuf[i] * this.mbuf[i];
    return db(Math.sqrt(s / this.mbuf.length));
  }

  setLevel(v) { this.level.gain.setTargetAtTime(v, this.c.currentTime, 0.1); }

  duckTo(speaking) {
    this.duck.gain.setTargetAtTime(speaking ? 0.22 : 1, this.c.currentTime, speaking ? 0.15 : 0.4);
  }

  grain(t, buf, off, dur, rate, gain, pan, attack, release) {
    if (gain <= 0.0005) return;
    const c = this.c;
    const need = dur * rate;
    off = clamp(off, 0, Math.max(0, buf.duration - need - 0.005));
    const s = c.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = c.createGain();
    const a = attack ?? dur * 0.4, r = release ?? dur * 0.6;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + a);
    g.gain.setValueAtTime(gain, t + Math.max(a, dur - r));
    g.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(g);
    g.connect(this.r.pan(pan, this.input));
    s.start(t, off, Math.min(need + 0.01, buf.duration - off));
    s.stop(t + dur + 0.02);
  }

  start(phrase, pool, params) {
    const w = phrase.weight;
    if (w < 0.2) return;
    const cfg = this.cfg, buf = phrase.buf, D = buf.duration;
    const t0 = this.c.currentTime + 0.12;
    // 1. the last words, as an echo
    const tail = Math.min(2.6, D), off = D - tail;
    this.grain(t0, buf, off, tail, 1, 0.9 * w, cfg.pan * -0.5, 0.03, 0.25);
    for (const [rate, gain] of cfg.doubles) {
      this.grain(t0 + 0.02, buf, off, tail / rate, rate, gain * w * (0.4 + params.tune), -cfg.pan, 0.06, 0.4);
    }
    // 2. then dissolve
    const start = t0 + tail * 0.55;
    this.plan = {
      buf, pool: pool.slice(), w, start,
      len: 5 + params.motion * 8,
      nextGrain: start,
      nextChord: t0 + tail * 0.7,
      chordPos: loudest(buf, off),
    };
  }

  tick(t, params, speaking, gust) {
    const p = this.plan;
    if (!p) return;
    const cfg = this.cfg, ahead = t + 0.15, end = p.start + p.len;
    if (t > end) { this.plan = null; return; }

    while (p.nextGrain < ahead && p.nextGrain < end) {
      const tt = Math.max(p.nextGrain, t);
      const tau = tt - p.start;
      const shape = clamp(tau / 1.2) * Math.exp(-Math.max(0, tau - 1.2) / (p.len / 2.8));
      let dens = (cfg.density[0] + params.motion * cfg.density[1]) * Math.max(shape, 0.05);
      if (speaking) dens *= 0.15;
      if (this.r.id === 'autumn') dens *= 0.6 + gust * 1.4;
      const fromPool = p.pool.length > 1 && Math.random() < 0.3;
      const src = fromPool ? pick(p.pool).buf : p.buf;
      const recent = !fromPool && Math.random() < 0.6;
      const off = recent ? rand(Math.max(0, src.duration - 3), src.duration) : rand(0, src.duration);
      const rate = Math.random() < params.tune * 0.8 ? pick(cfg.rates) : 1 + rand(-0.004, 0.004);
      const gain = cfg.grainGain * p.w * (0.5 + 0.5 * shape) * rand(0.6, 1);
      this.grain(tt, src, off, rand(cfg.grain[0], cfg.grain[1]), rate, gain, rand(-cfg.width, cfg.width));
      p.nextGrain = tt + rand(0.5, 1.5) / Math.max(dens, 0.5);
    }

    const chordEnd = p.start + p.len * 0.75;
    while (params.tune > 0.05 && p.nextChord < ahead && p.nextChord < chordEnd) {
      const tt = Math.max(p.nextChord, t);
      const env = Math.sin(Math.PI * clamp((tt - p.start) / (chordEnd - p.start)));
      const g = cfg.chordGain * env * params.tune * p.w * (speaking ? 0.3 : 1);
      for (const rate of cfg.chord) this.grain(tt, p.buf, p.chordPos + rand(-0.01, 0.01), 0.26, rate, g, rand(-0.5, 0.5));
      p.nextChord = tt + 0.09;
    }
  }
}

// start of the loudest 40ms window at or after `from` seconds (a held vowel)
function loudest(buf, from) {
  const d = buf.getChannelData(0), sr = buf.sampleRate, win = Math.round(sr * 0.04);
  let best = from, bestE = -1;
  for (let i = Math.floor(from * sr); i + win < d.length; i += win >> 1) {
    let e = 0;
    for (let j = 0; j < win; j += 4) e += d[i + j] * d[i + j];
    if (e > bestE) { bestE = e; best = i / sr; }
  }
  return Math.max(0, best - 0.1);
}
