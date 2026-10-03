// AudioWorklet processors.
//  - "tuner": YIN pitch detection + two-tap delay-line pitch shifter that
//    nudges the voice toward the current season's scale, plus a diatonic
//    harmony voice. Output channel 0 = tuned voice, channel 1 = harmony.
//  - "recorder": captures raw mono input in chunks for the take buffer.

class Shifter {
  constructor(win) {
    this.win = win;
    this.phase = 0;
  }
  // Read one sample from the ring buffer `buf` (write index w, mask m)
  // at the current ratio.
  step(buf, w, m, ratio) {
    const win = this.win;
    this.phase += (1 - ratio) / win;
    if (this.phase >= 1) this.phase -= 1;
    else if (this.phase < 0) this.phase += 1;
    const p1 = this.phase;
    const p2 = p1 + 0.5 < 1 ? p1 + 0.5 : p1 - 0.5;
    return tap(buf, w, m, p1 * win + 2) * Math.sin(Math.PI * p1) +
           tap(buf, w, m, p2 * win + 2) * Math.sin(Math.PI * p2);
  }
}

function tap(buf, w, m, delay) {
  const pos = w - delay;
  const i = Math.floor(pos);
  const f = pos - i;
  const a = buf[i & m];
  const b = buf[(i + 1) & m];
  return a + (b - a) * f;
}

class Tuner extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = 16384;
    this.mask = this.N - 1;
    this.buf = new Float32Array(this.N);
    this.w = 0;
    const win = Math.round(sampleRate * 0.04);
    this.s1 = new Shifter(win);
    this.s2 = new Shifter(Math.round(win * 1.13));

    // analysis at half rate
    this.dsr = sampleRate / 2;
    this.A = 1024;
    this.abuf = new Float32Array(this.A);
    this.aw = 0;
    this.half = 0;
    this.hold = 0;
    this.W = 512;
    this.minTau = Math.floor(this.dsr / 1000);
    this.maxTau = Math.min(Math.floor(this.dsr / 70), this.A - this.W - 2);
    this.d = new Float32Array(this.maxTau + 2);
    this.lin = new Float32Array(this.W + this.maxTau + 2);
    this.hop = 0;
    this.hopLen = 1024;

    this.root = 62;
    this.steps = [0, 2, 4, 7, 9];
    this.amount = 0.6;
    this.ratio = 1;
    this.target = 1;
    this.hratio = 1;
    this.htarget = 1;
    this.hgain = 0;
    this.voiced = false;
    this.rms = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.scale) { this.root = d.scale.root; this.steps = d.scale.steps; }
      if (typeof d.amount === 'number') this.amount = d.amount;
    };
  }

  snap(midi) {
    // nearest scale note to `midi`; returns [targetMidi, degreeIndex, octaveBase]
    const rel = midi - this.root;
    const oct = Math.floor(rel / 12);
    const pc = rel - oct * 12;
    let best = 0, bestD = 99, bestI = 0;
    const s = this.steps;
    for (let i = 0; i <= s.length; i++) {
      const step = i < s.length ? s[i] : 12;
      const dd = Math.abs(pc - step);
      if (dd < bestD) { bestD = dd; best = step; bestI = i % s.length; }
    }
    const octOut = best === 12 ? oct + 1 : oct;
    return [this.root + oct * 12 + best, bestI, octOut];
  }

  harmonyFor(degree, octave) {
    const s = this.steps;
    const j = degree + 2;
    const o = octave + Math.floor(j / s.length);
    return this.root + o * 12 + s[j % s.length];
  }

  analyse() {
    const A = this.A, W = this.W, maxTau = this.maxTau, lin = this.lin, d = this.d;
    const n = W + maxTau;
    let start = this.aw - n;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = this.abuf[(start + i + A * 4) % A];
      lin[i] = v;
      if (i < W) sum += v * v;
    }
    const rms = Math.sqrt(sum / W);
    this.rms = rms;
    if (rms < 0.008) { this.unvoiced(); return; }

    d[0] = 1;
    let running = 0;
    let found = -1;
    for (let tau = 1; tau <= maxTau; tau++) {
      let acc = 0;
      for (let j = 0; j < W; j++) {
        const x = lin[j] - lin[j + tau];
        acc += x * x;
      }
      running += acc;
      d[tau] = running > 0 ? acc * tau / running : 1;
      if (found < 0 && tau > this.minTau && d[tau] < 0.15) found = tau;
      if (found > 0 && tau > found && d[tau] > d[tau - 1]) { found = tau - 1; break; }
    }
    let conf;
    if (found < 0) {
      let mi = this.minTau, mv = 9;
      for (let tau = this.minTau; tau <= maxTau; tau++) if (d[tau] < mv) { mv = d[tau]; mi = tau; }
      if (mv > 0.32) { this.unvoiced(); return; }
      found = mi;
    }
    conf = 1 - d[found];
    // parabolic interpolation
    let tau = found;
    if (found > 1 && found < maxTau) {
      const a = d[found - 1], b = d[found], c = d[found + 1];
      const den = a - 2 * b + c;
      if (den !== 0) tau = found + 0.5 * (a - c) / den;
    }
    const f = this.dsr / tau;
    if (f < 70 || f > 1100) { this.unvoiced(); return; }

    const midi = 69 + 12 * Math.log2(f / 440);
    const [tgt, deg, oct] = this.snap(midi);
    let corr = (tgt - midi) * this.amount;
    if (corr > 3) corr = 3; else if (corr < -3) corr = -3;
    this.target = Math.pow(2, corr / 12);
    const harm = this.harmonyFor(deg, oct);
    this.htarget = Math.pow(2, (harm - midi) / 12);
    this.voiced = true;
    this.hold = 6;
    this.port.postMessage({ f, midi: tgt, raw: midi, rms, conf, voiced: true });
  }

  unvoiced() {
    if (this.hold > 0) { this.hold--; return; }
    this.voiced = false;
    this.target = 1;
    this.port.postMessage({ rms: this.rms, voiced: false });
  }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0];
    const o0 = out[0], o1 = out[1] || out[0];
    const len = o0.length;
    if (!inp) { o0.fill(0); if (o1 !== o0) o1.fill(0); return true; }

    // retune speed: strong correction = fast
    const k = 0.0005 + this.amount * this.amount * 0.004;
    const hgTarget = this.voiced ? 1 : 0;
    for (let i = 0; i < len; i++) {
      const x = inp[i];
      this.buf[this.w & this.mask] = x;

      this.ratio += (this.target - this.ratio) * k;
      this.hratio += (this.htarget - this.hratio) * 0.002;
      this.hgain += (hgTarget - this.hgain) * 0.0015;

      o0[i] = this.s1.step(this.buf, this.w, this.mask, this.ratio);
      if (o1 !== o0) o1[i] = this.s2.step(this.buf, this.w, this.mask, this.hratio) * this.hgain;
      this.w++;

      // downsample by 2 for analysis
      if (this.half) {
        this.abuf[this.aw % this.A] = (x + this.prev) * 0.5;
        this.aw = (this.aw + 1) % (this.A * 4);
      }
      this.prev = x;
      this.half ^= 1;
    }
    if (this.w > 1e9) this.w &= this.mask;
    this.hop += len;
    if (this.hop >= this.hopLen) { this.hop = 0; this.analyse(); }
    return true;
  }
}

class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.chunk = new Float32Array(16384);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.n = 0; }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (this.n) { this.port.postMessage({ chunk: this.chunk.slice(0, this.n) }); this.n = 0; }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch) {
      for (let i = 0; i < ch.length; i++) {
        this.chunk[this.n++] = ch[i];
        if (this.n === this.chunk.length) this.flush();
      }
    }
    return true;
  }
}

registerProcessor('tuner', Tuner);
registerProcessor('recorder', Recorder);
