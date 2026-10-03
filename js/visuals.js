// Canvas renderer: four abstract, parallax season scenes that respond to
// tilt, touch, the soundscape (events, heat, gusts) and the voice.

const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const ease = (x) => x * x * (3 - 2 * x);

function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, t) {
  const A = hex(a), B = hex(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`;
}
function rgba(c, a) {
  const [r, g, b] = hex(c);
  return `rgba(${r},${g},${b},${a})`;
}
function circle(g, x, y, r, fill) {
  g.beginPath();
  g.arc(x, y, Math.max(0, r), 0, TAU);
  g.fillStyle = fill;
  g.fill();
}
function ring(g, x, y, r, stroke, lw) {
  g.beginPath();
  g.arc(x, y, Math.max(0, r), 0, TAU);
  g.strokeStyle = stroke;
  g.lineWidth = lw;
  g.stroke();
}
function vgrad(g, h, top, bottom) {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, top);
  gr.addColorStop(1, bottom);
  return gr;
}

class Scene {
  resize(w, h) {
    this.w = w; this.h = h; this.u = Math.min(w, h, 900);
    if (!this.ready) { this.init(); this.ready = true; }
  }
  init() {}
  P(d, S) { const k = this.u * 0.06 * d; return [S.px * k, S.py * k]; }
  heroPos(S) {
    const [ox, oy] = this.P(0.35, S);
    const r = Math.min(this.u * 0.115, 110);
    return { x: this.w * 0.78 + ox, y: Math.max(this.h * 0.14, 70 + r) + oy, r };
  }
  // record / playback rings around the hero shape
  heroState(g, hero, S, color) {
    const { x, y, r } = hero;
    if (S.rec) {
      const pulse = 0.5 + 0.5 * Math.sin(S.t * 5);
      ring(g, x, y, r * (1.28 + pulse * 0.05), rgba(color, 0.35 + pulse * 0.4), 2);
      g.beginPath();
      g.arc(x, y, r * 1.42, -Math.PI / 2, -Math.PI / 2 + TAU * ((S.recT % 60) / 60));
      g.strokeStyle = rgba(color, 0.9);
      g.lineWidth = 2.5;
      g.lineCap = 'round';
      g.stroke();
    } else if (S.playing) {
      g.save();
      g.translate(x, y);
      g.rotate(S.t * 0.6);
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * TAU;
        circle(g, Math.cos(a) * r * 1.35, Math.sin(a) * r * 1.35, 1.6 + S.level * 2.5, rgba(color, 0.75));
      }
      g.restore();
    }
  }
}

// ---------------------------------------------------------------- Spring

const SP = { bg0: '#F5F0E4', bg1: '#E2ECDB', pink: '#F0B3C2', lilac: '#BBA9D9', green: '#9CC6A0', butter: '#F5E2A0', moss: '#3E6A4E', rose: '#D9738C' };

class SpringScene extends Scene {
  init() {
    this.blooms = [
      { x: 0.1, y: 0.8, r: 0.44, c: SP.pink, d: 0.6, ph: 0 },
      { x: 0.46, y: 0.95, r: 0.3, c: SP.lilac, d: 0.9, ph: 1.3 },
      { x: 0.95, y: 0.7, r: 0.3, c: SP.green, d: 0.45, ph: 2.1 },
      { x: 0.06, y: 0.22, r: 0.13, c: SP.butter, d: 0.25, ph: 3.2 },
      { x: 0.64, y: 0.42, r: 0.05, c: SP.pink, d: 1.2, ph: 4.4 },
    ];
    this.stems = [0.18, 0.27, 0.58, 0.86].map((x, i) => ({ x, top: rand(0.55, 0.72), ph: i * 1.7, c: pick([SP.rose, SP.butter, SP.lilac]) }));
    this.rain = Array.from({ length: 110 }, () => ({ x: Math.random(), y: Math.random(), l: rand(0.012, 0.03), s: rand(0.25, 0.6), d: rand(0.3, 1.2) }));
    this.stars = [];
    this.birds = [];
  }
  draw(g, S) {
    const { w, h, u } = this;
    g.fillStyle = vgrad(g, h, SP.bg0, SP.bg1);
    g.fillRect(0, 0, w, h);

    // hill
    let [ox, oy] = this.P(0.8, S);
    g.beginPath();
    g.arc(w * 0.7 + ox, h + u * 0.08 + oy, u * 0.48, Math.PI, TAU);
    g.fillStyle = rgba(SP.green, 0.85);
    g.fill();

    g.globalCompositeOperation = 'multiply';
    for (const b of this.blooms) {
      [ox, oy] = this.P(b.d, S);
      const r = b.r * u * (1 + 0.04 * Math.sin(S.t * 0.25 + b.ph) + S.level * 0.2 * b.d);
      circle(g, b.x * w + ox, b.y * h + oy, r, b.c);
    }
    g.globalCompositeOperation = 'source-over';

    // stems with buds
    for (const s of this.stems) {
      [ox, oy] = this.P(1, S);
      const sway = Math.sin(S.t * 0.6 + s.ph) * u * 0.02;
      const x = s.x * w + ox, ty = s.top * h + oy - S.level * u * 0.05;
      g.beginPath();
      g.moveTo(x, h + 4);
      g.quadraticCurveTo(x, (h + ty) / 2, x + sway, ty);
      g.strokeStyle = rgba(SP.moss, 0.55);
      g.lineWidth = 1.2;
      g.stroke();
      circle(g, x + sway, ty, u * (0.014 + S.level * 0.02), s.c);
    }

    // rain
    g.strokeStyle = rgba(SP.moss, 0.2);
    g.lineWidth = 1;
    g.beginPath();
    const count = Math.floor(30 + S.motion * 80);
    for (let i = 0; i < count; i++) {
      const d = this.rain[i];
      d.y += d.s * S.dt * (0.4 + S.motion) * (0.6 + d.d * 0.6);
      if (d.y > 1.05) { d.y = -0.05; d.x = Math.random(); }
      [ox, oy] = this.P(d.d, S);
      const x = d.x * w + ox, y = d.y * h + oy;
      g.moveTo(x, y);
      g.lineTo(x - d.l * u * 0.25, y + d.l * u);
    }
    g.stroke();

    // twinkles and birds from the soundscape
    for (const ev of S.events) {
      if (ev.type === 'twinkle') this.stars.push({ x: 0.5 + ev.pan * 0.42, y: 0.2 + (1 - ev.n) * 0.45, born: S.t });
      if (ev.type === 'bird') this.birds.push({ x: 0.5 + ev.pan * 0.4, y: rand(0.12, 0.35), born: S.t });
    }
    this.stars = this.stars.filter((s) => S.t - s.born < 2.2);
    for (const s of this.stars) {
      const a = 1 - (S.t - s.born) / 2.2;
      [ox, oy] = this.P(1.3, S);
      star(g, s.x * w + ox, s.y * h + oy, u * 0.028 * (0.4 + a), rgba(SP.rose, a * 0.9));
    }
    this.birds = this.birds.filter((b) => S.t - b.born < 3);
    for (const b of this.birds) {
      const age = S.t - b.born, a = 1 - age / 3;
      [ox, oy] = this.P(1.1, S);
      const bx = (b.x + age * 0.05) * w + ox, by = (b.y - age * 0.02) * h + oy;
      const flap = Math.sin(age * 14) * u * 0.008;
      g.beginPath();
      g.moveTo(bx - u * 0.02, by - flap);
      g.quadraticCurveTo(bx - u * 0.008, by - u * 0.006, bx, by);
      g.quadraticCurveTo(bx + u * 0.008, by - u * 0.006, bx + u * 0.02, by - flap);
      g.strokeStyle = rgba(SP.moss, a * 0.7);
      g.lineWidth = 1.4;
      g.stroke();
    }

    // hero: morning sun with a ring of petals (the petal ring is the cog)
    const hero = (this.hero = this.heroPos(S));
    circle(g, hero.x, hero.y, hero.r * (1 + S.level * 0.08), SP.butter);
    g.save();
    g.translate(hero.x, hero.y);
    g.rotate(S.t * 0.05);
    for (let i = 0; i < 12; i++) {
      g.rotate(TAU / 12);
      g.beginPath();
      g.ellipse(hero.r * 1.22, 0, hero.r * 0.1, hero.r * 0.045, 0, 0, TAU);
      g.fillStyle = rgba(SP.rose, 0.55);
      g.fill();
    }
    g.restore();
    this.heroState(g, hero, S, SP.rose);
  }
}

function star(g, x, y, r, fill) {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU - Math.PI / 2;
    const rr = i % 2 ? r * 0.22 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

// ---------------------------------------------------------------- Summer

const SU = { top: '#FBD58C', topHot: '#FFF5DA', bot: '#F39A5E', botHot: '#FF6E3C', sun: '#E9573C', sunHot: '#FFB46A', magenta: '#D8467B', aqua: '#7FD1C5', teal: '#2AA79F', deep: '#1F7F86', cream: '#FFF1D6' };

class SummerScene extends Scene {
  init() {
    this.sails = [0.3, 0.55, 0.82].map((x, i) => ({ x, s: rand(0.6, 1), ph: i * 2 }));
    this.ripples = [];
    this.flash = 0;
  }
  draw(g, S) {
    const { w, h, u } = this;
    const heat = S.heat;
    g.fillStyle = vgrad(g, h, mix(SU.top, SU.topHot, heat), mix(SU.bot, SU.botHot, heat * 0.8));
    g.fillRect(0, 0, w, h);

    // sun
    const hero = (this.hero = this.heroPos(S));
    const sr = hero.r * (1 + heat * 0.45 + S.level * 0.1);
    for (let i = 0; i < 3; i++) {
      const p = (S.t * 0.12 + i / 3) % 1;
      ring(g, hero.x, hero.y, sr * (1.15 + p * 1.6), rgba(SU.sun, (1 - p) * 0.35), 1.2);
    }
    circle(g, hero.x, hero.y, sr, mix(SU.sun, SU.sunHot, heat * 0.7));
    g.save();
    g.translate(hero.x, hero.y);
    g.rotate(-S.t * 0.04);
    g.fillStyle = rgba(SU.cream, 0.5);
    for (let i = 0; i < 36; i++) {
      g.rotate(TAU / 36);
      g.fillRect(sr * 1.08, -0.8, sr * (i % 3 ? 0.06 : 0.12), 1.6);
    }
    g.restore();

    // heat haze lines
    if (heat > 0.25) {
      g.strokeStyle = rgba(SU.cream, (heat - 0.25) * 0.6);
      g.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const y0 = h * (0.3 + i * 0.07);
        g.beginPath();
        for (let x = 0; x <= w; x += 10) g.lineTo(x, y0 + Math.sin(x * 0.03 + S.t * 3 + i) * 4 * heat);
        g.stroke();
      }
    }

    // magenta dune
    const horizon = h * 0.72;
    let [ox, oy] = this.P(0.5, S);
    g.beginPath();
    g.arc(w * 0.16 + ox, horizon + oy + 2, u * 0.34, Math.PI, TAU);
    g.fillStyle = SU.magenta;
    g.fill();

    // sails
    for (const s of this.sails) {
      [ox, oy] = this.P(0.6, S);
      s.x += S.dt * 0.004 * s.s;
      if (s.x > 1.15) s.x = -0.15;
      const bob = Math.sin(S.t * 1.2 + s.ph) * u * 0.006;
      const x = s.x * w + ox, y = horizon + oy + bob;
      g.beginPath();
      g.moveTo(x, y - u * 0.09 * s.s);
      g.lineTo(x + u * 0.05 * s.s, y);
      g.lineTo(x, y);
      g.closePath();
      g.fillStyle = SU.cream;
      g.fill();
    }

    // sea bands
    const bands = [[SU.aqua, 0.4, 0, 0.012], [SU.teal, 0.7, 0.06, 0.016], [SU.deep, 1.0, 0.14, 0.02]];
    bands.forEach(([c, d, off, amp], i) => {
      [ox, oy] = this.P(d, S);
      const base = horizon + off * h + oy;
      g.beginPath();
      g.moveTo(0, h);
      for (let x = -20; x <= w + 20; x += 12) {
        g.lineTo(x, base + Math.sin(x * 0.012 + S.t * (0.5 + i * 0.25) + i) * u * amp * (1 + S.level));
      }
      g.lineTo(w + 20, h);
      g.closePath();
      g.fillStyle = c;
      g.fill();
    });

    for (const ev of S.events) {
      if (ev.type === 'note') this.ripples.push({ x: rand(0.15, 0.85), y: rand(0.8, 0.95), born: S.t });
      if (ev.type === 'blaze') this.flash = 1;
    }
    this.ripples = this.ripples.filter((r) => S.t - r.born < 2.5);
    for (const r of this.ripples) {
      const p = (S.t - r.born) / 2.5;
      g.beginPath();
      g.ellipse(r.x * w, r.y * h, u * 0.12 * p, u * 0.025 * p, 0, 0, TAU);
      g.strokeStyle = rgba(SU.cream, (1 - p) * 0.6);
      g.lineWidth = 1.2;
      g.stroke();
    }
    if (this.flash > 0.01) {
      g.fillStyle = rgba('#FFFFFF', this.flash * 0.35);
      g.fillRect(0, 0, w, h);
      this.flash *= Math.pow(0.2, S.dt);
    }
    this.heroState(g, hero, S, SU.cream);
  }
}

// ---------------------------------------------------------------- Autumn

const AU = { bg0: '#3A1E19', bg1: '#5C2B1E', ochre: '#D99A2B', rust: '#B5482A', plum: '#6B2E45', mustard: '#E8C15A', olive: '#7C7A3A', cream: '#F6E6C8' };

class AutumnScene extends Scene {
  init() {
    this.leaves = Array.from({ length: 30 }, () => this.leaf(true));
    this.streakPh = 0;
  }
  leaf(anywhere) {
    return {
      x: anywhere ? Math.random() : rand(-0.15, -0.02),
      y: anywhere ? Math.random() : rand(-0.1, 0.8),
      rot: rand(0, TAU), spin: rand(-1.5, 1.5), size: rand(0.02, 0.05),
      d: rand(0.3, 1.3), ph: rand(0, TAU),
      c: pick([AU.ochre, AU.rust, AU.mustard, AU.olive, AU.ochre, AU.cream]),
    };
  }
  draw(g, S) {
    const { w, h, u } = this;
    g.fillStyle = vgrad(g, h, AU.bg0, AU.bg1);
    g.fillRect(0, 0, w, h);

    let [ox, oy] = this.P(0.3, S);
    g.beginPath();
    g.moveTo(ox, oy);
    g.arc(ox, oy, u * 0.4, 0, Math.PI / 2);
    g.closePath();
    g.fillStyle = rgba(AU.plum, 0.9);
    g.fill();

    [ox, oy] = this.P(0.6, S);
    g.beginPath();
    g.moveTo(ox, h + oy);
    g.arc(ox, h + oy, u * 0.64, -Math.PI / 2, 0);
    g.closePath();
    g.fillStyle = AU.rust;
    g.fill();

    // field stripes in a half-disc
    [ox, oy] = this.P(0.8, S);
    g.save();
    g.beginPath();
    g.arc(w * 0.86 + ox, h + oy, u * 0.46, Math.PI, TAU);
    g.clip();
    g.strokeStyle = rgba(AU.mustard, 0.7);
    g.lineWidth = 2;
    for (let i = 0; i < 14; i++) {
      const y = h - u * 0.46 + i * u * 0.035 + oy;
      g.beginPath();
      g.moveTo(w * 0.86 - u * 0.5 + ox, y);
      g.lineTo(w * 0.86 + u * 0.5 + ox, y);
      g.stroke();
    }
    g.restore();

    // olive arch
    [ox, oy] = this.P(0.5, S);
    g.beginPath();
    g.arc(w * 0.5 + ox, h + oy, u * 0.3, Math.PI, TAU);
    g.strokeStyle = AU.olive;
    g.lineWidth = u * 0.045;
    g.stroke();

    // harvest moon
    const hero = (this.hero = this.heroPos(S));
    circle(g, hero.x, hero.y, hero.r * (1 + S.level * 0.08), AU.ochre);
    ring(g, hero.x, hero.y, hero.r * 1.2, rgba(AU.cream, 0.35), 1);
    g.save();
    g.translate(hero.x, hero.y);
    g.rotate(S.t * 0.03);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      circle(g, Math.cos(a) * hero.r * 1.2, Math.sin(a) * hero.r * 1.2, 2, rgba(AU.cream, 0.6));
    }
    g.restore();

    // wind streaks
    const gust = S.gust;
    this.streakPh += S.dt * (0.15 + gust * 0.8);
    if (gust > 0.04) {
      g.lineWidth = 1.2;
      for (let i = 0; i < 5; i++) {
        const p = (this.streakPh + i * 0.21) % 1;
        const y = h * (0.15 + i * 0.16);
        const x0 = (p * 1.6 - 0.4) * w;
        g.beginPath();
        g.moveTo(x0, y);
        g.bezierCurveTo(x0 + w * 0.15, y - u * 0.05, x0 + w * 0.25, y + u * 0.05, x0 + w * 0.4, y - u * 0.01);
        g.strokeStyle = rgba(AU.cream, gust * 0.28 * Math.sin(p * Math.PI));
        g.stroke();
      }
    }

    // leaves
    const swirl = S.level;
    for (const L of this.leaves) {
      L.x += S.dt * (0.01 + gust * 0.35) * (0.5 + L.d) + Math.sin(S.t * 1.7 + L.ph) * 0.0005;
      L.y += S.dt * (0.035 + 0.025 * Math.sin(S.t + L.ph) - swirl * 0.06) * (0.5 + L.d);
      L.rot += S.dt * L.spin * (1 + gust * 4 + swirl * 3);
      if (L.x > 1.12 || L.y > 1.1 || L.y < -0.2) Object.assign(L, this.leaf(false));
      [ox, oy] = this.P(L.d, S);
      const x = L.x * w + ox, y = L.y * h + oy, len = L.size * u * (0.8 + L.d * 0.4);
      g.save();
      g.translate(x, y);
      g.rotate(L.rot);
      g.beginPath();
      g.moveTo(-len, 0);
      g.quadraticCurveTo(0, -len * 0.75, len, 0);
      g.quadraticCurveTo(0, len * 0.75, -len, 0);
      g.fillStyle = rgba(L.c, 0.6 + L.d * 0.3);
      g.fill();
      g.beginPath();
      g.moveTo(-len, 0);
      g.lineTo(len * 0.9, 0);
      g.strokeStyle = rgba(AU.bg0, 0.35);
      g.lineWidth = 0.8;
      g.stroke();
      g.restore();
    }
    this.heroState(g, hero, S, AU.cream);
  }
}

// ---------------------------------------------------------------- Winter

const WI = { bg0: '#0F1520', bg1: '#24344D', ice: '#A9C7DD', silver: '#DCE3EC', slate: '#3D4E66', slate2: '#5B6E86', violet: '#8E8BB5' };

class WinterScene extends Scene {
  init() {
    this.snow = Array.from({ length: 160 }, () => ({ x: Math.random(), y: Math.random(), d: rand(0.2, 1.4), s: rand(0.5, 1), ph: rand(0, TAU) }));
    this.rings = [];
  }
  draw(g, S) {
    const { w, h, u } = this;
    g.fillStyle = vgrad(g, h, WI.bg0, WI.bg1);
    g.fillRect(0, 0, w, h);

    // ghost snowflake
    let [ox, oy] = this.P(0.2, S);
    g.save();
    g.translate(w * 0.26 + ox, h * 0.44 + oy);
    g.rotate(S.t * 0.012 + (S.voiced ? (S.pitch % 12) * 0.02 : 0));
    const R = u * (0.5 + S.level * 0.08);
    g.strokeStyle = rgba(WI.ice, 0.07 + S.level * 0.15);
    g.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      g.rotate(TAU / 6);
      g.beginPath();
      g.moveTo(0, 0); g.lineTo(R, 0);
      for (const k of [0.35, 0.6, 0.82]) {
        g.moveTo(R * k, 0); g.lineTo(R * k + R * 0.14, R * 0.14);
        g.moveTo(R * k, 0); g.lineTo(R * k + R * 0.14, -R * 0.14);
      }
      g.stroke();
    }
    g.restore();

    [ox, oy] = this.P(0.3, S);
    circle(g, w * 0.14 + ox, h * 0.2 + oy, u * 0.035, rgba(WI.violet, 0.8));

    // moon with crescent shadow and a dial of ticks
    const hero = (this.hero = this.heroPos(S));
    circle(g, hero.x, hero.y, hero.r, WI.silver);
    const cres = 0.32 + Math.sin(S.t * 0.05) * 0.06;
    circle(g, hero.x + hero.r * cres, hero.y - hero.r * 0.12, hero.r * 0.9, mix(WI.bg0, WI.bg1, (hero.y / h) * 0.9));
    g.save();
    g.translate(hero.x, hero.y);
    g.rotate(S.t * 0.01);
    g.strokeStyle = rgba(WI.ice, 0.3);
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * TAU, r0 = hero.r * 1.22, r1 = r0 + (i % 5 ? 3 : 8);
      g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    }
    g.stroke();
    g.restore();

    // mountains
    const layers = [[WI.slate, 0.4, [[0, 0.78], [0.3, 0.6], [0.55, 0.74], [0.8, 0.58], [1, 0.7]]],
      [WI.slate2, 0.7, [[0, 0.86], [0.2, 0.74], [0.45, 0.88], [0.7, 0.76], [1, 0.9]]],
      [WI.ice, 1.0, [[0, 0.95], [0.35, 0.86], [0.6, 0.97], [1, 0.92]]]];
    for (const [c, d, pts] of layers) {
      [ox, oy] = this.P(d, S);
      g.beginPath();
      g.moveTo(-20, h);
      for (const [x, y] of pts) g.lineTo(x * w + ox, y * h + oy);
      g.lineTo(w + 20, h);
      g.closePath();
      g.fillStyle = rgba(c, d === 1 ? 0.85 : 1);
      g.fill();
    }

    for (const ev of S.events) {
      if (ev.type === 'glass') this.rings.push({ x: 0.5 + ev.pan * 0.4, y: 0.22 + (1 - ev.n) * 0.3, born: S.t });
    }
    this.rings = this.rings.filter((r) => S.t - r.born < 4);
    for (const r of this.rings) {
      const p = (S.t - r.born) / 4;
      [ox, oy] = this.P(1.2, S);
      hexagon(g, r.x * w + ox, r.y * h + oy, u * (0.02 + p * 0.12), rgba(WI.ice, (1 - p) * 0.6), p * 0.5);
    }

    // snow
    const count = Math.floor(40 + S.motion * 120);
    g.fillStyle = '#FFFFFF';
    for (let i = 0; i < count; i++) {
      const f = this.snow[i];
      f.y += S.dt * f.s * (0.025 + 0.04 * f.d) * (1 + S.level * 0.5);
      f.x += Math.sin(S.t * 0.5 + f.ph) * 0.0003 * f.d + S.level * 0.0015 * Math.sin(f.ph + S.t);
      if (f.y > 1.03) { f.y = -0.03; f.x = Math.random(); }
      if (f.x > 1.03) f.x = -0.03; else if (f.x < -0.03) f.x = 1.03;
      [ox, oy] = this.P(f.d, S);
      g.globalAlpha = 0.35 + 0.45 * Math.min(1, f.d);
      g.beginPath();
      g.arc(f.x * w + ox, f.y * h + oy, 0.6 + f.d * 1.6, 0, TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    this.heroState(g, hero, S, WI.ice);
  }
}

function hexagon(g, x, y, r, stroke, rot) {
  g.beginPath();
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * TAU + rot;
    g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  g.strokeStyle = stroke;
  g.lineWidth = 1;
  g.stroke();
}

const SCENES = { spring: SpringScene, summer: SummerScene, autumn: AutumnScene, winter: WinterScene };
export const ACCENT = { spring: SP.rose, summer: SU.cream, autumn: AU.cream, winter: WI.ice };

// ---------------------------------------------------------------- Visuals

export class Visuals {
  constructor(canvas, engine, { onHero } = {}) {
    this.cv = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
    this.off = document.createElement('canvas');
    this.og = this.off.getContext('2d', { alpha: false });
    this.e = engine;
    this.onHero = onHero;
    this.scenes = {};
    this.cur = null;
    this.prev = null;
    this.mixT = 1;
    this.px = 0; this.py = 0; this.tx = 0; this.ty = 0;
    this.level = 0;
    this.ui = { rec: false, recStart: 0, playing: false, xy: null };
    this.t0 = performance.now();
    this.last = this.t0;
    this.grain = makeGrain();
    this.resize();
    addEventListener('resize', () => this.resize());
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  resize() {
    const dpr = (this.dpr = Math.min(2, window.devicePixelRatio || 1));
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    for (const c of [this.cv, this.off]) {
      c.width = Math.round(this.w * dpr);
      c.height = Math.round(this.h * dpr);
    }
    this.cv.style.width = this.w + 'px';
    this.cv.style.height = this.h + 'px';
    Object.values(this.scenes).forEach((s) => s.resize(this.w, this.h));
  }

  setSeason(id) {
    if (!id) { this.prev = this.cur; this.cur = null; return; }
    if (!this.scenes[id]) { this.scenes[id] = new SCENES[id](); this.scenes[id].resize(this.w, this.h); }
    if (this.cur === this.scenes[id]) return;
    this.prev = this.cur;
    this.cur = this.scenes[id];
    this.mixT = this.prev ? 0 : 1;
  }

  tilt(x, y) { this.tx = clamp(x, -1, 1); this.ty = clamp(y, -1, 1); }

  frame(now) {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const t = (now - this.t0) / 1000;
    const g = this.g, w = this.w, h = this.h, dpr = this.dpr;
    if (!this.cur) return;

    const k = Math.min(1, dt * 2.5);
    this.px += (this.tx + Math.sin(t * 0.13) * 0.15 - this.px) * k;
    this.py += (this.ty + Math.cos(t * 0.11) * 0.12 - this.py) * k;

    const e = this.e, st = e.state;
    const out = e.ctx ? e.level() : 0;
    const voiceActive = e.recording || e.live || e.playing;
    const target = clamp(Math.max(out * 2.4, voiceActive ? st.voiceLevel * 7 : 0));
    this.level += (target - this.level) * (target > this.level ? 0.35 : 0.06);

    const due = [];
    if (e.ctx) {
      const at = e.ctx.currentTime;
      e.events = e.events.filter((ev) => { if (ev.t <= at) { due.push(ev); return false; } return true; });
    }

    const S = {
      t, dt, px: this.px, py: this.py, level: this.level,
      heat: st.heat || 0, gust: st.gust || 0, voiced: st.voiced, pitch: st.pitch || 0,
      motion: e.params.motion, events: due,
      rec: e.recording, recT: e.recording ? e.ctx.currentTime - e.recStart : 0, playing: !!e.playing,
    };

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.prev && this.mixT < 1) {
      this.mixT = Math.min(1, this.mixT + dt / 1.8);
      this.prev.draw(g, { ...S, events: [], rec: false, playing: false });
      this.og.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.cur.draw(this.og, S);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = ease(this.mixT);
      g.drawImage(this.off, 0, 0);
      g.globalAlpha = 1;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.mixT >= 1) this.prev = null;
    } else {
      this.cur.draw(g, S);
    }

    // summer heat shimmer
    if (this.cur instanceof SummerScene && S.heat > 0.15 && !this.prev) {
      this.og.setTransform(1, 0, 0, 1, 0, 0);
      this.og.drawImage(this.cv, 0, 0);
      g.setTransform(1, 0, 0, 1, 0, 0);
      const step = Math.round(6 * dpr), H = this.cv.height * 0.75;
      for (let y = 0; y < H; y += step) {
        const off = Math.sin(y * 0.02 / dpr + t * 7) * S.heat * 5 * dpr;
        g.drawImage(this.off, 0, y, this.cv.width, step, off, y, this.cv.width, step);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // XY puck when playing the stage directly
    const xy = this.ui.xy;
    if (xy) {
      const c = ACCENT[Object.keys(this.scenes).find((key) => this.scenes[key] === this.cur)] || '#FFFFFF';
      ring(g, xy.x, xy.y, 26 + this.level * 20, rgba(c, 0.8), 1.5);
      g.strokeStyle = rgba(c, 0.25);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(xy.x, 0); g.lineTo(xy.x, h);
      g.moveTo(0, xy.y); g.lineTo(w, xy.y);
      g.stroke();
    }

    // film grain
    g.save();
    g.globalAlpha = 0.06;
    g.translate(-Math.random() * 128, -Math.random() * 128);
    g.fillStyle = this.grain(g);
    g.fillRect(0, 0, w + 128, h + 128);
    g.restore();

    if (this.onHero && this.cur.hero) this.onHero(this.cur.hero);
  }
}

function makeGrain() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const img = x.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  let pat = null;
  return (g) => pat || (pat = g.createPattern(c, 'repeat'));
}
