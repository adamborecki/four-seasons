// Audio engine: generative season soundscapes, voice processing,
// take recording/playback, and feedback protection.
//
// Feedback safety model
//  - "speaker" mode (default): the microphone is NEVER routed to the
//    output. Recording captures the raw voice silently; it is processed and
//    played back afterwards with the mic closed.
//  - "headphones" mode: live processed voice. A howl detector watches the
//    mic spectrum and the output level and cuts live voice if it sees
//    feedback. A brickwall-ish limiter sits on the master bus always.
//  - listening (bloom.js): the mic is open but only captured, never
//    monitored; echoes play in your pauses and duck when you speak.

import { Listener, Bloom } from './bloom.js';

export const SCALES = {
  spring: { root: 62, steps: [0, 2, 4, 7, 9] },        // D major pentatonic
  summer: { root: 57, steps: [0, 2, 4, 6, 7, 9, 11] }, // A lydian
  autumn: { root: 50, steps: [0, 2, 3, 5, 7, 9, 10] }, // D dorian
  winter: { root: 52, steps: [0, 3, 5, 7, 10] },       // E minor pentatonic
};

export const DEFAULTS = {
  spring: { tone: 0.72, space: 0.62, air: 0.75, tune: 0.55, motion: 0.5, echo: 0.6 },
  summer: { tone: 0.6, space: 0.45, air: 0.75, tune: 0.5, motion: 0.5, echo: 0.6 },
  autumn: { tone: 0.55, space: 0.5, air: 0.75, tune: 0.45, motion: 0.5, echo: 0.6 },
  winter: { tone: 0.8, space: 0.3, air: 0.7, tune: 0.6, motion: 0.45, echo: 0.6 },
};

const RIG = {
  spring: { rev: { len: 3.6, bright: 0.55, wet: 0.55 }, amb: 2.6, ambSend: 0.45, voiceSend: 0.65 },
  summer: { rev: { len: 2.6, bright: 0.35, wet: 0.4 }, amb: 2.0, ambSend: 0.3, voiceSend: 0.45 },
  autumn: { rev: { len: 3.0, bright: 0.25, wet: 0.45 }, amb: 2.6, ambSend: 0.35, voiceSend: 0.5 },
  winter: { rev: { len: 1.5, bright: 0.8, wet: 0.3 }, amb: 4.2, ambSend: 0.2, voiceSend: 0.25 },
};

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const smooth = (x) => x * x * (3 - 2 * x);

function setSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* unsupported */ }
}

function noiseBuffer(ctx, seconds, kind) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
  }
  return b;
}

function impulse(ctx, seconds, bright) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const b = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const k = 0.08 + bright * 0.9 * (1 - t * 0.8);
      lp += ((Math.random() * 2 - 1) - lp) * k;
      const env = Math.exp(-6.5 * t) * (i < sr * 0.004 ? i / (sr * 0.004) : 1);
      d[i] = lp * env;
    }
  }
  return b;
}

function driveCurve(amount) {
  const n = 1024, c = new Float32Array(n), k = 1 + amount * 12;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * k) / norm;
  }
  return c;
}

// ---------------------------------------------------------------- Rig
// One per active season: ambience bus, reverb, voice FX, follower synth.

class Rig {
  constructor(engine, id) {
    this.e = engine;
    const c = (this.c = engine.ctx);
    this.id = id;
    this.cfg = RIG[id];
    this.nodes = [];

    this.out = c.createGain();
    this.out.gain.value = 0;
    this.out.connect(engine.master);

    this.reverb = c.createConvolver();
    this.reverb.buffer = impulse(c, this.cfg.rev.len, this.cfg.rev.bright);
    this.wet = c.createGain();
    this.send = c.createGain();
    this.send.connect(this.reverb);
    this.reverb.connect(this.wet);
    this.wet.connect(this.out);

    this.amb = c.createGain();
    this.tone = c.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.Q.value = 0.4;
    this.ambLevel = c.createGain();
    this.amb.connect(this.tone);
    this.tone.connect(this.ambLevel);
    this.ambLevel.connect(this.out);
    this.ambSend = c.createGain();
    this.ambSend.gain.value = this.cfg.ambSend;
    this.ambLevel.connect(this.ambSend);
    this.ambSend.connect(this.send);

    // very wet sounds (bells, glass) skip the dry path
    this.wetIn = c.createGain();
    this.wetLevel = c.createGain();
    this.wetIn.connect(this.wetLevel);
    this.wetLevel.connect(this.send);
    const wetDry = c.createGain();
    wetDry.gain.value = 0.35;
    this.wetLevel.connect(wetDry);
    wetDry.connect(this.out);

    this.voiceIn = c.createGain();
    this.voiceOut = c.createGain();
    this.voiceSend = c.createGain();
    this.voiceOut.connect(this.out);
    this.voiceOut.connect(this.voiceSend);
    this.voiceSend.connect(this.send);
    this.buildVoiceFx();
    this.buildFollower();
    this.bloom = new Bloom(this);

    this.scape = new SCAPES[id](this);
  }

  // --- small synth helpers -------------------------------------------
  pan(p, dest) {
    const c = this.c;
    if (c.createStereoPanner) {
      const n = c.createStereoPanner();
      n.pan.value = clamp(p, -1, 1);
      n.connect(dest);
      return n;
    }
    return dest;
  }
  osc(type, freq, dest) {
    const o = this.c.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (dest) o.connect(dest);
    o.start();
    this.nodes.push(o);
    return o;
  }
  loopNoise(kind, dest) {
    const s = this.c.createBufferSource();
    s.buffer = this.e.noise[kind];
    s.loop = true;
    s.connect(dest);
    s.start(0, Math.random() * 1.5);
    this.nodes.push(s);
    return s;
  }
  filter(type, freq, q, dest) {
    const f = this.c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q !== undefined) f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }
  gain(v, dest) {
    const g = this.c.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }
  bell(t, freq, vel, dur, { dest = this.wetIn, ratio = 3.5, index = 2, pan = 0 } = {}) {
    const c = this.c;
    const car = c.createOscillator(), mod = c.createOscillator();
    const mg = c.createGain(), amp = c.createGain();
    car.frequency.value = freq;
    mod.frequency.value = freq * ratio;
    mg.gain.setValueAtTime(freq * index, t);
    mg.gain.exponentialRampToValueAtTime(freq * 0.05 + 1, t + dur * 0.5);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(vel, t + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    mod.connect(mg); mg.connect(car.frequency);
    car.connect(amp);
    amp.connect(this.pan(pan, dest));
    car.start(t); mod.start(t);
    car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
  }
  blip(t, f0, f1, dur, vel, { dest = this.amb, pan = 0, type = 'sine' } = {}) {
    const c = this.c;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + Math.min(0.01, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.pan(pan, dest));
    o.start(t); o.stop(t + dur + 0.02);
  }
  hit(t, dur, freq, q, vel, { type = 'bandpass', dest = this.amb, pan = 0, attack = 0.002 } = {}) {
    const c = this.c;
    const s = c.createBufferSource();
    s.buffer = this.e.noise.white;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
    s.connect(f); f.connect(g); g.connect(this.pan(pan, dest));
    s.start(t, Math.random() * 1.5);
    s.stop(t + attack + dur + 0.05);
  }
  pluck(t, freq, vel, { dest = this.amb, pan = 0, decay = 2.4, bright = 3200 } = {}) {
    const c = this.c;
    const o = c.createOscillator(), o2 = c.createOscillator();
    o.type = 'triangle'; o.frequency.value = freq;
    o2.type = 'sine'; o2.frequency.value = freq * 2.003;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(bright, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, freq * 1.5), t + decay * 0.6);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const g2 = c.createGain(); g2.gain.value = 0.25;
    o.connect(f); o2.connect(g2); g2.connect(f); f.connect(g);
    const p = this.pan(pan, dest);
    g.connect(p);
    const ws = c.createGain(); ws.gain.value = 0.5; g.connect(ws); ws.connect(this.wetIn);
    o.start(t); o2.start(t); o.stop(t + decay + 0.05); o2.stop(t + decay + 0.05);
  }
  swell(t, freq, vel, { attack = 1.2, hold = 0.5, release = 4, dest = this.wetIn, pan = 0, type = 'sine', beat = 1.3 } = {}) {
    const c = this.c;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + attack);
    g.gain.setValueAtTime(vel, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    g.connect(this.pan(pan, dest));
    const end = t + attack + hold + release + 0.05;
    for (const df of [0, beat]) {
      const o = c.createOscillator();
      o.type = type; o.frequency.value = freq + df;
      o.connect(g); o.start(t); o.stop(end);
    }
  }

  // --- voice FX per season -------------------------------------------
  buildVoiceFx() {
    const c = this.c, inp = this.voiceIn, out = this.voiceOut;
    const id = this.id;
    this.fx = {};
    if (id === 'spring') {
      const hs = this.filter('highshelf', 5000);
      hs.gain.value = 4;
      inp.connect(hs); hs.connect(out);
      const dL = c.createDelay(1), dR = c.createDelay(1);
      dL.delayTime.value = 0.27; dR.delayTime.value = 0.4;
      const fL = this.gain(0.36), fR = this.gain(0.36);
      const merge = c.createChannelMerger(2);
      hs.connect(dL);
      dL.connect(fL); fL.connect(dR); dR.connect(fR); fR.connect(dL);
      dL.connect(merge, 0, 0); dR.connect(merge, 0, 1);
      const mix = this.gain(0.28, out);
      merge.connect(mix);
    } else if (id === 'summer') {
      const ls = this.filter('lowshelf', 220);
      ls.gain.value = 3;
      inp.connect(ls);
      const clean = this.gain(0.8, out);
      ls.connect(clean);
      const shaper = c.createWaveShaper();
      shaper.curve = driveCurve(0.6);
      shaper.oversample = '2x';
      this.fx.hot = this.gain(0.15, out);
      ls.connect(shaper); shaper.connect(this.fx.hot);
      // chorus
      const d = c.createDelay(0.1);
      d.delayTime.value = 0.02;
      const lfo = this.osc('sine', 0.55);
      const depth = this.gain(0.004);
      lfo.connect(depth); depth.connect(d.delayTime);
      ls.connect(d);
      const ch = this.gain(0.4);
      d.connect(this.pan(0.6, ch)); ch.connect(out);
    } else if (id === 'autumn') {
      const pk = this.filter('peaking', 340, 0.8);
      pk.gain.value = 3;
      const lp = this.filter('lowpass', 5200, 0.5);
      inp.connect(pk); pk.connect(lp);
      const wob = c.createDelay(0.1);
      wob.delayTime.value = 0.012;
      const lfo = this.osc('sine', 0.85);
      const depth = this.gain(0.0022);
      lfo.connect(depth); depth.connect(wob.delayTime);
      lp.connect(wob); wob.connect(out);
      const slap = c.createDelay(1);
      slap.delayTime.value = 0.21;
      const fb = this.gain(0.22);
      wob.connect(slap); slap.connect(fb); fb.connect(slap);
      const sg = this.gain(0.25);
      slap.connect(this.pan(-0.4, sg)); sg.connect(out);
    } else {
      const hp = this.filter('highpass', 190, 0.7);
      const hs = this.filter('highshelf', 4500);
      hs.gain.value = 5;
      inp.connect(hp); hp.connect(hs); hs.connect(out);
      // icy comb resonance at E5
      const comb = c.createDelay(0.05);
      comb.delayTime.value = 1 / mtof(76);
      const cfb = this.gain(0.62);
      hs.connect(comb); comb.connect(cfb); cfb.connect(comb);
      const cg = this.gain(0.12, out);
      comb.connect(cg);
      const echo = c.createDelay(1);
      echo.delayTime.value = 0.11;
      const eg = this.gain(0.16);
      hs.connect(echo); echo.connect(this.pan(0.5, eg)); eg.connect(out);
    }
  }

  // --- pitch-following synth -----------------------------------------
  buildFollower() {
    const c = this.c;
    const spec = {
      spring: { types: ['sine', 'sine'], mult: [1, 2], mix: [1, 0.35], oct: 1, lp: 6000 },
      summer: { types: ['sawtooth', 'sawtooth'], mult: [1, 1.004], mix: [0.5, 0.5], oct: 0, lp: 1300 },
      autumn: { types: ['triangle', 'sine'], mult: [1, 0.5], mix: [1, 0.5], oct: -1, lp: 2400 },
      winter: { types: ['sine', 'triangle'], mult: [1, 3], mix: [1, 0.12], oct: 1, lp: 9000 },
    }[this.id];
    this.fspec = spec;
    this.fgain = this.gain(0);
    const lp = this.filter('lowpass', spec.lp, 0.6);
    lp.connect(this.fgain);
    this.foscs = spec.types.map((type, i) => {
      const o = this.osc(type, 220 * spec.mult[i]);
      const g = this.gain(spec.mix[i], lp);
      o.connect(g);
      return o;
    });
    if (this.id === 'autumn') {
      const v = this.osc('sine', 5.1);
      const vd = this.gain(9);
      v.connect(vd);
      this.foscs.forEach((o) => vd.connect(o.detune));
    }
    const dry = this.gain(0.25, this.out);
    this.fgain.connect(dry);
    const ws = this.gain(1, this.send);
    this.fgain.connect(ws);
  }

  onPitch(d, active, tune) {
    const t = this.c.currentTime;
    if (active && d.voiced && d.rms > 0.012) {
      const f = mtof(d.midi + 12 * this.fspec.oct);
      this.foscs.forEach((o, i) => o.frequency.setTargetAtTime(f * this.fspec.mult[i], t, 0.05));
      const g = Math.min(0.07, clamp(d.rms * 5) * 0.09) * (0.3 + tune);
      this.fgain.gain.setTargetAtTime(g, t, 0.12);
    } else {
      this.fgain.gain.setTargetAtTime(0, t, 0.35);
    }
  }

  apply(p) {
    const t = this.c.currentTime, T = 0.08;
    this.tone.frequency.setTargetAtTime(280 * Math.pow(2, p.tone * 6), t, T);
    this.wet.gain.setTargetAtTime(this.cfg.rev.wet * (0.15 + 1.7 * p.space), t, T);
    this.ambLevel.gain.setTargetAtTime(p.air * this.cfg.amb, t, T);
    this.wetLevel.gain.setTargetAtTime(p.air * this.cfg.amb, t, T);
    this.voiceSend.gain.setTargetAtTime(this.cfg.voiceSend * (0.25 + 1.5 * p.space), t, T);
    this.bloom.setLevel(p.echo * 1.6);
    if (this.scape.apply) this.scape.apply(p);
  }

  fade(to, time) {
    const t = this.c.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(to, t + time);
  }

  dispose() {
    this.disposed = true;
    for (const n of this.nodes) { try { n.stop(); } catch (e) { /* already stopped */ } }
    try { this.out.disconnect(); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- Scapes

class Spring {
  constructor(r) {
    this.r = r;
    // rain bed
    this.rainG = r.gain(0.03, r.amb);
    const lp = r.filter('lowpass', 7800, 0.5, this.rainG);
    const hp = r.filter('highpass', 1500, 0.5, lp);
    r.loopNoise('pink', hp);
    // soft pad
    this.padG = r.gain(0.05, r.amb);
    const ps = r.gain(0.6, r.wetIn);
    this.padG.connect(ps);
    this.padF = r.filter('lowpass', 1300, 0.7, this.padG);
    this.chords = [[50, 57, 64, 66], [47, 54, 62, 69], [43, 50, 59, 64], [45, 52, 61, 69]];
    this.ci = 0;
    this.pad = this.chords[0].map((m, i) => {
      const o = r.osc(i % 2 ? 'sine' : 'triangle', mtof(m));
      o.detune.value = rand(-6, 6);
      const g = r.gain(0.22, this.padF);
      o.connect(g);
      return o;
    });
    const lfo = r.osc('sine', 0.07);
    const ld = r.gain(400, this.padF.frequency);
    lfo.connect(ld);
    this.next = null;
  }
  apply(p) { this.rainG.gain.setTargetAtTime(0.012 + p.motion * 0.05, this.r.c.currentTime, 0.5); }
  tick(t, p) {
    const r = this.r, ahead = t + 0.15, m = p.motion;
    if (!this.next) this.next = { chord: t + 8, drop: t, tw: t + 1, bird: t + rand(4, 9) };
    const n = this.next;
    if (n.chord < ahead) {
      this.ci = (this.ci + 1) % this.chords.length;
      this.chords[this.ci].forEach((mm, i) => this.pad[i].frequency.setTargetAtTime(mtof(mm), t, 1.6));
      n.chord = t + rand(8, 11);
    }
    while (n.drop < ahead) {
      const tt = Math.max(n.drop, t);
      const f = rand(1500, 3600);
      r.blip(tt, f, f * 0.55, rand(0.03, 0.07), rand(0.01, 0.04), { pan: rand(-0.9, 0.9), dest: Math.random() < 0.5 ? r.wetIn : r.amb });
      n.drop = tt + rand(0.04, 0.45) / (0.25 + m * 1.8);
    }
    if (n.tw < ahead) {
      const tt = Math.max(n.tw, t);
      const midi = 74 + pick([0, 2, 4, 7, 9, 12, 14, 16, 19]);
      const pan = rand(-0.8, 0.8);
      r.bell(tt, mtof(midi), rand(0.03, 0.07), rand(1.2, 2.4), { pan, ratio: pick([3.5, 2, 5]), index: rand(1, 2.5) });
      r.e.pushEvent({ type: 'twinkle', t: tt, pan, n: (midi - 74) / 19 });
      n.tw = tt + rand(0.5, 2.6) / (0.4 + m);
    }
    if (n.bird < ahead) {
      let tt = Math.max(n.bird, t);
      const base = rand(2600, 4200), count = 2 + ((Math.random() * 5) | 0), pan = rand(-1, 1);
      for (let i = 0; i < count; i++) {
        const f0 = base * rand(0.9, 1.15);
        r.blip(tt, f0, f0 * rand(1.2, 1.6), rand(0.05, 0.11), rand(0.012, 0.028), { pan, dest: r.wetIn });
        tt += rand(0.08, 0.16);
      }
      r.e.pushEvent({ type: 'bird', t: n.bird, pan });
      n.bird = tt + rand(5, 14) / (0.4 + m);
    }
  }
}

class Summer {
  constructor(r) {
    this.r = r;
    const c = r.c;
    // drone: clean + hot path crossfaded by heat
    this.droneOut = r.gain(0.05, r.amb);
    this.clean = r.gain(1, this.droneOut);
    this.hot = r.gain(0, this.droneOut);
    const shaper = c.createWaveShaper();
    shaper.curve = driveCurve(0.85);
    shaper.oversample = '2x';
    shaper.connect(this.hot);
    this.lp = r.filter('lowpass', 480, 0.9);
    this.lp.connect(this.clean);
    this.lp.connect(shaper);
    this.drone = [[45, 'sawtooth', -7, 0.3], [45, 'sawtooth', 7, 0.3], [33, 'sine', 0, 0.6], [52, 'sawtooth', 3, 0.18], [61, 'triangle', 0, 0.12]]
      .map(([m, type, det, g]) => {
        const o = r.osc(type, mtof(m));
        o.detune.value = det;
        o.connect(r.gain(g, this.lp));
        return o;
      });
    this.upper = [52, 54, 56, 52, 59];
    this.ui = 0;
    // cicadas
    this.cicadas = [[4700, 38, -0.6], [6100, 47, 0.6]].map(([f, rate, pan]) => {
      const swell = r.gain(0, r.pan(pan, r.amb));
      const am = r.gain(0.5, swell);
      const bp = r.filter('bandpass', f, 7, am);
      r.loopNoise('white', bp);
      const lfo = r.osc('square', rate);
      const ld = r.gain(0.5, am.gain);
      lfo.connect(ld);
      return { swell, until: 0 };
    });
    // sea wash
    this.seaG = r.gain(0.05, r.amb);
    const slp = r.filter('lowpass', 520, 0.5, this.seaG);
    r.loopNoise('brown', slp);
    const sl = r.osc('sine', 0.075);
    sl.connect(r.gain(0.035, this.seaG.gain));
    // shimmer for the heat peak
    this.shimmer = r.gain(0, r.wetIn);
    [93, 100, 105].forEach((m) => {
      const o = r.osc('sine', mtof(m));
      const v = r.osc('sine', rand(5, 7));
      v.connect(r.gain(14, o.detune));
      o.connect(r.gain(0.33, this.shimmer));
    });
    this.hs = null;
    this.heat = 0;
    this.blazed = false;
    this.next = null;
  }
  tick(t, p) {
    const r = this.r, ahead = t + 0.15, m = p.motion;
    if (!this.next) { this.next = { upper: t + 10, cic: t + 2, note: t + 3 }; this.hs = t + rand(16, 24); }
    const n = this.next;
    // heat cycle: warm -> too hot for a moment -> back
    const rise = 10, hold = 1.8, fall = 7;
    const dt = t - this.hs;
    let h = 0;
    if (dt < 0) h = 0;
    else if (dt < rise) h = Math.pow(smooth(dt / rise), 1.6);
    else if (dt < rise + hold) h = 1;
    else if (dt < rise + hold + fall) h = 1 - smooth((dt - rise - hold) / fall);
    else { this.hs = t + rand(28, 55) / (0.5 + m); this.blazed = false; }
    this.heat = h;
    r.e.state.heat = h;
    const T = 0.1;
    this.lp.frequency.setTargetAtTime(480 + h * h * 4200, t, T);
    this.hot.gain.setTargetAtTime(h * h * 0.9, t, T);
    this.clean.gain.setTargetAtTime(1 - h * 0.5, t, T);
    this.droneOut.gain.setTargetAtTime(0.05 + h * 0.025, t, T);
    this.shimmer.gain.setTargetAtTime(h * h * h * 0.03, t, T);
    if (r.fx.hot) r.fx.hot.gain.setTargetAtTime(0.12 + h * h * 0.55, t, T);
    if (h >= 1 && !this.blazed) {
      this.blazed = true;
      r.hit(t, 1.6, 5200, 0.6, 0.05, { type: 'highpass', attack: 0.4 });
      r.e.pushEvent({ type: 'blaze', t });
    }
    if (n.upper < ahead) {
      this.ui = (this.ui + 1) % this.upper.length;
      this.drone[3].frequency.setTargetAtTime(mtof(this.upper[this.ui]), t, 2);
      n.upper = t + rand(9, 13);
    }
    for (const cz of this.cicadas) {
      const base = h * 0.06;
      if (t > cz.until && Math.random() < 0.02 * (0.4 + m)) {
        const dur = rand(3, 8);
        cz.until = t + dur;
        cz.swell.gain.setTargetAtTime(rand(0.025, 0.05) + base, t, dur * 0.2);
        cz.swell.gain.setTargetAtTime(base, t + dur * 0.6, dur * 0.2);
      } else if (t > cz.until) {
        cz.swell.gain.setTargetAtTime(base, t, 0.5);
      }
    }
    if (n.note < ahead) {
      const tt = Math.max(n.note, t);
      const s = SCALES.summer.steps;
      const midi = 69 + s[(Math.random() * s.length) | 0] + pick([0, 12]);
      r.pluck(tt, mtof(midi), rand(0.03, 0.06), { pan: rand(-0.6, 0.6), decay: 2.8, bright: 2600 });
      r.e.pushEvent({ type: 'note', t: tt });
      n.note = tt + rand(2.5, 7) / (0.5 + m);
    }
  }
}

class Autumn {
  constructor(r) {
    this.r = r;
    this.winds = [[520, 1.4, -0.4], [900, 2.2, 0.5]].map(([f, q, pan]) => {
      const p = r.c.createStereoPanner ? r.c.createStereoPanner() : null;
      const g = r.gain(0.012);
      if (p) { p.pan.value = pan; g.connect(p); p.connect(r.amb); } else g.connect(r.amb);
      const bp = r.filter('bandpass', f, q, g);
      r.loopNoise('pink', bp);
      const ws = r.gain(0.3, r.wetIn);
      g.connect(ws);
      return { g, bp, p, base: f };
    });
    this.droneG = r.gain(0.04, r.amb);
    const lp = r.filter('lowpass', 680, 0.8, this.droneG);
    this.chords = [[38, 45, 53, 57], [40, 47, 55, 59], [41, 48, 57, 60], [43, 50, 59, 62]];
    this.ci = 0;
    const vib = r.osc('sine', 4.6);
    const vd = r.gain(4);
    vib.connect(vd);
    this.drone = this.chords[0].map((m, i) => {
      const o = r.osc(i < 2 ? 'sawtooth' : 'triangle', mtof(m));
      o.detune.value = rand(-5, 5);
      vd.connect(o.detune);
      o.connect(r.gain(i < 2 ? 0.25 : 0.35, lp));
      return o;
    });
    this.gust = 0;
    this.gustTarget = 0;
    this.gustTau = 1;
    this.next = null;
  }
  tick(t, p) {
    const r = this.r, ahead = t + 0.15, m = p.motion;
    if (!this.next) this.next = { gust: t + 1.5, gustEnd: 0, chord: t + 11, phrase: t + 3, leaf: t };
    const n = this.next;
    if (n.gust < ahead) {
      const dur = rand(2, 6);
      const peak = rand(0.5, 1) * (0.45 + m * 0.8);
      this.gustTarget = peak;
      this.gustTau = dur * 0.25;
      n.gustEnd = t + dur * 0.5;
      for (const w of this.winds) {
        w.g.gain.setTargetAtTime(0.012 + peak * 0.12, t, dur * 0.25);
        w.bp.frequency.setTargetAtTime(w.base * rand(1.3, 2.4), t, dur * 0.3);
        if (w.p) w.p.pan.setTargetAtTime(rand(-0.9, 0.9), t, dur * 0.5);
      }
      r.e.pushEvent({ type: 'gust', t, peak, dur });
      n.gust = t + dur * 0.7 + rand(2, 9) / (0.4 + m);
    }
    if (n.gustEnd && t > n.gustEnd) {
      n.gustEnd = 0;
      this.gustTarget = 0;
      this.gustTau = 1.4;
      for (const w of this.winds) {
        w.g.gain.setTargetAtTime(0.012, t, 1.2);
        w.bp.frequency.setTargetAtTime(w.base, t, 1.5);
      }
    }
    this.gust += (this.gustTarget - this.gust) * (1 - Math.exp(-0.05 / this.gustTau));
    r.e.state.gust = this.gust;
    // leaves rattle with the gusts
    while (n.leaf < ahead) {
      const tt = Math.max(n.leaf, t);
      r.hit(tt, rand(0.004, 0.022), rand(2400, 7000), 1.4, rand(0.01, 0.035) * (0.3 + this.gust), { pan: rand(-1, 1) });
      n.leaf = tt + 1 / (1.5 + this.gust * 70 * (0.3 + m));
    }
    if (n.chord < ahead) {
      this.ci = (this.ci + 1) % this.chords.length;
      this.chords[this.ci].forEach((mm, i) => this.drone[i].frequency.setTargetAtTime(mtof(mm), t, 2.2));
      n.chord = t + rand(10, 14);
    }
    if (n.phrase < ahead) {
      let tt = Math.max(n.phrase, t);
      const s = SCALES.autumn.steps;
      let deg = (Math.random() * s.length) | 0;
      const count = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < count; i++) {
        const midi = 62 + s[deg % s.length] + 12 * Math.floor(deg / s.length);
        r.pluck(tt, mtof(midi), rand(0.04, 0.07), { pan: rand(-0.5, 0.5) });
        deg += pick([1, 2, -1, 2]);
        if (deg < 0) deg = 0;
        tt += rand(0.28, 0.5);
      }
      n.phrase = tt + rand(3.5, 9) / (0.5 + m);
    }
  }
}

class Winter {
  constructor(r) {
    this.r = r;
    this.whistles = [[1200, 28, 0.025], [1850, 40, 0.016]].map(([f, q, g]) => {
      const gg = r.gain(g, r.pan(rand(-0.6, 0.6), r.amb));
      const bp = r.filter('bandpass', f, q, gg);
      r.loopNoise('white', bp);
      return { bp, g: gg, base: f, lvl: g };
    });
    this.rumble = r.gain(0.05, r.amb);
    const lp = r.filter('lowpass', 130, 0.7, this.rumble);
    r.loopNoise('brown', lp);
    this.next = null;
  }
  tick(t, p) {
    const r = this.r, ahead = t + 0.15, m = p.motion;
    if (!this.next) this.next = { drift: t, glass: t + 2, tick: t, cel: t + 6 };
    const n = this.next;
    if (n.drift < ahead) {
      for (const w of this.whistles) {
        w.bp.frequency.setTargetAtTime(w.base * rand(0.75, 1.35), t, rand(1.2, 3));
        w.g.gain.setTargetAtTime(w.lvl * rand(0.3, 1.4) * (0.5 + m), t, 1.5);
      }
      n.drift = t + rand(2, 4.5);
    }
    if (n.glass < ahead) {
      const tt = Math.max(n.glass, t);
      const s = SCALES.winter.steps;
      const midi = 76 + s[(Math.random() * s.length) | 0] + pick([0, 12]);
      const pan = rand(-0.8, 0.8);
      r.swell(tt, mtof(midi), rand(0.015, 0.03), { attack: rand(0.8, 1.6), hold: 0.3, release: rand(3, 5), pan, beat: rand(0.8, 2) });
      r.e.pushEvent({ type: 'glass', t: tt, pan, n: (midi - 76) / 22 });
      n.glass = tt + rand(3, 9) / (0.5 + m * 0.8);
    }
    while (n.tick < ahead) {
      const tt = Math.max(n.tick, t);
      r.hit(tt, rand(0.002, 0.006), rand(4500, 9500), 0.8, rand(0.006, 0.03), { type: 'highpass', pan: rand(-1, 1), attack: 0.0008 });
      n.tick = tt + rand(0.05, 1) / (0.4 + m * 5);
    }
    if (n.cel < ahead) {
      const tt = Math.max(n.cel, t);
      const s = SCALES.winter.steps;
      const midi = 88 + s[(Math.random() * s.length) | 0];
      r.bell(tt, mtof(midi), rand(0.015, 0.03), 1.4, { ratio: 7.01, index: 1.1, pan: rand(-0.7, 0.7) });
      r.e.pushEvent({ type: 'glass', t: tt, pan: 0, n: 0.9 });
      n.cel = tt + rand(6, 16);
    }
  }
}

const SCAPES = { spring: Spring, summer: Summer, autumn: Autumn, winter: Winter };


// ---------------------------------------------------------------- Engine

export class Engine {
  constructor() {
    this.ctx = null;
    this.rig = null;
    this.season = null;
    this.params = { ...DEFAULTS.spring };
    this.state = { heat: 0, gust: 0, voiceLevel: 0, pitch: 0, voiced: false, speaking: false, bloom: 0 };
    this.events = [];
    this.mode = 'speaker';
    this.live = false;
    this.listening = false;
    this.mic = null;
    this.capture = null;
    this.followerOn = false;
    this.handlers = {};
    this.howl = { bin: -1, count: 0, loud: 0 };
  }

  on(name, fn) { (this.handlers[name] ||= []).push(fn); }
  emit(name, data) { (this.handlers[name] || []).forEach((fn) => fn(data)); }
  pushEvent(ev) { this.events.push(ev); if (this.events.length > 64) this.events.shift(); }

  // Must be called from a user gesture (creates/resumes the AudioContext).
  // `offline` (an OfflineAudioContext) is only used for testing.
  async init(offline) {
    if (this.ctx) { await this.resume(); return; }
    setSession('playback');
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = (this.ctx = offline || new AC({ latencyHint: 'interactive' }));
    const resumed = offline ? Promise.resolve() : c.resume();

    this.noise = { white: noiseBuffer(c, 2, 'white'), pink: noiseBuffer(c, 4, 'pink'), brown: noiseBuffer(c, 4, 'brown') };

    this.master = c.createGain();
    this.master.gain.value = 0;
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -9;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.2;
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(c.destination);
    this.master.gain.setTargetAtTime(0.9, c.currentTime + 0.05, 0.6);
    this.timeBuf = new Float32Array(this.analyser.fftSize);

    this.silent = c.createGain();
    this.silent.gain.value = 0;
    this.silent.connect(c.destination);

    this.voiceIn = c.createGain();
    this.voiceIn.gain.value = 1.6;
    this.voiceTap = c.createGain();
    this.voiceTap.gain.value = 0;

    try {
      await c.audioWorklet.addModule(new URL('./worklets.js', import.meta.url));
      this.tuner = new AudioWorkletNode(c, 'tuner', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.tuner.port.onmessage = (e) => this.onPitch(e.data);
      this.voiceIn.connect(this.tuner);
      const split = c.createChannelSplitter(2);
      this.tuner.connect(split);
      this.harmGain = c.createGain();
      this.harmGain.gain.value = 0;
      split.connect(this.voiceTap, 0);
      split.connect(this.harmGain, 1);
      this.harmGain.connect(this.voiceTap);
      this.tuner.connect(this.silent);
      this.listenNode = new AudioWorkletNode(c, 'listener', { numberOfInputs: 1, numberOfOutputs: 1 });
      this.listenNode.connect(this.silent);
      this.listener = new Listener(this, this.listenNode);
    } catch (e) {
      console.warn('AudioWorklet unavailable; listening and tuning disabled', e);
      this.voiceIn.connect(this.voiceTap);
    }

    await resumed;
    if (!offline) this.timer = setInterval(() => this.tick(), 50);
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch (e) { /* needs gesture */ }
    }
  }

  setSeason(id) {
    if (!this.ctx || id === this.season) return;
    const old = this.rig;
    if (old) {
      old.fade(0, 2.4);
      setTimeout(() => {
        try { this.voiceTap.disconnect(old.voiceIn); } catch (e) { /* ignore */ }
        old.dispose();
      }, 3200);
    }
    this.season = id;
    this.state.heat = 0;
    this.state.gust = 0;
    if (!id) { this.rig = null; return; }
    const rig = new Rig(this, id);
    this.rig = rig;
    this.voiceTap.connect(rig.voiceIn);
    rig.fade(1, 2.4);
    if (this.state.speaking) rig.bloom.duckTo(true);
    if (this.tuner) this.tuner.port.postMessage({ scale: SCALES[id] });
    this.setParams(this.params);
  }

  setParams(p) {
    this.params = { ...this.params, ...p };
    if (!this.ctx) return;
    const P = this.params, t = this.ctx.currentTime;
    if (this.rig) this.rig.apply(P);
    if (this.harmGain) this.harmGain.gain.setTargetAtTime(Math.max(0, (P.tune - 0.35) / 0.65) * 0.55, t, 0.1);
    if (this.tuner) this.tuner.port.postMessage({ amount: P.tune });
  }

  setPause(sec) { if (this.listener) this.listener.pauseSec = sec; }

  onPitch(d) {
    const s = this.state;
    s.voiceLevel = d.rms || 0;
    s.voiced = !!d.voiced;
    if (d.voiced) s.pitch = d.midi;
    if (this.rig) this.rig.onPitch(d, this.followerOn, this.params.tune);
  }

  // ---- listening callbacks (from Listener) ---------------------------
  bloomDb() { return this.rig ? this.rig.bloom.db() : -120; }

  onSpeak(on) {
    this.state.speaking = on;
    if (this.rig) this.rig.bloom.duckTo(on);
    this.emit('speak', on);
  }

  onPhrase(phrase, pool, paused) {
    if (!this.rig || !this.listening) return;
    this.rig.bloom.start(phrase, pool, this.params);
    this.pushEvent({ type: 'bloom', t: this.ctx.currentTime, paused });
    this.emit('bloom', phrase);
  }

  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    let s = 0;
    for (let i = 0; i < this.timeBuf.length; i++) s += this.timeBuf[i] * this.timeBuf[i];
    return Math.sqrt(s / this.timeBuf.length);
  }

  tick(force) {
    if (!this.ctx || (this.ctx.state !== 'running' && !force)) return;
    const t = this.ctx.currentTime;
    if (this.rig) {
      this.rig.scape.tick(t, this.params);
      this.rig.bloom.tick(t, this.params, this.state.speaking, this.state.gust);
      const b = this.listening ? this.rig.bloom.db() : -120;
      this.state.bloom = clamp((b + 50) / 35);
    }
    this.guard();
  }

  // ---- microphone ----------------------------------------------------
  // Opening the mic switches iOS into play-and-record (a brief audio gap),
  // so it stays open for as long as listening or live voice needs it.
  async openMic() {
    if (this.mic) return this.mic;
    setSession('play-and-record');
    const hp = this.mode === 'headphones';
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: !hp, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    await this.resume();
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 8192;
    an.smoothingTimeConstant = 0;
    src.connect(an);
    an.connect(this.silent);
    src.connect(this.voiceIn); // pitch tracking for visuals; audible only when live
    if (this.listenNode) src.connect(this.listenNode);
    if (this.capture) src.connect(this.capture.voice);
    this.mic = { stream, src, an, fbuf: new Float32Array(an.frequencyBinCount) };
    return this.mic;
  }

  closeMic() {
    if (!this.mic) return;
    this.mic.stream.getTracks().forEach((tr) => tr.stop());
    try { this.mic.src.disconnect(); } catch (e) { /* ignore */ }
    this.mic = null;
    setSession('playback');
  }

  releaseMicIfIdle() { if (!this.listening && !this.live) this.closeMic(); }

  updateTap() {
    const t = this.ctx.currentTime;
    this.voiceTap.gain.setTargetAtTime(this.live ? 1 : 0, t, 0.03);
    this.followerOn = this.live;
  }

  async startListening() {
    if (this.listening) return true;
    if (!this.listener) return false;
    await this.openMic();
    this.listening = true;
    this.listener.start();
    this.emit('listen', true);
    return true;
  }

  stopListening() {
    if (!this.listening) return;
    this.listening = false;
    this.listener.stop();
    this.releaseMicIfIdle();
    this.emit('listen', false);
  }

  async setLive(on) {
    if (on === this.live) return;
    this.mode = on ? 'headphones' : 'speaker';
    this.live = on;
    if (this.mic) this.closeMic(); // reopen with/without echo cancellation
    if (this.listening || this.live) await this.openMic();
    this.howl = { bin: -1, count: 0, loud: 0 };
    this.updateTap();
    this.emit('live', this.live);
  }

  // ---- session recording: the full mix plus your dry voice -----------
  startCapture() {
    if (this.capture || !window.MediaRecorder) return false;
    const c = this.ctx;
    const dest = c.createMediaStreamDestination();
    const voice = c.createGain();
    voice.gain.value = this.live ? 0 : 1; // live mode already has the voice in the mix
    voice.connect(dest);
    this.analyser.connect(dest);
    if (this.mic) this.mic.src.connect(voice);
    const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
    const mime = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = () => res(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' })); });
    rec.start(1000);
    this.capture = { dest, voice, rec, done, start: c.currentTime };
    this.emit('capture', true);
    return true;
  }

  async stopCapture() {
    const cap = this.capture;
    if (!cap) return null;
    this.capture = null;
    cap.rec.stop();
    const blob = await cap.done;
    try { this.analyser.disconnect(cap.dest); } catch (e) { /* ignore */ }
    try { cap.voice.disconnect(); } catch (e) { /* ignore */ }
    this.emit('capture', false);
    return blob;
  }

  // Howl / runaway-level detector for live mode.
  guard() {
    if (!this.live || !this.mic) return;
    const { an, fbuf } = this.mic;
    an.getFloatFrequencyData(fbuf);
    const binHz = this.ctx.sampleRate / an.fftSize;
    const lo = Math.floor(150 / binHz), hi = Math.floor(7000 / binHz);
    let max = -Infinity, mi = 0, sum = 0;
    for (let i = lo; i < hi; i++) {
      const v = fbuf[i];
      if (v > max) { max = v; mi = i; }
      sum += v;
    }
    const mean = sum / (hi - lo);
    const h = this.howl;
    const suspicious = max > -22 && max - mean > 38;
    if (suspicious && Math.abs(mi - h.bin) <= 1) h.count++;
    else h.count = suspicious ? 1 : 0;
    h.bin = mi;
    const out = this.level();
    h.loud = out > 0.45 ? h.loud + 1 : 0;
    if (h.count >= 12 || h.loud >= 30) {
      const t = this.ctx.currentTime;
      this.voiceTap.gain.cancelScheduledValues(t);
      this.voiceTap.gain.setValueAtTime(0, t);
      this.setLive(false);
      this.emit('feedback');
    }
  }
}
