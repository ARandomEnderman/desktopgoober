/* goober.js — goober's brain + eye renderer.
 *
 * No DOM in here on purpose. Every frame the host (the browser sim now, the ESP32 later) calls
 *     goober.update(dt, input)
 *     goober.render(rgbaBuffer)          // 240×240×4 bytes
 * input (everything optional, everything local — no phone, no internet):
 *   btn      the one button (true while pressed)
 *   imu      accelerometer in g, screen axes (x right, y down, z out of the screen); upright & still = {0,-1,0}
 *   temp     °C                         loud     mic level 0..1
 *   light    camera brightness 0..1     seen     where a person/hand is in the camera view {x,y} in −1..1, or null
 *   gesture  a one-frame event from the camera: 'wave' | 'thumbsup' | 'flick' | 'heart' | 'peace' | 'fist'
 *   battery  0..1                     charging  true while USB is plugged in
 *
 * ── Motion rules (measured from the reference clips, frame by frame)
 *  - Calm and deliberate. Both eyes move together like one head. No bubbly jiggle.
 *  - Blinks are crisp: ~2 frames closing, ~2 closed, ~2 opening (≈0.2 s).
 *  - Big looks usually happen through a blink: the eyes swing while shut, arrive in ~4 frames, then ease the
 *    last bit in slowly with no overshoot — then HOLD.
 *  - Everything is a critically damped spring (no keyframes), so any interruption blends.
 *  - The eyes sit on a ball: looking sideways turns it (far eye narrows, near eye overlaps). Shaking it hard
 *    makes the eyes tumble round the ball (roll over the top / spin round the side).
 *
 * ── The library
 *  FACES  expressions (targets for the springs)   ACTS  little animations (~90)   MOODS  10, each lasting 1–3 hours
 */
(function (root) {
  'use strict';

  const SW = 240, SH = 240, MID = 120;
  const FLOAT_T = 2.85, FLOAT_A = 6.1; // the constant up-and-down float (seconds per bob, px at 240)
  const PUPIL_DEPTH = 11; // px behind the card the pupils sit (parallax)
  const R0 = 44, SPACING = 51.7, N = 32, PA = 1.12; // measured from hi-res reference shots at 240 px: eye ≈ 93.5×105.5, centres ±51.7, round pupil ≈ 47
  const A0 = 0.6, RF = SPACING / Math.sin(A0), RFV = 128;
  const PAL = { eye: [184, 207, 252], pupil: [22, 66, 160], pupilR: null, shine: [255, 255, 255], accent: [184, 207, 252] };
  const hx = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  // ── looks: an eye type (pupil family) × a colourway. goober's own set.
  //  round  big round pupil        slit  thin upright pupil that tilts/narrows with the head
  //  bean   huge tall pupil running off the bottom of the eye             dot   tiny pupil hugging the nose side
  const TYPES = {
    round: { wx: 1, wy: 1, pv: 0, pin: 0 },
    slit: { wx: 0.39, wy: 1.51, pv: -0.05, pin: 0 },   // measured: ≈18×71 px, ~16 px toward the nose like round
    bean: { wx: 0.98, wy: 1.72, pv: 0.16, pin: -0.15 },
    dot: { wx: 0.22, wy: 0.23, pv: 0, pin: 0.25 },
  };
  // [eye, pupil, (right pupil for odd-eyed looks)]
  // rarity: chance (%) of each eye type and each colourway when a goober is made; a look's odds = type × colourway
  const TYPE_CHANCE = { round: 45, slit: 25, bean: 20, dot: 10 };
  const SWATCH_CHANCE = { // raw weights; normalised to 100 % below
    goober: 1.33, frost: 0.97, sky: 0.97, mint: 0.88, lagoon: 0.88, lime: 0.79, lemonade: 0.79, peach: 0.79, rose: 0.79, tangerine: 0.7, candy: 0.7, grape: 0.7, scarlet: 0.61, cinder: 0.61, moss: 0.52, ink: 0.52, mulberry: 0.43, sand: 0.39, slate: 0.34, cocoa: 0.29, nightlight: 0.7, crocus: 0.51, rosebush: 0.75, parakeet: 0.6, glowworm: 0.6, spearmint: 0.62, guava: 0.66, blacklight: 0.62, taffy: 0.53, lilac: 0.74, jelly: 0.62, popsicle: 0.6, dragonfruit: 0.61, hibiscus: 0.8, jam: 0.67, motel: 0.82, buoy: 0.73, slushie: 0.6, siren: 0.7, ember: 0.6, flowerpot: 0.66, juicebox: 0.61, mallard: 0.89, postcard: 0.77, chamomile: 0.87, peacock: 0.9, candle: 0.6, calculator: 0.57, doorbell: 0.51, moth: 0.51, strawberry: 0.81, flamingo: 0.59, static: 0.4, eraser: 0.54, pinball: 0.45, kite: 0.86, puddle: 0.52, popcorn: 0.45, spumoni: 0.45, neapolitan: 0.4, lilypad: 0.45, umbrella: 0.45, sherbet: 0.45, marmalade: 1.9, matcha: 0.84, houseplant: 0.53, terrarium: 0.7, whale: 0.55, frog: 0.51, denim: 0.89, petunia: 0.66, lipgloss: 0.54, jawbreaker: 0.52, cherry: 0.78, pebble: 0.74, valentine: 0.8, plum: 0.89, gumball: 1.5, sprinkler: 0.54, pool: 0.77, moon: 0.69, bubblegum: 0.6, seaglass: 0.78, laser: 1.7, eggplant: 0.76, lobster: 0.6, beachball: 0.5, candycane: 0.83, ladybug: 0.69, avocado: 1.3, submarine: 0.67, og: 0.88, pumpkin: 0.74, tomato: 0.87, koi: 0.77, stoplight: 0.45, glowstick: 0.6, marble: 0.45, kiwi: 0.75, sandbox: 0.55 };
  const SWATCHES = {
    goober: ['#b8cffc', '#1642a0'], frost: ['#e8f4ff', '#3f7fd8'], lagoon: ['#18b8c8', '#0a3e66'], lime: ['#9ee05a', '#2d5a12'],
    lemonade: ['#f6f04a', '#2a64e0'], tangerine: ['#ff8a2a', '#1fd6e8'], candy: ['#ff7ac8', '#1aa88a'], grape: ['#8a5af0', '#f4c040'],
    scarlet: ['#e8243a', '#ffe9d6'], cocoa: ['#7a4a38', '#ffb0d8', '#b8b0ff'], slate: ['#8a90a0', '#121318', '#f4f4f8'], moss: ['#4a7a3a', '#e8f080'],
    rose: ['#ffc2d4', '#b0204a'], cinder: ['#c8501a', '#ffd25a'], ink: ['#2a2f80', '#9ad8ff'], peach: ['#ffc9a2', '#7a2a12'],
    mint: ['#a6f0cf', '#0b5e46'], mulberry: ['#6a1e5a', '#ff9ae8'], sky: ['#7ec8ff', '#0a2a5a'], sand: ['#e8d6a8', '#5a4020', '#2a6a8a'],
    // the 80 colourways from the creature.company swatch study (swatches.csv): eye, pupil (, right pupil when odd-eyed)
    nightlight: ['#746cfc', '#54fc84'], crocus: ['#d404ec', '#fcfc24'], rosebush: ['#1c6c34', '#fc7cc4'],
    parakeet: ['#048434', '#24fcfc'], glowworm: ['#f40cfc', '#1cf414'], spearmint: ['#9cfccc', '#7c0474'],
    guava: ['#84fc8c', '#f44c84'], blacklight: ['#6c24f4', '#a4f414'], taffy: ['#f474dc', '#ecfca4'],
    lilac: ['#7404fc', '#fcb4cc'], jelly: ['#b40484', '#449cfc'], popsicle: ['#74fcac', '#549cfc'],
    dragonfruit: ['#b40454', '#ccfc0c'], hibiscus: ['#b4043c', '#04e404'], jam: ['#c4043c', '#0ccc94'],
    motel: ['#fc4c6c', '#94fcbc'], buoy: ['#14acd4', '#ecfc24'], slushie: ['#c404ac', '#4cf4dc'],
    siren: ['#fc0c0c', '#2c04e4'], ember: ['#9c4404', '#04ecfc'], flowerpot: ['#cc6464', '#3c4404'],
    juicebox: ['#f4846c', '#94049c'], mallard: ['#7c8404', '#0434a4'], postcard: ['#bc6c6c', '#74dcec'],
    chamomile: ['#549454', '#f4c424'], peacock: ['#04b4b4', '#7c24fc'], candle: ['#943c4c', '#f4fcbc'],
    calculator: ['#747474', '#0ce454'], doorbell: ['#bcbcbc', '#e42c04'], moth: ['#ec74f4', '#544c04'],
    strawberry: ['#fcb4f4', '#049c1c'], flamingo: ['#fcb4c4', '#048c9c'], static: ['#646464', '#000000', '#fcfcfc'],
    eraser: ['#646464', '#fcecec'], pinball: ['#b40404', '#d4fcfc', '#64d404'], kite: ['#7cb4f4', '#c40484'],
    puddle: ['#a4acf4', '#847404'], popcorn: ['#ecf46c', '#bc240c', '#0c64e4'],
    spumoni: ['#f4ecbc', '#147c3c', '#2424dc'], neapolitan: ['#8c4a3c', '#e86ad8', '#b0a8f0'],
    lilypad: ['#d4f43c', '#14842c', '#0c94f4'], umbrella: ['#e4e4ec', '#f45c2c', '#4c6cfc'],
    sherbet: ['#e4f4e4', '#4c0c9c', '#dc8404'], marmalade: ['#fc9c04', '#6c6424'], matcha: ['#c4fca4', '#5c6c04'],
    houseplant: ['#049444', '#74fc6c'], terrarium: ['#6cf4d4', '#146c54'], whale: ['#045ca4', '#0494fc'],
    frog: ['#44dc84', '#446c14'], denim: ['#6c94fc', '#142c6c'], petunia: ['#fcacfc', '#f404b4'],
    lipgloss: ['#a40484', '#fc649c'], jawbreaker: ['#f4749c', '#54041c'], cherry: ['#ac0404', '#fc5454'],
    pebble: ['#645454', '#a4a4a4'], valentine: ['#dc04cc', '#7c1414'], plum: ['#7464e4', '#64245c'],
    gumball: ['#f40c04', '#fcfcfc'], sprinkler: ['#5cbc04', '#fcfcfc'], pool: ['#04acfc', '#fcecec'],
    moon: ['#442cfc', '#ecfcfc'], bubblegum: ['#f444e4', '#fcfcfc'], seaglass: ['#fcfcfc', '#147c64'],
    laser: ['#fcfcfc', '#fc0404'], eggplant: ['#e404ec', '#141018'], lobster: ['#fc5424', '#044c5c'],
    beachball: ['#f4fc24', '#1c9ce4'], candycane: ['#9cfcd4', '#7c0c04'], ladybug: ['#c4140c', '#141018'],
    avocado: ['#8cd47c', '#240404'], submarine: ['#0c7cac', '#141018'], og: ['#fcfcfc', '#141018'],
    pumpkin: ['#ec7404', '#54fc6c'], tomato: ['#64a414', '#b4040c'], koi: ['#fc6c74', '#d4fc14'],
    stoplight: ['#34f4fc', '#048c04', '#fc1424'], glowstick: ['#ecfc04', '#340444'],
    marble: ['#34f4fc', '#fc1424', '#048c04'], kiwi: ['#54fc24', '#9c7414'], sandbox: ['#bc844c', '#f4f474']
  };

  { // the swatches whose odds were read off the site keep them exactly; everything else is scaled to fill the rest of 100 %
    const SITE = ['beachball', 'parakeet', 'gumball', 'glowstick', 'laser', 'marmalade', 'neapolitan', 'ember', 'peacock', 'avocado', 'static', 'slushie', 'candle', 'lobster'];
    const fixed = SITE.reduce((x, k) => x + SWATCH_CHANCE[k], 0), rest = Object.keys(SWATCH_CHANCE).filter((k) => !SITE.includes(k));
    const tot = rest.reduce((x, k) => x + SWATCH_CHANCE[k], 0); for (const k of rest) SWATCH_CHANCE[k] = (SWATCH_CHANCE[k] * (100 - fixed)) / tot;
  }

  const TAU = Math.PI * 2;
  let SHADE = 'none'; // 'none' = two flat colours (like the reference) · 'flat' = soft top→bottom gradient · 'bowl' = reverse gradient
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };

  let seed = (Date.now() ^ 0x9e3779b9) >>> 0 || 1;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const rr = (a, b) => a + (b - a) * rnd();
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const sgn = () => (rnd() < 0.5 ? -1 : 1);
  const hash = (i) => { let n = (i * 374761393) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
  const noise = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash(i), hash(i + 1), u) * 2 - 1; };

  class Spring {
    constructor(v, f, z) { this.x = v; this.v = 0; this.t = v; this.f = f; this.z = z; this.f0 = f; this.z0 = z; }
    step(dt, force) {
      const w = TAU * this.f;
      this.v += (w * w * (this.t - this.x) - 2 * this.z * w * this.v + (force || 0)) * dt;
      this.x += this.v * dt;
    }
  }

  // ───────────────────────────── shapes (signed distance, y down) ─────────────────────────────
  function sdHeart(x, y, w, h) {
    const sx = w / 0.6, sy = (2 * h) / 1.1, px = Math.abs(x) / sx, py = (h - y) / sy;
    let d;
    if (py + px > 1) d = Math.hypot(px - 0.25, py - 0.75) - Math.SQRT2 / 4;
    else { const m = 0.5 * Math.max(px + py, 0); d = Math.sqrt(Math.min(px * px + (py - 1) * (py - 1), (px - m) * (px - m) + (py - m) * (py - m))) * Math.sign(px - py); }
    return d * ((2 * sx * sy) / (sx + sy));
  }
  function sdStar5(x, y, r, rf) {
    const k1x = 0.809016994375, k1y = -0.587785252292, k2x = -k1x, k2y = k1y;
    x = Math.abs(x);
    let d = Math.max(k1x * x + k1y * y, 0); x -= 2 * d * k1x; y -= 2 * d * k1y;
    d = Math.max(k2x * x + k2y * y, 0); x -= 2 * d * k2x; y -= 2 * d * k2y;
    x = Math.abs(x); y -= r;
    const bax = rf * -k1y, bay = rf * k1x - 1, hh = clamp((x * bax + y * bay) / (bax * bax + bay * bay), 0, r);
    return Math.hypot(x - bax * hh, y - bay * hh) * Math.sign(y * bax - x * bay);
  }
  function sdSeg(px, py, ax, ay, bx, by) {
    const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay, h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
    return Math.hypot(pax - bax * h, pay - bay * h);
  }
  function sdCap(px, py, ax, ay, r1, bx, by, r2) {
    let dx = bx - ax, dy = by - ay; const L = Math.hypot(dx, dy); dx /= L; dy /= L;
    const lx = px - ax, ly = py - ay, x = Math.abs(lx * dy - ly * dx), y = lx * dx + ly * dy;
    const b = (r1 - r2) / L, a = Math.sqrt(1 - b * b), k = -b * x + a * y;
    if (k < 0) return Math.hypot(x, y) - r1;
    if (k > a * L) return Math.hypot(x, y - L) - r2;
    return x * a + y * b - r1;
  }
  // exact distance to a quadratic Bézier A→(control B)→C (a parabola segment) — smooth, no polyline corners
  function sdBezier(px, py, ax, ay, bx, by, cx, cy) {
    const Ax = bx - ax, Ay = by - ay, Bx = ax - 2 * bx + cx, By = ay - 2 * by + cy;
    const bb = Bx * Bx + By * By;
    if (bb < 1e-6) return sdSeg(px, py, ax, ay, cx, cy);
    const Cx = Ax * 2, Cy = Ay * 2, Dx = ax - px, Dy = ay - py, kk = 1 / bb;
    const kx = kk * (Ax * Bx + Ay * By), ky = (kk * (2 * (Ax * Ax + Ay * Ay) + (Dx * Bx + Dy * By))) / 3, kz = kk * (Dx * Ax + Dy * Ay);
    const p = ky - kx * kx, p3 = p * p * p, q = kx * (2 * kx * kx - 3 * ky) + kz;
    let h = q * q + 4 * p3, res;
    const d2 = (t) => { const ex = Dx + (Cx + Bx * t) * t, ey = Dy + (Cy + By * t) * t; return ex * ex + ey * ey; };
    if (h >= 0) {
      h = Math.sqrt(h);
      const u = (h - q) / 2, v = (-h - q) / 2;
      const t = clamp(Math.sign(u) * Math.cbrt(Math.abs(u)) + Math.sign(v) * Math.cbrt(Math.abs(v)) - kx, 0, 1);
      res = d2(t);
    } else {
      const z = Math.sqrt(-p), w = Math.acos(clamp(q / (p * z * 2), -1, 1)) / 3, m = Math.cos(w), n = Math.sin(w) * 1.732050808;
      res = Math.min(d2(clamp((m + m) * z - kx, 0, 1)), d2(clamp((-n - m) * z - kx, 0, 1)));
    }
    return Math.sqrt(res);
  }
  function sdRhombus(x, y, bx, by) {
    x = Math.abs(x); y = Math.abs(y);
    const h = clamp(((bx - 2 * x) * bx - (by - 2 * y) * by) / (bx * bx + by * by), -1, 1);
    return Math.hypot(x - 0.5 * bx * (1 - h), y - 0.5 * by * (1 + h)) * Math.sign(x * by + y * bx - bx * by);
  }

  // ───────────────────────────── FACES ─────────────────────────────
  //  sx, sy  squash/stretch        bend  + arch ⌒ / − sag ‿        tilt  + inner corners down     rot  extra rotation
  //  x, y    offset (x + inward)   bot   flatten the bottom         curve push the bottom up        sharp corner sharpness
  //  lid     ONE curve over both eyes [height at middle, end drop at ±100px (+ ∩ sad, − ‿ angry), skew]
  //  pr      pupil size            pu,pv pupil offset   pin  pupils pulled inward    heart, star  pupil shape morphs
  //  shine   soft highlight        glow  halo    fill  liquid level (battery)   look fixed gaze   blink false = none
  const DEF = { sx: 1.08, sy: 1.2, bend: 0, tilt: 0, rot: 0, x: 0, y: 0, bot: 0, curve: 0, sharp: 0.3,
    pr: 0.45, pu: 0, pv: 0.085, pin: 0.32, heart: 0, star: 0, shine: 0.35, glow: 0.12, fill: 1, shut: 0, arc: 1 };
  const HAPPY = { shut: 1, arc: -1, y: 0, shine: 0, blink: false }; // eyes closed into ^ ^
  const FACES = {
    neutral: {},
    drowsy: { sx: 1.04, sy: 1.02, y: 5, pv: 0.15, pr: 0.47, fx: ['slowblink'] },
    halfLid: { shut: 0.22, sx: 1.05, sy: 1.08, y: 3, pv: 0.12 },
    happy: Object.assign({}, HAPPY, { look: [0, -0.1] }),
    beam: Object.assign({}, HAPPY, { look: [0, -0.1], fx: ['bounce'] }),
    giggle: Object.assign({}, HAPPY, { look: [0, -0.1], fx: ['giggle'] }),
    joy: { sx: 1.16, sy: 1.13, bot: 0.05, bend: 0.1, y: -4, pr: 0.52, shine: 0.5 },
    content: { sx: 1.05, sy: 1.09, bot: 0.05, bend: 0.04, pr: 0.48, y: 2 },
    softSmile: { sx: 1.1, sy: 1.17, bot: 0.04, bend: 0.04, pr: 0.5 },
    groove: { sx: 1.12, sy: 1.1, bot: 0.06, fx: ['sway'] },
    love: { heart: 1, pr: 0.62, pv: 0.02, shine: 0.55, glow: 0.3, bot: 0.25, y: -2, look: [0, 0], fx: ['pulse', 'hearts'] },
    adore: { sx: 1.14, sy: 1.21, pr: 0.66, pv: 0.12, shine: 0.85, glow: 0.24, bot: 0.03, look: [0, 0], blink: false },
    sparkly: { sx: 1.14, sy: 1.12, pr: 0.6, shine: 1, glow: 0.26, fx: ['sparkle'] },
    wonder: { sx: 1.14, sy: 1.19, pr: 0.58, shine: 0.9, look: [0.2, -0.55] },
    starstruck: { star: 1, pr: 0.66, shine: 0.4, glow: 0.36, sx: 1.14, sy: 1.19, look: [0, 0], blink: false, fx: ['twirl', 'sparkle'] },
    excited: { sx: 1.14, sy: 1.17, pr: 0.58, shine: 0.6, glow: 0.2, y: -3, fx: ['bounce'] },
    surprised: { sx: 1.14, sy: 1.23, pr: 0.3, y: -5, shine: 0.5 },
    shocked: { sx: 1.14, sy: 1.36, pr: 0.17, y: -6, shine: 0.25, look: [0, 0], blink: false },
    wheee: { sx: 1.14, sy: 1.3, pr: 0.32, pv: -0.4, y: -7, look: [0, -0.7], fx: ['tremble'] },
    scared: { sx: 1.13, sy: 1.28, pr: 0.27, y: -2, look: [0, 0], fx: ['tremble', 'sweat'] },
    worried: { sx: 1.0, sy: 1.08, y: 3, lid: [-44, 26, 0], pr: 0.38, look: [0, 0.1] },
    nervous: { sx: 0.98, sy: 1.06, y: 2, lid: [-44, 26, 0], pr: 0.32, fx: ['shiver', 'sweat'] },
    sad: { tilt: -0.06, sx: 0.97, sy: 0.98, y: 8, bend: -0.08, pr: 0.52, pv: 0.3, look: [0, 0.4] },
    teary: { tilt: -0.06, sx: 1.04, sy: 1.08, y: 5, bend: -0.08, pr: 0.6, pv: 0.25, shine: 1, glow: 0.18, look: [0, 0.3], fx: ['tears'] },
    gloomy: { sx: 0.94, sy: 0.96, y: 10, pr: 0.46, pv: 0.45, shine: 0.1, glow: 0.04, look: [0, 0.6], fx: ['slowblink'] },
    angry: { tilt: 0.1, sx: 1.0, sy: 1.04, lid: [-28, -40, 0], bot: 0.03, pr: 0.36, pv: 0.1, look: [0, 0.1] },
    furious: { tilt: 0.14, sx: 1.03, sy: 1.1, lid: [-26, -48, 0], bot: 0.04, pr: 0.28, pv: 0.08, glow: 0.5, shine: 0.1, look: [0, 0], blink: false, fx: ['shake'] },
    grumpy: { sx: 1.0, sy: 1.0, y: 3, bot: 0.05, pr: 0.42, pv: 0.25, look: [0, 0.15] },
    annoyed: { sx: 1.02, sy: 1.02, bot: 0.05, pr: 0.4, pv: -0.4, look: [0.2, -0.5] },
    unimpressed: { sx: 1.02, sy: 0.98, bot: 0.06, pr: 0.42, look: [0.55, 0.05] },
    determined: { sx: 1.0, sy: 1.06, lid: [-32, -26, 0], bot: 0.05, pr: 0.42, shine: 0.5, look: [0, 0] },
    focused: { sx: 0.96, sy: 0.98, bot: 0.06, pr: 0.3, look: [0, 0], fx: ['stare'] },
    sleepy: { sx: 1.0, sy: 0.92, y: 8, bot: 0.04, pv: 0.3, pr: 0.48, fx: ['slowblink'] },
    asleep: { shut: 1, y: 4, shine: 0, glow: 0.04, blink: false, look: [0, 0], fx: ['deepbreath', 'zzz'] },
    dreaming: { shut: 0.97, y: 3, shine: 0, glow: 0.1, blink: false, look: [0, 0], fx: ['deepbreath'] },
    waking: { shut: 0.25, sx: 1.0, sy: 1.02, y: 4, pr: 0.46, pv: 0.3, look: [0, 0.1], blink: false },
    peek: { shut: 0.55, sx: 1.0, sy: 1.08, pv: 0.25, look: [0, 0.1] },
    squint: { sy: 0.4, sx: 1.14, bend: 0.3, pr: 0.5, blink: false },
    blinded: { sy: 0.3, sx: 1.14, bend: 0.2, pr: 0.4, blink: false, look: [0, 0.3] },
    yawn: { sy: 1.38, sx: 1.1, pr: 0.36, pv: -0.35, y: -4, blink: false, look: [0, -0.4] },
    wince: { sy: 0.26, sx: 1.14, bend: 0.45, tilt: 0.35, y: -2, blink: false, look: [0, 0], fx: ['tremble'] },
    dizzy: { pr: 0.4, blink: false, fx: ['orbit', 'roll'] },
    bored: { sx: 1.0, sy: 1.0, y: 3, bot: 0.06, look: [0.65, 0.2], fx: ['slowblink'] },
    suspicious: { look: [0.6, 0], L: { sy: 0.94, bot: 0.1 }, R: { sy: 1.12, bot: 0.03 } },
    curious: { rotAll: 0.13, look: [-0.45, -0.3], L: { sx: 1.14, sy: 1.19, y: -4, pr: 0.52 }, R: { sx: 1.14, sy: 0.95, y: 5 } },
    thinking: { rotAll: -0.08, look: [0.55, -0.6], pr: 0.44, L: { sy: 1.12 }, R: { sy: 1.0 } },
    listening: { sx: 1.14, sy: 1.1, pr: 0.55, look: [0, 0] },
    wink: { L: Object.assign({}, HAPPY), R: { shine: 0.6 }, look: [0, 0], blink: false },
    winkR: { R: Object.assign({}, HAPPY), L: { shine: 0.6 }, look: [0, 0], blink: false },
    smug: { sx: 1.04, sy: 1.04, bot: 0.08, pr: 0.42, look: [0.5, 0], shine: 0.45 },
    cool: { sx: 1.04, sy: 1.08, bot: 0.05, pr: 0.45, look: [0.3, 0.05], fx: ['slowblink'] },
    shy: { sx: 1.0, sy: 1.06, y: 4, bot: 0.05, pr: 0.5, shine: 0.6, glow: 0.2, look: [-0.45, 0.45] },
    derp: { L: { pu: 0.35, pv: -0.2, pr: 0.4 }, R: { pu: -0.4, pv: 0.25, pr: 0.46 }, look: [0, 0], blink: false },
    crosseyed: { pin: 0.55, pr: 0.42, look: [0, 0], blink: false },
    ghost: { bot: 0.18, sharp: 0.06, tilt: -0.12, sy: 1.14, pin: 0.25, pv: 0.06, pr: 0.44, shine: 0.5, look: [0, 0] },
    glowy: { glow: 0.7, shine: 0.6, pr: 0.52, fx: ['pulse'] },
    dilated: { pr: 0.64, shine: 0.6, look: [0, 0] },
    pinpoint: { pr: 0.22, sx: 1.14, sy: 1.14, look: [0, 0] },
    boggle: { L: { sx: 1.14, sy: 1.28, pr: 0.3 }, R: { sx: 1.09, sy: 0.97, pr: 0.42 }, look: [0, 0] },
    bigL: { L: { sx: 1.14, sy: 1.43, pr: 0.52, y: -3 }, R: { sx: 0.99, sy: 1.1, y: 2 } },
    bigR: { R: { sx: 1.14, sy: 1.43, pr: 0.52, y: -3 }, L: { sx: 0.99, sy: 1.1, y: 2 } },
    // size-only faces: the eyes just grow or shrink (the cutest way to show a feeling)
    puffy: { sx: 1.2, sy: 1.32, pr: 0.56, shine: 0.6, y: -3 },
    tiny: { sx: 0.9, sy: 0.98, pr: 0.42, y: 4, look: [0, 0.15] },
    wide: { sx: 1.22, sy: 1.08, pr: 0.5, bend: 0.06, y: -1 },
    tall: { sx: 1.02, sy: 1.4, pr: 0.46, y: -4 },
    plump: { sx: 1.16, sy: 1.24, pr: 0.6, shine: 0.7, bot: 0.03 },
    meek: { sx: 0.94, sy: 1.02, pr: 0.5, y: 6, shine: 0.5, look: [0, 0.3] },
    smallL: { L: { sx: 0.95, sy: 1.0, y: 2 }, R: { sx: 1.1, sy: 1.24, y: -1 } },
    smallR: { R: { sx: 0.95, sy: 1.0, y: 2 }, L: { sx: 1.1, sy: 1.24, y: -1 } },
    puppy: { sx: 1.12, sy: 1.22, pr: 0.7, pv: 0.1, shine: 0.85, glow: 0.2, look: [0, 0] },   // big soft pupils that nearly fill the eye
    walleyed: { pin: -0.62, pr: 0.42, look: [0, 0] },   // charging: each pupil drifts outward, derpy on purpose
    googly: { L: { pu: -0.32, pv: -0.3, pr: 0.42, sx: 1.04, sy: 1.12 }, R: { pu: 0.36, pv: 0.25, pr: 0.38 }, look: [0, 0], blink: false },
    upside: { tilt: -0.1, lid: [-48, 24, 0], sy: 1.14, pr: 0.36 },
  };

  // ───────────────────────────── ACTS ─────────────────────────────
  // A step: { e: face, d: seconds, look?: [x,y], tilt?: head tilt, zoom?: lean in/out, blink?: true, run?: fn }
  // `f` is the face goober was resting in, so most animations keep its current mood on.
  const S = (e, d, look, extra) => Object.assign({ e, d, look }, extra || {});
  const ACTS = {
    // looking
    glanceLeft: (g, f) => [S(f, rr(1.4, 2.4), [-0.75, rr(-0.2, 0.2)], { blink: rnd() < 0.6, turn: -0.25 }), S(f, 0.8, [0, 0], { blink: rnd() < 0.5, turn: 0 })],
    glanceRight: (g, f) => [S(f, rr(1.4, 2.4), [0.75, rr(-0.2, 0.2)], { blink: rnd() < 0.6, turn: 0.25 }), S(f, 0.8, [0, 0], { blink: rnd() < 0.5, turn: 0 })],
    turnLeft: (g, f) => [S(f, rr(2.2, 3.4), [-0.6, rr(-0.15, 0.1)], { blink: true, turn: -0.5 }), S(f, 1, [0, 0], { blink: true, turn: 0 })],
    turnRight: (g, f) => [S(f, rr(2.2, 3.4), [0.6, rr(-0.15, 0.1)], { blink: true, turn: 0.5 }), S(f, 1, [0, 0], { blink: true, turn: 0 })],
    turnLookBack: (g, f) => { const s = sgn(); return [S(f, 1.6, [s * 0.7, 0], { blink: true, turn: s * 0.55 }), S('listening', 1.6, [-s * 0.3, 0], { turn: -s * 0.15 }), S(f, 0.8, [0, 0], { blink: true, turn: 0 })]; },
    bigEyeLeft: (g, f) => [S('bigL', rr(2, 3.2), [-0.2, 0])],
    bigEyeRight: (g, f) => [S('bigR', rr(2, 3.2), [0.2, 0])],
    lookUp: (g, f) => [S(f, 2, [rr(-0.3, 0.3), -0.7], { blink: true }), S(f, 0.8, [0, 0])],
    lookDown: (g, f) => [S(f, 2, [rr(-0.3, 0.3), 0.7], { blink: true }), S(f, 0.8, [0, 0])],
    lookUpLeft: (g, f) => [S(f, 2.2, [-0.7, -0.6], { blink: true }), S(f, 0.8, [0, 0], { blink: true })],
    lookUpRight: (g, f) => [S(f, 2.2, [0.7, -0.6], { blink: true }), S(f, 0.8, [0, 0], { blink: true })],
    lookDownLeft: (g, f) => [S(f, 2.2, [-0.7, 0.6], { blink: true }), S(f, 0.8, [0, 0], { blink: true })],
    lookDownRight: (g, f) => [S(f, 2.2, [0.7, 0.6], { blink: true }), S(f, 0.8, [0, 0], { blink: true })],
    lookAround: (g, f) => { const s = sgn(); return [S(f, 1.8, [s * 0.8, 0], { blink: true, turn: s * 0.4 }), S(f, 1.8, [-s * 0.8, 0.05], { blink: true, turn: -s * 0.4 }), S(f, 1.2, [0, 0], { blink: true, turn: 0 })]; },
    doubleGlance: (g, f) => { const s = sgn(); return [S(f, 0.9, [s * 0.75, 0]), S(f, 0.6, [0, 0]), S(f, 1.2, [s * 0.8, 0.05]), S(f, 0.8, [0, 0], { blink: true })]; },
    stareAtYou: () => [S('listening', 4.5, [0, 0])],
    followFly: (g, f) => { const st = []; let x = rr(-0.6, 0.6), y = rr(-0.5, 0.2); for (let i = 0; i < 7; i++) { x = clamp(x + rr(-0.45, 0.45), -0.9, 0.9); y = clamp(y + rr(-0.35, 0.35), -0.7, 0.6); st.push(S('curious', rr(0.35, 0.6), [x, y])); } st.push(S(f, 0.8, [0, 0], { blink: true })); return st; },
    watchFall: (g, f) => { const x = rr(-0.5, 0.5); return [S('wonder', 0.9, [x, -0.7]), S('surprised', 0.5, [x, -0.1]), S('surprised', 0.8, [x, 0.75]), S(f, 0.8, [0, 0], { blink: true })]; },
    watchBird: (g, f) => { const s = sgn(); return [S('wonder', 1.0, [s * 0.8, -0.6], { blink: true }), S('wonder', 1.4, [0, -0.7]), S('wonder', 1.2, [-s * 0.8, -0.55]), S(f, 0.8, [0, 0], { blink: true })]; },
    read: (g, f) => { const st = [S('focused', 0.5, [-0.5, -0.15], { blink: true })]; for (const y of [-0.15, 0, 0.15]) { st.push(S('focused', 0.45, [-0.5, y])); st.push(S('focused', 0.45, [0, y])); st.push(S('focused', 0.45, [0.5, y])); } st.push(S(f, 0.8, [0, 0], { blink: true })); return st; },
    scan: (g, f) => [S('focused', 0.9, [-0.85, 0], { blink: true }), S('focused', 2.2, [0.85, 0]), S(f, 0.8, [0, 0], { blink: true })],
    search: (g, f) => [S('curious', 0.7, [-0.7, -0.2]), S('curious', 0.7, [0.6, 0.3]), S('curious', 0.7, [-0.3, 0.5]), S('thinking', 1.4), S(f, 0.6, [0, 0], { blink: true })],
    sideEyeLeft: () => [S('suspicious', 2.6, [-0.65, 0], { blink: true }), S('unimpressed', 1.0, [0, 0])],
    sideEyeRight: () => [S('suspicious', 2.6, [0.65, 0], { blink: true }), S('unimpressed', 1.0, [0, 0])],
    lookAway: () => [S('shy', 2.2, [sgn() * 0.65, 0.4], { blink: true }), S('softSmile', 1.0, [0, 0], { blink: true })],
    // blinks
    slowBlink: (g, f) => [S('content', 1.6, [0, 0], { run: () => g.blink(4) }), S('softSmile', 1.2)],
    halfBlink: (g, f) => [S('halfLid', 0.7), S(f, 0.6)],
    doubleBlink: (g, f) => [S(f, 0.6, null, { run: () => { g.blink(1); g.after(0.24, () => g.blink(1)); } })],
    flutter: (g, f) => [S(f, 0.8, null, { run: () => { g.blink(0.8); g.after(0.2, () => g.blink(0.8)); g.after(0.4, () => g.blink(0.8)); } })],
    wink: () => [S('wink', 1.0), S('softSmile', 0.8)],
    winkRight: () => [S('winkR', 1.0), S('softSmile', 0.8)],
    squeezeBlink: (g, f) => [S('squint', 0.45), S(f, 0.6)],
    longBlink: (g, f) => [S(f, 1.4, null, { run: () => g.blink(7) })],
    // faces that come and go
    softSmile: () => [S('softSmile', 4)],
    bigSmile: () => [S('joy', 2.8)],
    beam: () => [S('beam', 1.8)],
    giggle: () => [S('giggle', 1.6)],
    laugh: (g) => [S('giggle', 1.8, null, { run: () => { g.kick(0, -140); g.after(0.5, () => g.kick(0, -110)); } })],
    proud: () => [S('smug', 2.4, [0.1, -0.1], { tilt: -0.1 })],
    bashful: () => [S('shy', 2.6, [-0.4, 0.55], { blink: true })],
    awe: () => [S('adore', 2.6, [0, 0], { zoom: 1.12 })],
    wonder: () => [S('wonder', 3, null, { blink: true })],
    dilate: () => [S('dilated', 3.2)],
    focus: () => [S('pinpoint', 2.2)],
    skeptical: () => [S('suspicious', 2.8, null, { blink: true })],
    unimpressed: () => [S('unimpressed', 3, null, { blink: true })],
    judging: () => [S('focused', 1.2, [0, 0]), S('unimpressed', 1.6, [0, 0])],
    confused: (g) => [S('curious', 1.2, [-0.5, -0.2], { tilt: 0.14, blink: true }), S('curious', 1.2, [0.5, -0.2], { tilt: -0.14, blink: true }), S('thinking', 1.2)],
    idea: (g) => [S('thinking', 1.8), S('surprised', 0.5, [0, -0.2], { run: () => g.pop(1.5) }), S('sparkly', 1.4, [0, 0])],
    relief: () => [S('squint', 0.6), S('content', 2.2, [0, 0.1])],
    sigh: () => [S('gloomy', 1.6), S('halfLid', 1.0)],
    pout: () => [S('grumpy', 2.6, [sgn() * 0.5, 0.4], { blink: true })],
    sulk: () => [S('gloomy', 3.4, null, { blink: true })],
    sniffle: () => [S('teary', 2.4)],
    cry: () => [S('teary', 4)],
    worry: () => [S('worried', 2.6, null, { blink: true })],
    startle: (g) => [S('shocked', 0.7, [0, 0], { run: () => g.pop(2.5) }), S('worried', 1.0)],
    hiccup: (g, f) => [S(f, 0.5, null, { run: () => { g.kick(0, -110); g.blink(0.7); } }), S(f, 0.8), S(f, 0.5, null, { run: () => { g.kick(0, -110); g.blink(0.7); } })],
    sneeze: (g) => [S('squint', 0.5), S('squint', 0.4), S('wince', 0.35, null, { run: () => { g.pop(-5); g.kick(0, 180); } }), S('surprised', 0.6)],
    yawn: () => [S('squint', 0.5), S('yawn', 1.6), S('squint', 0.5), S('drowsy', 1.6)],
    stretch: () => [S('yawn', 1.4, [0, -0.5]), S('content', 1.4, [0, 0])],
    doze: (g) => [S('drowsy', 1.4), S('sleepy', 1.6), S('asleep', 1.8), S('shocked', 0.5, null, { run: () => g.pop(3) }), S('drowsy', 0.8)],
    daydream: () => [S('wonder', 3.2, [sgn() * 0.5, -0.6], { blink: true }), S('softSmile', 1.0, [0, 0])],
    hearts: () => [S('love', 3)],
    stars: () => [S('starstruck', 2.6)],
    sparkle: () => [S('sparkly', 2.4)],
    glow: () => [S('glowy', 2.8)],
    ghost: () => [S('ghost', 3)],
    derp: () => [S('derp', 1.6)],
    cross: () => [S('crosseyed', 1.4)],
    boggle: () => [S('boggle', 1.8)],
    mischief: () => [S('smug', 1.4, [0.5, 0], { blink: true }), S('wink', 0.9), S('smug', 0.8)],
    scheme: () => [S('determined', 1.4, [0.4, 0.1]), S('smug', 1.6, [0, 0])],
    grumble: () => [S('grumpy', 1.4), S('annoyed', 1.2)],
    eyeRoll: () => [S('annoyed', 0.5, [-0.6, -0.55]), S('annoyed', 0.5, [0.6, -0.6]), S('grumpy', 1.2)],
    glare: () => [S('angry', 2.4, [0, 0])],
    huff: (g) => [S('angry', 1.2, null, { run: () => g.kick(0, 120) }), S('grumpy', 1.4)],
    cool: () => [S('cool', 3.2)],
    // head
    tiltLeft: (g, f) => [S(f, 2.6, null, { tilt: -0.17 })],
    tiltRight: (g, f) => [S(f, 2.6, null, { tilt: 0.17 })],
    nod: (g, f) => [S(f, 1.3, [0, 0], { run: () => { g.kick(0, 110); g.after(0.5, () => g.kick(0, 95)); } })],
    nope: () => [S('grumpy', 0.4, [-0.6, 0]), S('grumpy', 0.4, [0.6, 0]), S('grumpy', 0.4, [-0.6, 0]), S('grumpy', 0.6, [0, 0])],
    leanIn: (g, f) => [S('listening', 2.6, [0, 0], { zoom: 1.14 }), S(f, 0.6, null, { zoom: 1 })],
    leanBack: (g, f) => [S('unimpressed', 2.2, [0, 0], { zoom: 0.88 }), S(f, 0.6, null, { zoom: 1 })],
    groove: () => [S('groove', 4)],
    hop: (g) => [S('joy', 1.4, null, { run: () => { g.kick(0, -150); g.after(0.6, () => g.kick(0, -120)); } })],
    wiggle: (g, f) => [S(f, 1.2, null, { run: () => g.wobble(0.7) })],
    squish: (g, f) => [S(f, 1, null, { run: () => g.pop(-3) })],
    peekaboo: (g) => [S('neutral', 1.2, [0, 0], { run: () => g.hide(1.8) }), S('peek', 0.8), S('peek', 1.4, null, { run: () => g.hide(0.6) }), S('peek', 1, [0, -0.3]), S('joy', 1.2, null, { run: () => g.hide(0) })],
    // reactions (also usable as animations)
    tumble: (g) => [S('shocked', 0.8, [0, 0], { run: () => g.pop(2) }), S('dizzy', 2.4), S('wince', 0.6)],
    dizzy: () => [S('dizzy', 2.4), S('wince', 0.6)],
    greet: (g) => [S('joy', 1.4, [0, 0], { blink: true, run: () => g.kick(0, -130) }), S('softSmile', 1.6, [0, 0])],
    hurt: () => [S('shocked', 0.6, [0, 0]), S('sad', 1.6), S('teary', 2.6)],
    blinded: () => [S('blinded', 1.6), S('squint', 0.6)],
    whereDidYouGo: () => [S('worried', 1.2, [-0.6, 0]), S('worried', 1.2, [0.6, 0]), S('sad', 1.8, [0, 0.3])],
    peekabooFound: (g) => [S('shocked', 0.5, [0, 0], { run: () => g.pop(2) }), S('giggle', 1.6)],
  };

  // ───────────────────────────── generated library ─────────────────────────────
  // Story templates × directions × tempos × faces × moves → hundreds of distinct little animations.
  // META[name] = { fam, face, energy (1 calm … 3 wild) } lets each mood pull its own pool.
  const META = {};
  for (const k in ACTS) META[k] = { fam: 'classic', face: null, energy: 2 };
  // reactions to something that happened: never played at random (only their trigger plays them)
  for (const k of ['tumble', 'dizzy', 'hurt', 'greet', 'blinded', 'whereDidYouGo', 'peekabooFound', 'startle', 'groove']) META[k].fam = 'react';
  // the rest of the hand-made set: tagged with their main face, so a mood only picks the ones that suit it
  // (no crying in a happy mood, no yawning when hyper)
  { const stub = new Proxy({}, { get: () => () => 0 });
    for (const k in ACTS) if (META[k].fam === 'classic') {
      const st = ACTS[k](stub, 'neutral').map((x) => x.e).filter((e) => e && e !== 'neutral');
      META[k].face = st[0] || null;
    } }
  const add = (name, fam, face, energy, fn) => { ACTS[name] = fn; META[name] = { fam, face, energy }; };
  const DIRS = { left: [-0.75, 0], right: [0.75, 0], up: [0, -0.65], down: [0, 0.65], upLeft: [-0.65, -0.55], upRight: [0.65, -0.55], downLeft: [-0.65, 0.55], downRight: [0.65, 0.55] };
  const TEMPO = { slow: 1.5, easy: 1, quick: 0.6 };
  const turnOf = (v) => v[0] * 0.35;
  // 1. glances: 8 directions × 3 tempos
  for (const [dn, v] of Object.entries(DIRS)) for (const [tn, k] of Object.entries(TEMPO))
    add(`glance.${dn}.${tn}`, 'glance', null, tn === 'quick' ? 2 : 1, (g, f) => [S(f, 1.6 * k, v, { blink: k > 0.9, turn: turnOf(v) }), S(f, 0.7 * k, [0, 0], { blink: rnd() < 0.5, turn: 0 })]);
  // 2. head turns: side × size × tempo
  for (const sd of [-1, 1]) for (const [zn, z] of Object.entries({ small: 0.3, big: 0.6 })) for (const [tn, k] of Object.entries(TEMPO))
    add(`turn.${sd < 0 ? 'left' : 'right'}.${zn}.${tn}`, 'turn', null, 1, (g, f) => [S(f, 2.4 * k, [sd * 0.65, rr(-0.1, 0.1)], { blink: true, turn: sd * z }), S(f, 0.9 * k, [0, 0], { blink: true, turn: 0 })]);
  // 3. notice something → react: 8 directions × 10 reactions
  const NOTICE = { surprised: 2, curious: 2, suspicious: 2, softSmile: 1, worried: 2, unimpressed: 1, wonder: 1, shy: 1, grumpy: 2, sparkly: 3 };
  for (const [dn, v] of Object.entries(DIRS)) for (const [face, en] of Object.entries(NOTICE))
    add(`notice.${dn}.${face}`, 'notice', face, en, (g, f) => [S('listening', 0.7, v, { blink: true, turn: turnOf(v) }), S(face, rr(1.6, 2.6), v), S(f, 0.8, [0, 0], { blink: true, turn: 0 })]);
  // 4. watching something move: 9 paths × 3 faces
  const PATHS = {
    fly: () => { const p = []; let x = rr(-0.6, 0.6), y = rr(-0.5, 0.2); for (let i = 0; i < 7; i++) { x = clamp(x + rr(-0.45, 0.45), -0.9, 0.9); y = clamp(y + rr(-0.35, 0.35), -0.7, 0.6); p.push([x, y]); } return p; },
    fall: () => { const x = rr(-0.5, 0.5); return [[x, -0.7], [x, -0.2], [x, 0.3], [x, 0.75]]; },
    rise: () => { const x = rr(-0.5, 0.5); return [[x, 0.7], [x, 0.2], [x, -0.3], [x, -0.7]]; },
    passRight: () => [[-0.85, -0.1], [-0.4, -0.12], [0, -0.1], [0.4, -0.08], [0.85, -0.05]],
    passLeft: () => [[0.85, -0.1], [0.4, -0.12], [0, -0.1], [-0.4, -0.08], [-0.85, -0.05]],
    bounce: () => [[-0.6, 0.5], [-0.3, -0.4], [0, 0.5], [0.3, -0.3], [0.6, 0.5]],
    circle: () => { const p = []; for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; p.push([Math.cos(a) * 0.6, Math.sin(a) * 0.45]); } return p; },
    zigzag: () => [[-0.7, -0.4], [-0.3, 0.3], [0.1, -0.4], [0.5, 0.3], [0.8, -0.3]],
    drift: () => [[-0.5, -0.5], [-0.2, -0.55], [0.2, -0.6], [0.5, -0.55]],
  };
  for (const [pn, path] of Object.entries(PATHS)) for (const [face, en] of Object.entries({ curious: 2, wonder: 1, focused: 2 }))
    add(`watch.${pn}.${face}`, 'watch', face, en, (g, f) => { const st = path().map((v, i) => S(face, pn === 'drift' ? 0.9 : rr(0.35, 0.6), v, { blink: i === 0 })); st.push(S(f, 0.8, [0, 0], { blink: true })); return st; });
  // 5. blink styles
  add('blink.slow', 'blink', 'content', 1, (g) => [S('content', 1.6, [0, 0], { run: () => g.blink(4) }), S('softSmile', 1)]);
  add('blink.half', 'blink', null, 1, (g, f) => [S('halfLid', 0.8), S(f, 0.5)]);
  add('blink.double', 'blink', null, 1, (g, f) => [S(f, 0.7, null, { run: () => { g.blink(1); g.after(0.3, () => g.blink(1)); } })]);
  add('blink.triple', 'blink', null, 2, (g, f) => [S(f, 0.9, null, { run: () => { g.blink(0.8); g.after(0.24, () => g.blink(0.8)); g.after(0.48, () => g.blink(0.8)); } })]);
  add('blink.long', 'blink', null, 1, (g, f) => [S(f, 1.6, null, { run: () => g.blink(8) })]);
  add('blink.squeeze', 'blink', 'squint', 1, (g, f) => [S('squint', 0.5), S(f, 0.6)]);
  add('blink.lazy', 'blink', 'halfLid', 1, (g, f) => [S('halfLid', 2.4), S(f, 0.6, null, { blink: true })]);
  add('blink.heavy', 'blink', 'drowsy', 1, (g, f) => [S('drowsy', 1.4, null, { run: () => g.blink(5) }), S(f, 0.6)]);
  add('blink.wink', 'blink', 'wink', 2, () => [S('wink', 1), S('softSmile', 0.8)]);
  add('blink.winkRight', 'blink', 'winkR', 2, () => [S('winkR', 1), S('softSmile', 0.8)]);
  // 6. settle into a face for a moment (short / long)
  const MOMENT = { softSmile: 1, content: 1, joy: 2, happy: 2, beam: 3, giggle: 3, love: 2, adore: 2, sparkly: 2, wonder: 1, starstruck: 3, excited: 3, surprised: 2, worried: 2, sad: 1, teary: 1, gloomy: 1,
    grumpy: 2, annoyed: 2, unimpressed: 1, determined: 2, focused: 2, drowsy: 1, sleepy: 1, halfLid: 1, smug: 2, cool: 1, shy: 1, suspicious: 2, thinking: 1, curious: 2, listening: 1, dilated: 1, pinpoint: 2, ghost: 2, glowy: 1 };
  for (const [face, en] of Object.entries(MOMENT)) for (const [ln, d] of Object.entries({ short: 1.8, long: 4 }))
    add(`moment.${face}.${ln}`, 'moment', face, en, (g, f) => [S(face, d * rr(0.85, 1.15), null, { blink: rnd() < 0.5 }), S(f, 0.6)]);
  // 7. head tilts with a face
  for (const sd of [-1, 1]) for (const face of ['neutral', 'curious', 'softSmile', 'listening', 'thinking', 'smug'])
    add(`tilt.${sd < 0 ? 'left' : 'right'}.${face}`, 'tilt', face === 'neutral' ? null : face, 1, (g, f) => [S(face === 'neutral' ? f : face, rr(2, 3.2), null, { tilt: sd * rr(0.12, 0.2) }), S(f, 0.8)]);
  // 8. lean in / back
  for (const [ln, z] of Object.entries({ in: 1.14, back: 0.88 })) for (const face of ['listening', 'curious', 'unimpressed', 'smug', 'adore'])
    add(`lean.${ln}.${face}`, 'lean', face, 1, (g, f) => [S(face, 2.4, [0, 0], { zoom: z }), S(f, 0.7, null, { zoom: 1 })]);
  // 9. hops / nods / nopes
  for (const n of [1, 2, 3]) for (const face of ['joy', 'excited', 'beam'])
    add(`hop.${n}.${face}`, 'hop', face, 3, (g) => [S(face, 0.6 + n * 0.5, null, { run: () => { for (let i = 0; i < n; i++) g.after(i * 0.5, () => g.kick(0, -150 + i * 15)); } })]);
  for (const n of [1, 2, 3]) for (const face of ['neutral', 'softSmile', 'determined'])
    add(`nod.${n}.${face}`, 'nod', face === 'neutral' ? null : face, 1, (g, f) => [S(face === 'neutral' ? f : face, 0.6 + n * 0.45, [0, 0], { run: () => { for (let i = 0; i < n; i++) g.after(i * 0.45, () => g.kick(0, 110)); } })]);
  for (const n of [2, 3]) for (const face of ['grumpy', 'annoyed', 'smug'])
    add(`nope.${n}.${face}`, 'nope', face, 2, () => { const st = []; for (let i = 0; i < n * 2; i++) st.push(S(face, 0.36, [i % 2 ? 0.6 : -0.6, 0])); st.push(S(face, 0.6, [0, 0])); return st; });
  // 10. grooves
  for (const [sn, d] of Object.entries({ short: 2.6, long: 5 })) for (const face of ['groove', 'content', 'joy', 'cool'])
    add(`groove.${sn}.${face}`, 'music', face, face === 'joy' ? 3 : 2, (g) => [S(face, d, null, { run: () => g._groove(d) })]);
  // 11. pupils
  for (const [pn, face] of Object.entries({ dilate: 'dilated', shrink: 'pinpoint' })) for (const look of [[0, 0], [-0.4, 0], [0.4, 0], [0, -0.4]])
    add(`pupils.${pn}.${look.join('_')}`, 'pupils', face, 1, (g, f) => [S(face, 2.8, look), S(f, 0.7)]);
  // 12. one eye bigger / boggle
  for (const sd of ['L', 'R']) for (const [tn, k] of Object.entries(TEMPO))
    add(`bigEye.${sd}.${tn}`, 'bigEye', 'big' + sd, 1, (g, f) => [S('big' + sd, 2.4 * k, [sd === 'L' ? -0.2 : 0.2, 0]), S(f, 0.7 * k)]);
  // 13. stories
  for (const [dn, v] of Object.entries(DIRS)) {
    add(`doubleTake.${dn}`, 'story', 'shocked', 2, (g, f) => [S(f, 0.9, v, { turn: turnOf(v) }), S(f, 0.25, [0, 0], { turn: 0 }), S('shocked', 0.7, v, { turn: turnOf(v), run: () => g.pop(1.5) }), S(f, 0.8, [0, 0], { blink: true, turn: 0 })]);
    add(`squintAt.${dn}`, 'story', 'focused', 2, (g, f) => [S('focused', 2.2, v, { blink: true, turn: turnOf(v) }), S(f, 0.7, [0, 0], { turn: 0 })]);
    for (const face of ['softSmile', 'surprised', 'shy'])
      add(`lookBack.${dn}.${face}`, 'story', face, 2, (g, f) => [S(f, 1.6, v, { blink: true, turn: turnOf(v) }), S(face, 1.6, [0, 0], { blink: true, turn: 0 })]);
  }
  for (const dn of ['upLeft', 'upRight', 'left', 'right']) for (const [rn, steps] of Object.entries({
    idea: (g) => [S('surprised', 0.5, [0, -0.2], { run: () => g.pop(1.4) }), S('sparkly', 1.4, [0, 0])],
    shrug: () => [S('unimpressed', 1.4, [0, 0])],
    happy: () => [S('happy', 1.4)],
  })) add(`think.${dn}.${rn}`, 'story', 'thinking', 1, (g) => [S('thinking', 2, DIRS[dn], { blink: true, turn: turnOf(DIRS[dn]) }), ...steps(g).map((x, i) => (i === 0 ? Object.assign(x, { turn: 0 }) : x))]);
  for (const dn of ['upLeft', 'upRight', 'up', 'left']) add(`daydream.${dn}`, 'story', 'wonder', 1, (g, f) => [S('wonder', 3.2, DIRS[dn], { blink: true, turn: turnOf(DIRS[dn]) }), S('softSmile', 1, [0, 0], { turn: 0 })]);
  for (const face of ['gloomy', 'halfLid', 'sad', 'grumpy']) add(`sigh.${face}`, 'story', face, 1, (g, f) => [S(face, 1.8, [0, 0.4]), S('halfLid', 1), S(f, 0.6)]);
  for (const [sn, k] of Object.entries({ small: 0.7, big: 1, huge: 1.4 })) {
    add(`yawn.${sn}`, 'story', 'yawn', 1, () => [S('squint', 0.5), S('yawn', 1.4 * k), S('squint', 0.4), S('drowsy', 1.4)]);
    add(`sneeze.${sn}`, 'story', 'wince', 2, (g) => [S('squint', 0.5 * k), S('squint', 0.4 * k), S('wince', 0.35, null, { run: () => { g.pop(-4 * k); g.kick(0, 160 * k); } }), S('surprised', 0.6)]);
    add(`giggle.${sn}`, 'story', 'giggle', 3, (g) => [S('giggle', 1.2 * k + 0.4, null, { run: () => g.kick(0, -90 * k) })]);
    add(`stretch.${sn}`, 'story', 'yawn', 1, () => [S('yawn', 1.2 * k, [0, -0.5]), S('content', 1.2, [0, 0])]);
  }
  for (const [en, end] of Object.entries({ startle: 'shocked', drift: 'asleep', smile: 'softSmile' }))
    add(`doze.${en}`, 'story', 'sleepy', 1, (g, f) => [S('drowsy', 1.4), S('sleepy', 1.6), S('asleep', 1.8), S(end, en === 'drift' ? 2.4 : 0.8, null, { run: () => en === 'startle' && g.pop(2.5) }), S('drowsy', 0.8)]);
  for (const n of [1, 2, 3]) add(`hiccup.${n}`, 'story', null, 2, (g, f) => { const st = []; for (let i = 0; i < n; i++) { st.push(S(f, 0.5, null, { run: () => { g.kick(0, -110); g.blink(0.7); } })); st.push(S(f, 0.7)); } return st; });
  for (const [ln, d] of Object.entries({ short: 1.8, long: 3.4 })) for (const face of ['love', 'starstruck', 'sparkly', 'glowy'])
    add(`${face}.${ln}`, 'special', face, face === 'starstruck' ? 3 : 2, () => [S(face, d)]);
  for (const dir of ['down', 'up']) add(`peekaboo.${dir}`, 'story', 'peek', 2, (g) => [S('neutral', 1.2, [0, 0], { run: () => g.hide(dir === 'down' ? 1.8 : -1.8) }), S('peek', 0.9), S('peek', 1.2, null, { run: () => g.hide(dir === 'down' ? 0.6 : -0.6) }), S('peek', 1), S('joy', 1.2, null, { run: () => g.hide(0) })]);
  for (const [dn, sd] of Object.entries({ leftToRight: 1, rightToLeft: -1 })) for (const [tn, k] of Object.entries({ slow: 1.4, easy: 1 }))
    add(`scan.${dn}.${tn}`, 'story', 'focused', 1, (g, f) => [S('focused', 0.9, [-sd * 0.85, 0], { blink: true }), S('focused', 2.2 * k, [sd * 0.85, 0]), S(f, 0.8, [0, 0], { blink: true })]);
  for (const n of [2, 3, 4]) add(`read.${n}lines`, 'story', 'focused', 1, (g, f) => { const st = [S('focused', 0.5, [-0.5, -0.15], { blink: true })]; for (let l = 0; l < n; l++) { const y = -0.15 + l * 0.12; st.push(S('focused', 0.45, [-0.5, y]), S('focused', 0.45, [0, y]), S('focused', 0.45, [0.5, y])); } st.push(S(f, 0.8, [0, 0], { blink: true })); return st; });
  for (const n of [3, 4, 5]) add(`search.${n}`, 'story', 'curious', 2, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S('curious', 0.7, [rr(-0.8, 0.8), rr(-0.5, 0.5)], { blink: i === 0 })); st.push(S('thinking', 1.2), S(f, 0.6, [0, 0], { blink: true })); return st; });
  for (const sd of ['left', 'right']) for (const face of ['suspicious', 'smug', 'unimpressed'])
    add(`sideEye.${sd}.${face}`, 'story', face, 2, (g, f) => [S(face, 2.6, DIRS[sd], { blink: true }), S(f, 0.8, [0, 0])]);
  for (const [rn, sd] of Object.entries({ cw: 1, ccw: -1 })) for (const end of ['grumpy', 'unimpressed', 'smug'])
    add(`eyeRoll.${rn}.${end}`, 'story', 'annoyed', 2, () => [S('annoyed', 0.4, [-sd * 0.6, -0.4]), S('annoyed', 0.4, [0, -0.65]), S('annoyed', 0.4, [sd * 0.6, -0.4]), S(end, 1.4, [0, 0])]);
  for (const [sn, k] of Object.entries({ quick: 0.6, slow: 1.2 })) for (const face of ['angry', 'furious', 'determined'])
    add(`glare.${sn}.${face}`, 'story', face, face === 'furious' ? 3 : 2, () => [S(face, 2.4 * k, [0, 0]), S('grumpy', 1)]);

  // ── from the reference recording: look somewhere with a head tilt, hold, blink, swing back while shut
  for (const [dn, v] of Object.entries(DIRS)) for (const [tn, k] of Object.entries({ slow: 1.3, easy: 1 })) {
    const roll = (v[0] >= 0 ? 1 : -1) * (v[1] < 0 ? 0.2 : 0.12);
    add(`lookTilt.${dn}.${tn}`, 'glance', null, 1, (g, f) => [
      S(f, rr(0.6, 1.0) * k, v, { tilt: roll, turn: turnOf(v) * 1.2 }),
      S(f, 0.3, v, { run: () => g.blink(1) }),
      S(f, 0.9 * k, [0, 0], { tilt: 0, turn: 0 }),
    ]);
  }
  // slow curious head tilts (one eye drops lower), then level out
  for (const sd of [-1, 1]) for (const [hn, h] of Object.entries({ short: 1.2, long: 2.4 })) for (const face of ['neutral', 'curious', 'listening'])
    add(`curiousTilt.${sd < 0 ? 'left' : 'right'}.${hn}.${face}`, 'tilt', face === 'neutral' ? null : face, 1, (g, f) => [
      S(face === 'neutral' ? f : face, 0.7, [sd * 0.15, -0.15], { tilt: sd * 0.32 }),
      S(face === 'neutral' ? f : face, h, [sd * 0.2, -0.2], { tilt: sd * 0.34 }),
      S(f, 1.0, [0, 0], { tilt: 0, blink: rnd() < 0.5 }),
    ]);
  // puppy double tilt: one way, the other way
  for (const first of [-1, 1]) add(`puppyTilt.${first < 0 ? 'leftRight' : 'rightLeft'}`, 'tilt', 'curious', 2, (g, f) => [
    S('curious', 0.8, [first * 0.2, -0.2], { tilt: first * 0.3 }),
    S('curious', 0.8, [-first * 0.2, -0.2], { tilt: -first * 0.3 }),
    S(f, 0.9, [0, 0], { tilt: 0, blink: true }),
  ]);
  // slow daydream drift: the head wanders through a few small turns and tilts, no blinks
  for (const n of [3, 4, 5, 6]) add(`drift.${n}`, 'drift', null, 1, (g, f) => {
    const st = []; for (let i = 0; i < n; i++) { const x = rr(-0.55, 0.55), y = rr(-0.4, 0.3); st.push(S(f, rr(0.8, 1.4), [x, y], { tilt: rr(-0.14, 0.14), turn: x * 0.25 })); }
    st.push(S(f, 0.9, [0, 0], { tilt: 0, turn: 0, blink: rnd() < 0.6 })); return st;
  });
  // look, blink, look somewhere else (blinks land on direction changes)
  for (const [a, b] of [['left', 'right'], ['right', 'left'], ['upLeft', 'downRight'], ['upRight', 'downLeft'], ['up', 'down'], ['down', 'up']])
    add(`switch.${a}.${b}`, 'glance', null, 1, (g, f) => [
      S(f, rr(0.9, 1.4), DIRS[a], { turn: turnOf(DIRS[a]), tilt: DIRS[a][0] * 0.1 }),
      S(f, rr(0.9, 1.4), DIRS[b], { turn: turnOf(DIRS[b]), tilt: DIRS[b][0] * 0.1, blink: true }),
      S(f, 0.8, [0, 0], { turn: 0, tilt: 0, blink: true }),
    ]);

  // ── size: the eyes grow and shrink to show a feeling (no lids). A step's `size` scales both eyes ([w, h] or one
  //    number), `sizeL` / `sizeR` one eye, `lift` moves them (+ down), `pupil` adds to the pupil size.
  const GROW = { puff: [1.1, 1.14], big: [1.06, 1.1], tall: [1.0, 1.16], wide: [1.12, 1.0], round: [1.1, 1.06] };
  const SHRINK = { small: [0.94, 0.92], tiny: [0.9, 0.86], squat: [0.97, 0.88], narrow: [0.9, 0.98] };
  for (const [zn, z] of Object.entries(GROW)) for (const face of ['neutral', 'softSmile', 'adore', 'wonder', 'listening', 'plump']) for (const [tn, k] of Object.entries(TEMPO))
    add(`grow.${zn}.${face}.${tn}`, 'size', face === 'neutral' ? null : face, 1, (g, f) => [
      S(face === 'neutral' ? f : face, rr(1.6, 2.6) * k, [rr(-0.1, 0.1), rr(-0.15, 0.05)], { size: z, pupil: 0.04 }),
      S(f, 0.9 * k, null, { blink: rnd() < 0.4 }),
    ]);
  for (const [zn, z] of Object.entries(SHRINK)) for (const face of ['neutral', 'shy', 'meek', 'sad', 'worried', 'unimpressed']) for (const [tn, k] of Object.entries(TEMPO))
    add(`shrink.${zn}.${face}.${tn}`, 'size', face === 'neutral' ? null : face, 1, (g, f) => [
      S(face === 'neutral' ? f : face, rr(1.6, 2.6) * k, null, { size: z, lift: 3 }),
      S(f, 0.9 * k, null, { blink: rnd() < 0.5 }),
    ]);
  // one eye grows or shrinks (like the reference: often just one eye gets bigger)
  for (const sd of ['L', 'R']) for (const [gn, z] of Object.entries({ grow: [1.08, 1.14], swell: [1.12, 1.2], shrink: [0.94, 0.9] })) for (const [tn, k] of Object.entries(TEMPO)) for (const [ln, lk] of Object.entries({ ahead: [0, 0], side: [sd === 'L' ? -0.45 : 0.45, 0], up: [sd === 'L' ? -0.3 : 0.3, -0.35] }))
    add(`oneEye.${sd}.${gn}.${tn}.${ln}`, 'size', null, 1, (g, f) => [
      S(f, rr(1.8, 2.8) * k, lk, { ['size' + sd]: z, turn: lk[0] * 0.3, tilt: (sd === 'L' ? -1 : 1) * (gn === 'shrink' ? -0.04 : 0.05) }),
      S(f, 0.8 * k, [0, 0], { turn: 0, tilt: 0, blink: rnd() < 0.5 }),
    ]);
  // heartbeat pulses
  for (const n of [1, 2, 3]) for (const [tn, k] of Object.entries({ slow: 1.3, easy: 1 })) for (const face of ['neutral', 'love', 'adore', 'joy', 'excited', 'plump'])
    add(`pulse.${n}.${tn}.${face}`, 'size', face === 'neutral' ? null : face, 2, (g, f) => {
      const fc = face === 'neutral' ? f : face, st = [];
      for (let i = 0; i < n; i++) st.push(S(fc, 0.45 * k, [0, 0], { size: [1.08, 1.12], pupil: 0.05 }), S(fc, 0.4 * k, [0, 0], { size: 1 }));
      st.push(S(f, 0.7)); return st;
    });
  // slow breaths
  for (const [dn, a] of Object.entries({ soft: 0.04, deep: 0.08 })) for (const n of [2, 3, 4])
    add(`breathe.${dn}.${n}`, 'size', null, 1, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S(f, 1.3, null, { size: 1 + a, lift: -1 }), S(f, 1.2, null, { size: 1 - a * 0.5, lift: 1 })); st.push(S(f, 0.8)); return st; });
  // look somewhere and the eye on that side grows (the head turning toward it)
  for (const [dn, v] of Object.entries(DIRS)) for (const [tn, k] of Object.entries(TEMPO)) {
    const near = v[0] < -0.1 ? 'sizeL' : v[0] > 0.1 ? 'sizeR' : 'size';
    add(`growLook.${dn}.${tn}`, 'size', null, 1, (g, f) => [
      S(f, rr(1.5, 2.4) * k, v, { [near]: near === 'size' ? (v[1] < 0 ? [1.04, 1.1] : [0.98, 0.94]) : [1.08, 1.14], turn: turnOf(v), blink: k > 0.9 }),
      S(f, 0.8 * k, [0, 0], { turn: 0, blink: rnd() < 0.5 }),
    ]);
    add(`glanceBig.${dn}.${tn}`, 'size', null, 1, (g, f) => [S(f, 1.5 * k, v, { size: [1.05, 1.08], turn: turnOf(v), blink: k > 0.9 }), S(f, 0.7 * k, [0, 0], { turn: 0 })]);
  }
  // curious tilt while the eyes swell
  for (const sd of [-1, 1]) for (const face of ['neutral', 'curious', 'listening', 'wonder', 'adore', 'softSmile'])
    add(`swellTilt.${sd < 0 ? 'left' : 'right'}.${face}`, 'size', face === 'neutral' ? null : face, 1, (g, f) => [
      S(face === 'neutral' ? f : face, 0.8, [sd * 0.15, -0.15], { tilt: sd * 0.28, size: [1.06, 1.1] }),
      S(face === 'neutral' ? f : face, rr(1.2, 2.2), [sd * 0.2, -0.2], { tilt: sd * 0.3, size: [1.08, 1.14], pupil: 0.04 }),
      S(f, 1.0, [0, 0], { tilt: 0, blink: rnd() < 0.5 }),
    ]);
  // perk up: notice something, eyes get taller
  for (const [dn, v] of Object.entries(DIRS)) for (const face of ['neutral', 'curious', 'wonder', 'listening'])
    add(`perk.${dn}.${face}`, 'size', face === 'neutral' ? null : face, 1, (g, f) => [
      S(f, 0.5, v, { size: [1.0, 1.14], lift: -3, turn: turnOf(v), blink: true }),
      S(face === 'neutral' ? f : face, rr(1.4, 2.2), v, { size: [1.02, 1.1], lift: -2 }),
      S(f, 0.8, [0, 0], { turn: 0, blink: rnd() < 0.5 }),
    ]);
  // sink: eyes shrink and droop a little (sulky, sleepy, sad)
  for (const face of ['neutral', 'sad', 'gloomy', 'sleepy', 'drowsy', 'grumpy', 'meek']) for (const [ln, d] of Object.entries({ short: 2, long: 3.8 }))
    add(`sink.${face}.${ln}`, 'size', face === 'neutral' ? null : face, 1, (g, f) => [S(face === 'neutral' ? f : face, d * rr(0.85, 1.15), [rr(-0.2, 0.2), 0.35], { size: [0.95, 0.9], lift: 6 }), S(f, 1.0, [0, 0], { blink: true })]);
  // squishy: wide, tall, wide…
  for (const n of [1, 2, 3]) for (const [tn, k] of Object.entries({ easy: 1, quick: 0.65 }))
    add(`squishy.${n}.${tn}`, 'size', null, 2, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S(f, 0.5 * k, null, { size: [1.12, 0.92] }), S(f, 0.5 * k, null, { size: [0.95, 1.12] })); st.push(S(f, 0.7)); return st; });
  // tiny, then big (a little reveal)
  for (const face of ['joy', 'starstruck', 'sparkly', 'adore', 'puffy']) for (const [tn, k] of Object.entries({ easy: 1, quick: 0.7 }))
    add(`reveal.${face}.${tn}`, 'size', face, face === 'starstruck' ? 3 : 2, (g, f) => [S(f, 0.7 * k, [0, 0.1], { size: [0.92, 0.86], lift: 3 }), S(face, 1.6 * k, [0, 0], { size: [1.06, 1.1], run: () => g.pop(1) }), S(f, 0.8)]);
  // bashful: look away down, shrink a little, peek back
  for (const dn of ['downLeft', 'downRight', 'down', 'left', 'right']) for (const [ln, d] of Object.entries({ short: 1.6, long: 2.8 }))
    add(`bashful.${dn}.${ln}`, 'size', 'shy', 1, (g, f) => [S('shy', d, DIRS[dn], { size: [0.95, 0.92], lift: 4, turn: turnOf(DIRS[dn]) * 0.8, blink: true }), S('softSmile', 1.2, [0, 0], { turn: 0, blink: true }), S(f, 0.6)]);
  // look with a tilt, and the eyes grow on the way
  for (const [dn, v] of Object.entries(DIRS))
    add(`lookTiltGrow.${dn}`, 'size', null, 1, (g, f) => [S(f, rr(0.8, 1.2), v, { tilt: (v[0] >= 0 ? 1 : -1) * 0.15, turn: turnOf(v) * 1.2, size: [1.05, 1.1] }), S(f, 0.3, v, { size: [1.05, 1.1], run: () => g.blink(1) }), S(f, 0.9, [0, 0], { tilt: 0, turn: 0 })]);
  // settle into the size faces for a moment
  for (const [face, en] of Object.entries({ puffy: 1, tiny: 1, wide: 1, tall: 1, plump: 1, meek: 1, smallL: 1, smallR: 1 })) for (const [ln, d] of Object.entries({ short: 1.8, long: 4 }))
    add(`moment.${face}.${ln}`, 'moment', face, en, (g, f) => [S(face, d * rr(0.85, 1.15), null, { blink: rnd() < 0.5 }), S(f, 0.6)]);

  // ── mood families: animations made for one mood each (other moods borrow a few)
  const sideOf = (n) => (n === 'left' ? -1 : 1);
  // cuddly
  for (const n of [1, 2, 3]) for (const sd of ['left', 'right']) for (const face of ['adore', 'plump', 'softSmile'])
    add(`nuzzle.${n}.${sd}.${face}`, 'cuddle', face, 1, (g, f) => {
      const k = sideOf(sd), st = [];
      for (let i = 0; i < n; i++) st.push(S(face, 0.9, [0, 0], { zoom: 1.08, tilt: k * (i % 2 ? 0.12 : 0.22), size: [1.06, 1.1] }), S('happy', 0.7, [0, 0], { zoom: 1.1, tilt: k * 0.24 }));
      st.push(S(f, 0.8, [0, 0], { zoom: 1, tilt: 0 })); return st;
    });
  for (const sd of ['left', 'right']) for (const [ln, d] of Object.entries({ short: 1.6, long: 3 }))
    add(`snuggle.${sd}.${ln}`, 'cuddle', 'happy', 1, (g, f) => [S('happy', d, [0, 0], { tilt: sideOf(sd) * 0.2, zoom: 1.06 }), S('softSmile', 1.2, [0, 0], { tilt: 0, zoom: 1 }), S(f, 0.5)]);
  for (const face of ['adore', 'plump', 'softSmile']) for (const [ln, d] of Object.entries({ short: 1.6, long: 3 }))
    add(`gaze.${face}.${ln}`, 'cuddle', face, 1, (g, f) => [S(face, d * 0.5, [0, 0], { size: [1.03, 1.05] }), S(face, d * 0.5, [0, 0], { size: [1.08, 1.12], pupil: 0.06, run: () => g.blink(3) }), S(f, 0.8)]);
  for (const [ln, d] of Object.entries({ short: 1.4, long: 2.6 }))
    add(`melt.${ln}`, 'cuddle', 'adore', 1, (g, f) => [S('adore', d, [0, 0], { size: [1.08, 1.1] }), S('content', d, [0, 0.1], { size: [1.08, 0.94], lift: 4 }), S('happy', 1), S(f, 0.6)]);
  // silly
  for (const n of [1, 2, 3]) for (const face of ['derp', 'crosseyed', 'googly'])
    add(`derpOut.${n}.${face}`, 'silly', face, 2, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S(face, 0.7, null, { run: () => g.pop(1.2) }), S(f, 0.4, [0, 0])); st.push(S('giggle', 1)); return st; });
  for (const n of [1, 2, 3]) for (const [tn, k] of Object.entries({ easy: 1, quick: 0.65 }))
    add(`boing.${n}.${tn}`, 'silly', 'giggle', 3, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S(f, 0.4 * k, null, { size: [1.14, 0.9], run: () => g.kick(0, 120) }), S(f, 0.5 * k, null, { size: [0.94, 1.16], run: () => g.kick(0, -160) })); st.push(S('giggle', 1.2), S(f, 0.5)); return st; });
  for (const [ln, d] of Object.entries({ short: 1, long: 2 })) for (const end of ['giggle', 'derp'])
    add(`googlyRoll.${ln}.${end}`, 'silly', 'dizzy', 2, (g, f) => [S('dizzy', d), S(end, 1.2), S(f, 0.5, null, { blink: true })]);
  for (const n of [2, 3, 4])
    add(`faceSwap.${n}`, 'silly', 'bigL', 2, (g, f) => { const seq = ['bigL', 'bigR', 'smallL', 'smallR']; const st = []; for (let i = 0; i < n; i++) st.push(S(seq[i % 4], 0.6, [0, 0], { blink: i > 0 })); st.push(S(f, 0.6, null, { blink: true })); return st; });
  // anxious
  for (const [dn, v] of Object.entries(DIRS))
    add(`fret.${dn}`, 'fret', 'worried', 2, (g, f) => [S('worried', 0.5, v, { size: [0.95, 0.95], turn: turnOf(v) }), S('worried', 0.4, [0, 0], { turn: 0 }), S('nervous', 0.5, v, { size: [0.93, 0.93], turn: turnOf(v) }), S('meek', 1, [0, 0.2], { turn: 0 })]);
  for (const [zn, k] of Object.entries({ small: 0.7, big: 1.2 })) for (const face of ['worried', 'scared', 'surprised'])
    add(`startle.${zn}.${face}`, 'fret', face, 2, (g, f) => [S(face, 0.6, [0, 0], { size: [1.02, 1 + 0.12 * k], run: () => g.pop(1.6 * k) }), S('meek', 1.4, [0, 0.2], { size: [0.94, 0.92] }), S(f, 0.6)]);
  for (const sd of ['left', 'right']) for (const n of [1, 2])
    add(`checkBehind.${sd}.${n}`, 'fret', 'nervous', 2, (g, f) => { const k = sideOf(sd), st = []; for (let i = 0; i < n; i++) st.push(S('nervous', 0.9, [k * 0.85, 0], { turn: k * 0.6, blink: true }), S('worried', 0.6, [0, 0], { turn: 0 })); st.push(S(f, 0.6)); return st; });
  for (const [ln, d] of Object.entries({ short: 1.6, long: 3 })) add(`tremble.${ln}`, 'fret', 'nervous', 1, (g, f) => [S('nervous', d, [0, 0.15], { size: [0.94, 0.94] }), S(f, 0.7, null, { blink: true })]);
  for (const n of [1, 2]) add(`gulp.${n}`, 'fret', 'meek', 1, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S('meek', 0.8, [0, 0.1], { size: [0.94, 0.9], run: () => { g.blink(1); g.kick(0, 90); } })); st.push(S(f, 0.6)); return st; });
  // proud
  for (const [ln, d] of Object.entries({ short: 1.8, long: 3.2 })) for (const face of ['smug', 'cool', 'determined', 'content'])
    add(`chinUp.${ln}.${face}`, 'proud', face, 1, (g, f) => [S(face, d, [0, -0.3], { size: [1.0, 1.1], lift: -3 }), S(f, 0.7, [0, 0], { blink: true })]);
  for (const n of [1, 2, 3]) add(`showOff.${n}`, 'proud', 'sparkly', 2, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S('sparkly', 0.8, [0, 0], { size: [1.08, 1.12], run: () => g.pop(1.4) }), S('smug', 0.6, [0.3, 0])); st.push(S(f, 0.6)); return st; });
  for (const [ln, d] of Object.entries({ short: 2.4, long: 4.4 })) for (const face of ['smug', 'cool'])
    add(`strut.${ln}.${face}`, 'proud', face, 2, (g) => [S(face, d, null, { run: () => g._groove(d) })]);
  for (const w of ['wink', 'winkR']) add(`proudWink.${w}`, 'proud', 'smug', 2, (g, f) => [S('smug', 1.2, [0.3, -0.1]), S(w, 0.8), S('smug', 1, [0, 0]), S(f, 0.5)]);
  for (const n of [1, 2]) add(`proudNod.${n}`, 'proud', 'determined', 1, (g, f) => [S('determined', 0.6 + n * 0.45, [0, -0.1], { size: [1.0, 1.08], run: () => { for (let i = 0; i < n; i++) g.after(i * 0.45, () => g.kick(0, 110)); } }), S(f, 0.6)]);
  // busy
  for (const n of [2, 3, 4, 5]) add(`work.${n}`, 'busy', 'focused', 1, (g, f) => { const st = []; for (let l = 0; l < n; l++) { const y = -0.2 + l * 0.1; st.push(S('focused', 0.35, [-0.45, y], { size: [0.98, 0.96] }), S('focused', 0.35, [0, y]), S('focused', 0.35, [0.45, y], { blink: l === n - 1 })); } st.push(S(f, 0.6, [0, 0])); return st; });
  for (const dn of ['upLeft', 'upRight', 'up']) for (const [en, end] of Object.entries({ nod: 'determined', idea: 'sparkly', shrug: 'unimpressed' }))
    add(`calc.${dn}.${en}`, 'busy', 'thinking', 1, (g, f) => [S('thinking', 1.8, DIRS[dn], { blink: true, turn: turnOf(DIRS[dn]), pupil: -0.08 }), S(end, 1.2, [0, 0], { turn: 0, run: () => (en === 'nod' ? g.kick(0, 110) : en === 'idea' ? g.pop(1.4) : null) }), S(f, 0.5)]);
  for (const n of [3, 4, 5]) add(`checkList.${n}`, 'busy', 'focused', 1, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S('focused', 0.5, [-0.3, -0.3 + i * 0.15]), S('focused', 0.35, [-0.3, -0.3 + i * 0.15], { run: () => g.kick(0, 70) })); st.push(S(f, 0.6, [0, 0], { blink: true })); return st; });
  for (const [ln, d] of Object.entries({ short: 1.6, long: 3 })) add(`zoomIn.${ln}`, 'busy', 'focused', 1, (g, f) => [S('focused', d, [0, 0], { zoom: 1.12, size: [0.96, 1.0] }), S(f, 0.7, null, { zoom: 1 })]);
  // bored
  for (const [ln, d] of Object.entries({ short: 2.4, long: 4.4 })) for (const face of ['neutral', 'halfLid', 'dilated'])
    add(`zoneOut.${ln}.${face}`, 'bored', face === 'neutral' ? null : face, 1, (g, f) => [S(face === 'neutral' ? f : face, d, [rr(-0.3, 0.3), 0.15], { size: [1.04, 0.98], pupil: 0.04 }), S(f, 0.7, [0, 0], { blink: true })]);
  for (const n of [1, 2]) add(`sighBig.${n}`, 'bored', 'halfLid', 1, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S('halfLid', 0.9, null, { size: [1.02, 1.06], lift: -2 }), S('halfLid', 1.2, null, { size: [1.0, 0.92], lift: 5 })); st.push(S(f, 0.6)); return st; });
  for (const n of [2, 3, 4]) add(`lookAroundSlow.${n}`, 'bored', 'bored', 1, (g, f) => { const st = []; for (let i = 0; i < n; i++) { const x = (i % 2 ? 1 : -1) * rr(0.4, 0.8); st.push(S('bored', 1.6, [x, rr(-0.1, 0.3)], { turn: x * 0.3, blink: true })); } st.push(S(f, 0.8, [0, 0], { turn: 0 })); return st; });
  for (const [rn, sd] of Object.entries({ cw: 1, ccw: -1 })) add(`boredRoll.${rn}`, 'bored', 'bored', 1, () => [S('bored', 0.7, [-sd * 0.6, -0.4]), S('bored', 0.7, [0, -0.65]), S('bored', 0.7, [sd * 0.6, -0.4]), S('halfLid', 1.4, [0, 0])]);
  for (const sd of ['left', 'right']) add(`flop.${sd}`, 'bored', 'halfLid', 1, (g, f) => [S('halfLid', 2.4, [sideOf(sd) * 0.2, 0.3], { tilt: sideOf(sd) * 0.3, lift: 6, size: [1.02, 0.94] }), S(f, 0.9, [0, 0], { tilt: 0, blink: true })]);
  // sulky
  for (const [ln, d] of Object.entries({ short: 2, long: 3.6 })) for (const face of ['grumpy', 'sad', 'meek'])
    add(`pout.${ln}.${face}`, 'sulk', face, 1, (g, f) => { const k = sgn(); return [S(face, d, [k * 0.6, 0.4], { size: [0.94, 0.9], lift: 4, turn: k * 0.3 }), S(f, 0.8, [0, 0], { turn: 0, blink: true })]; });
  for (const sd of ['left', 'right']) for (const n of [1, 2])
    add(`sulkLook.${sd}.${n}`, 'sulk', 'gloomy', 1, (g, f) => { const k = sideOf(sd), st = []; for (let i = 0; i < n; i++) st.push(S('gloomy', 1.6, [k * 0.7, 0.3], { turn: k * 0.4, size: [0.95, 0.92] }), S('meek', 0.7, [0, 0], { turn: 0 })); st.push(S('gloomy', 1.2, [k * 0.7, 0.3], { turn: k * 0.4 }), S(f, 0.8, [0, 0], { turn: 0, blink: true })); return st; });
  for (const n of [1, 2, 3]) add(`sniff.${n}`, 'sulk', 'teary', 1, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S('teary', 0.7, null, { run: () => { g.kick(0, -70); g.blink(0.8); } })); st.push(S('sad', 1.2), S(f, 0.6)); return st; });
  for (const sd of ['left', 'right']) add(`huffAway.${sd}`, 'sulk', 'grumpy', 2, (g, f) => [S('grumpy', 0.5, [0, 0], { run: () => g.kick(0, 120) }), S('grumpy', 2, [sideOf(sd) * 0.75, 0.1], { turn: sideOf(sd) * 0.5, size: [0.95, 0.94] }), S(f, 0.8, [0, 0], { turn: 0, blink: true })]);
  // cozy
  for (const [ln, d] of Object.entries({ short: 2, long: 4 })) for (const face of ['content', 'drowsy', 'plump'])
    add(`snuggleDown.${ln}.${face}`, 'cozy', face, 1, (g, f) => [S(face, d, [0, 0.1], { size: [1.05, 0.95], lift: 4, run: () => g.blink(3) }), S(f, 0.9)]);
  for (const n of [1, 2, 3]) add(`warmBlink.${n}`, 'cozy', 'content', 1, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S('content', 1.5, [0, 0], { run: () => g.blink(3) })); st.push(S(f, 0.6)); return st; });
  for (const [ln, n] of Object.entries({ short: 3, long: 6 })) add(`purr.${ln}`, 'cozy', 'content', 1, (g, f) => { const st = []; for (let i = 0; i < n; i++) st.push(S('content', 0.5, null, { size: [1.03, 1.03] }), S('content', 0.5, null, { size: [1, 0.98] })); st.push(S(f, 0.6)); return st; });
  for (const sd of ['left', 'right']) add(`nestle.${sd}`, 'cozy', 'happy', 1, (g, f) => [S('happy', 2.2, [0, 0], { tilt: sideOf(sd) * 0.16, lift: 3 }), S('content', 1, [0, 0], { tilt: 0 }), S(f, 0.5)]);

  // puppy eyes: the pupils swell until they nearly fill the eye (grow.puff.adore / nuzzle were the favourites)
  for (const [tn, k] of Object.entries(TEMPO)) for (const [ln, lk] of Object.entries({ ahead: [0, 0], up: [0, -0.25], left: [-0.3, -0.1], right: [0.3, -0.1] })) for (const [zn, z] of Object.entries({ soft: [1.04, 1.06], puff: [1.1, 1.14] }))
    add(`puppyEyes.${tn}.${ln}.${zn}`, 'size', 'puppy', 1, (g, f) => [
      S('adore', 0.8 * k, lk, { size: z }),
      S('puppy', rr(1.6, 2.6) * k, lk, { size: z, pupil: 0.04, tilt: lk[0] * 0.4 }),
      S(f, 0.9 * k, [0, 0], { tilt: 0, blink: rnd() < 0.5 }),
    ]);
  for (const n of [1, 2]) for (const sd of ['left', 'right'])
    add(`puppyTiltBig.${n}.${sd}`, 'size', 'puppy', 1, (g, f) => { const k = sideOf(sd), st = []; for (let i = 0; i < n; i++) st.push(S('puppy', 1.2, [k * 0.15, -0.15], { tilt: (i % 2 ? -k : k) * 0.26, size: [1.08, 1.12] })); st.push(S(f, 0.9, [0, 0], { tilt: 0, blink: true })); return st; });
  for (const [ln, d] of Object.entries({ short: 1.8, long: 4 })) add(`moment.puppy.${ln}`, 'moment', 'puppy', 1, (g, f) => [S('puppy', d * rr(0.85, 1.15), null, { blink: rnd() < 0.5 }), S(f, 0.6)]);

  // ── reactions (to taps on the body, double taps, waves): face × move
  const MOVES = {
    pop: (g) => g.pop(1.2), hop: (g) => g.kick(0, -150), nod: (g) => { g.kick(0, 110); g.after(0.45, () => g.kick(0, 95)); },
    blink: (g) => g.blink(1), lean: (g) => g.zoom(1.12), tilt: (g) => g._tiltOnce(sgn() * 0.15), wiggle: (g) => g.wobble(0.6),
  };
  const REACT = ['puppy', 'focused', 'determined', 'derp', 'googly', 'thinking', 'bored', 'sad', 'gloomy', 'nervous', 'puffy', 'plump', 'tiny', 'meek', 'softSmile', 'joy', 'happy', 'love', 'sparkly', 'starstruck', 'surprised', 'shy', 'smug', 'unimpressed', 'grumpy', 'annoyed', 'angry', 'curious', 'listening', 'wink', 'winkR', 'giggle', 'beam', 'content', 'adore', 'dilated', 'drowsy', 'sleepy', 'cool', 'suspicious', 'worried', 'shocked'];
  for (const face of REACT) for (const [mn, mv] of Object.entries(MOVES))
    add(`react.${face}.${mn}`, 'react', face, mn === 'hop' ? 3 : 2, (g, f) => [S(face, rr(1.4, 2.2), [0, 0], { run: () => mv(g) }), S(f, 0.6, null, { zoom: 1 })]);
  for (const face of ['joy', 'softSmile', 'beam', 'shy', 'unimpressed', 'excited', 'sleepy', 'cool', 'adore']) for (const mn of ['hop', 'nod', 'lean', 'tilt'])
    add(`greet.${face}.${mn}`, 'greet', face, mn === 'hop' ? 3 : 1, (g, f) => [S('listening', 0.4, [0, 0], { blink: true }), S(face, 1.8, [0, 0], { run: () => MOVES[mn](g) }), S('softSmile', 1, [0, 0], { zoom: 1 })]);

  // ───────────────────────────── MOODS ─────────────────────────────
  // rest: resting face   faces: faces it settles into   like: faces its animations may use (null-face ones always ok)
  // fams: animation families it uses   energy: max animation energy   every: seconds between animations
  // react / greet: faces for reactions to taps & waves   sac: gaze restlessness   blink: blink heaviness
  const MOODS = {
    calm: { rest: 'neutral', faces: ['softSmile', 'listening', 'content'], energy: 2, every: [8, 20], sac: 0.8, blink: 1,
      like: ['puppy', 'puffy', 'tiny', 'wide', 'tall', 'meek', 'smallL', 'smallR', 'plump', 'softSmile', 'content', 'listening', 'curious', 'wonder', 'thinking', 'halfLid', 'drowsy', 'surprised', 'shy', 'focused', 'joy', 'dilated', 'yawn', 'squint', 'wink', 'winkR', 'bigL', 'bigR'],
      fams: ['drift', 'size', 'glance', 'turn', 'notice', 'watch', 'blink', 'moment', 'tilt', 'nod', 'pupils', 'bigEye', 'story', 'lean', 'classic'], react: ['plump', 'softSmile', 'content', 'joy', 'listening', 'wink', 'dilated'], greet: ['softSmile', 'joy'] },
    happy: { rest: 'softSmile', faces: ['content', 'joy', 'neutral'], energy: 3, every: [7, 16], sac: 1, blink: 1,
      like: ['puppy', 'puffy', 'plump', 'wide', 'tall', 'smallL', 'smallR', 'softSmile', 'content', 'joy', 'happy', 'beam', 'giggle', 'love', 'sparkly', 'starstruck', 'excited', 'wink', 'winkR', 'adore', 'wonder', 'groove', 'surprised', 'curious', 'bigL', 'bigR'],
      fams: ['drift', 'size', 'glance', 'turn', 'notice', 'blink', 'moment', 'tilt', 'hop', 'nod', 'groove', 'special', 'story', 'bigEye', 'watch', 'classic'], react: ['puppy', 'puffy', 'plump', 'joy', 'happy', 'beam', 'giggle', 'love', 'sparkly', 'wink'], greet: ['joy', 'beam', 'excited'] },
    sleepy: { rest: 'drowsy', faces: ['sleepy', 'halfLid'], energy: 1, every: [10, 24], sac: 0.5, blink: 1.6,
      like: ['tiny', 'meek', 'drowsy', 'sleepy', 'halfLid', 'yawn', 'squint', 'content', 'softSmile', 'asleep', 'gloomy', 'wonder'],
      fams: ['drift', 'size', 'glance', 'blink', 'moment', 'story', 'tilt', 'turn', 'classic'], react: ['meek', 'drowsy', 'sleepy', 'softSmile', 'content'], greet: ['sleepy', 'softSmile'] },
    grumpy: { rest: 'grumpy', faces: ['annoyed', 'unimpressed', 'halfLid'], energy: 2, every: [9, 20], sac: 0.6, blink: 1.2,
      like: ['tiny', 'wide', 'smallL', 'smallR', 'grumpy', 'annoyed', 'unimpressed', 'suspicious', 'angry', 'furious', 'determined', 'focused', 'halfLid', 'gloomy', 'smug', 'sad'],
      fams: ['drift', 'size', 'glance', 'turn', 'notice', 'moment', 'nope', 'story', 'lean', 'blink', 'classic'], react: ['grumpy', 'annoyed', 'unimpressed', 'angry', 'suspicious'], greet: ['unimpressed', 'cool'] },
    curious: { rest: 'neutral', faces: ['listening', 'curious', 'wonder'], energy: 2, every: [6, 14], sac: 1.2, blink: 0.9,
      like: ['puppy', 'puffy', 'tall', 'wide', 'smallL', 'smallR', 'meek', 'curious', 'listening', 'wonder', 'thinking', 'focused', 'surprised', 'shocked', 'dilated', 'pinpoint', 'sparkly', 'suspicious', 'boggle', 'bigL', 'bigR', 'softSmile'],
      fams: ['drift', 'size', 'glance', 'turn', 'notice', 'watch', 'moment', 'tilt', 'lean', 'pupils', 'bigEye', 'story', 'blink', 'classic'], react: ['puffy', 'curious', 'surprised', 'listening', 'dilated', 'sparkly'], greet: ['joy', 'adore'] },
    playful: { rest: 'neutral', faces: ['softSmile', 'smug', 'joy'], energy: 3, every: [6, 14], sac: 1.1, blink: 0.9,
      like: ['puppy', 'puffy', 'plump', 'wide', 'tall', 'tiny', 'smallL', 'smallR', 'smug', 'wink', 'winkR', 'joy', 'giggle', 'happy', 'excited', 'surprised', 'shocked', 'curious', 'peek', 'derp', 'crosseyed', 'boggle', 'bigL', 'bigR', 'sparkly', 'softSmile'],
      fams: ['drift', 'size', 'glance', 'turn', 'notice', 'watch', 'blink', 'moment', 'hop', 'tilt', 'story', 'bigEye', 'special', 'classic'], react: ['puffy', 'giggle', 'wink', 'winkR', 'smug', 'surprised', 'joy'], greet: ['joy', 'beam', 'excited'] },
    shy: { rest: 'neutral', faces: ['shy', 'softSmile'], energy: 1, every: [8, 18], sac: 0.7, blink: 1.1,
      like: ['puppy', 'tiny', 'meek', 'puffy', 'plump', 'smallL', 'smallR', 'shy', 'softSmile', 'content', 'love', 'peek', 'worried', 'surprised', 'wonder', 'halfLid'],
      fams: ['drift', 'size', 'glance', 'notice', 'blink', 'moment', 'story', 'tilt', 'special', 'classic'], react: ['puppy', 'meek', 'tiny', 'shy', 'softSmile', 'love', 'worried'], greet: ['shy', 'softSmile'] },
    dreamy: { rest: 'content', faces: ['drowsy', 'wonder', 'softSmile'], energy: 2, every: [8, 20], sac: 0.6, blink: 1.3,
      like: ['puppy', 'puffy', 'plump', 'tall', 'meek', 'wonder', 'content', 'softSmile', 'drowsy', 'sparkly', 'adore', 'love', 'glowy', 'starstruck', 'dilated', 'yawn', 'groove', 'halfLid'],
      fams: ['drift', 'size', 'glance', 'watch', 'blink', 'moment', 'tilt', 'story', 'special', 'groove', 'pupils', 'classic'], react: ['puppy', 'plump', 'adore', 'love', 'sparkly', 'content', 'dilated'], greet: ['adore', 'softSmile'] },
    hyper: { rest: 'excited', faces: ['joy', 'sparkly', 'surprised'], energy: 3, every: [4, 9], sac: 1.6, blink: 0.8,
      like: ['puppy', 'puffy', 'plump', 'wide', 'tall', 'smallL', 'smallR', 'excited', 'joy', 'happy', 'beam', 'giggle', 'starstruck', 'sparkly', 'surprised', 'shocked', 'curious', 'dilated', 'boggle', 'derp', 'bigL', 'bigR', 'wink', 'winkR', 'groove'],
      fams: ['drift', 'size', 'glance', 'turn', 'notice', 'watch', 'blink', 'moment', 'hop', 'nod', 'groove', 'special', 'story', 'bigEye', 'pupils', 'classic'], react: ['starstruck', 'beam', 'giggle', 'shocked', 'sparkly', 'excited'], greet: ['excited', 'beam', 'joy'] },
    sassy: { rest: 'cool', faces: ['smug', 'suspicious', 'unimpressed'], energy: 2, every: [8, 18], sac: 0.8, blink: 1.1,
      like: ['wide', 'tiny', 'smallL', 'smallR', 'smug', 'cool', 'suspicious', 'unimpressed', 'annoyed', 'wink', 'winkR', 'determined', 'focused', 'ghost', 'halfLid', 'bigL', 'bigR'],
      fams: ['drift', 'size', 'glance', 'turn', 'notice', 'blink', 'moment', 'tilt', 'lean', 'nope', 'story', 'bigEye', 'classic'], react: ['smug', 'cool', 'wink', 'winkR', 'unimpressed', 'suspicious'], greet: ['cool', 'smug'] },
    cuddly: { rest: 'softSmile', faces: ['adore', 'content', 'plump'], energy: 2, every: [7, 16], sac: 0.8, blink: 1.1,
      like: ['puppy', 'adore', 'love', 'softSmile', 'content', 'plump', 'puffy', 'happy', 'beam', 'shy', 'sparkly', 'wonder', 'dilated', 'bigL', 'bigR', 'smallL', 'smallR', 'meek', 'listening'],
      fams: ['drift', 'size', 'cuddle', 'cozy', 'glance', 'blink', 'moment', 'tilt', 'lean', 'special', 'story', 'classic'], react: ['puppy', 'adore', 'love', 'plump', 'happy', 'softSmile'], greet: ['adore', 'joy', 'softSmile'] },
    silly: { rest: 'neutral', faces: ['joy', 'smug', 'wide'], energy: 3, every: [5, 12], sac: 1.3, blink: 0.9,
      like: ['puppy', 'derp', 'crosseyed', 'googly', 'boggle', 'giggle', 'joy', 'happy', 'surprised', 'shocked', 'wheee', 'bigL', 'bigR', 'smallL', 'smallR', 'wide', 'tall', 'puffy', 'wink', 'winkR', 'smug'],
      fams: ['drift', 'size', 'silly', 'glance', 'turn', 'watch', 'blink', 'moment', 'hop', 'bigEye', 'story', 'special', 'classic'], react: ['giggle', 'joy', 'wink', 'winkR', 'puffy', 'derp', 'googly', 'surprised'], greet: ['joy', 'beam', 'excited'] },
    anxious: { rest: 'worried', faces: ['nervous', 'meek', 'tiny', 'listening'], energy: 2, every: [6, 14], sac: 1.4, blink: 1,
      like: ['worried', 'nervous', 'meek', 'tiny', 'scared', 'surprised', 'shocked', 'listening', 'shy', 'sad', 'pinpoint', 'smallL', 'smallR', 'focused'],
      fams: ['drift', 'size', 'fret', 'glance', 'turn', 'notice', 'watch', 'blink', 'moment', 'story', 'classic'], react: ['surprised', 'worried', 'shocked', 'shy', 'tiny', 'meek', 'nervous'], greet: ['shy', 'softSmile'] },
    proud: { rest: 'content', faces: ['smug', 'determined', 'cool', 'tall'], energy: 2, every: [8, 18], sac: 0.8, blink: 1,
      like: ['smug', 'determined', 'cool', 'sparkly', 'tall', 'wide', 'puffy', 'joy', 'starstruck', 'focused', 'wink', 'winkR', 'softSmile', 'content'],
      fams: ['drift', 'size', 'proud', 'glance', 'turn', 'notice', 'blink', 'moment', 'tilt', 'lean', 'nod', 'story', 'classic'], react: ['smug', 'cool', 'sparkly', 'wink', 'joy', 'determined'], greet: ['cool', 'joy'] },
    busy: { rest: 'focused', faces: ['thinking', 'determined', 'listening'], energy: 2, every: [6, 14], sac: 1.1, blink: 1,
      like: ['focused', 'thinking', 'determined', 'pinpoint', 'curious', 'listening', 'surprised', 'unimpressed', 'sparkly', 'tall'],
      fams: ['drift', 'size', 'busy', 'glance', 'turn', 'watch', 'blink', 'moment', 'nod', 'story', 'classic'], react: ['focused', 'determined', 'unimpressed', 'surprised', 'listening', 'thinking'], greet: ['softSmile', 'unimpressed'] },
    bored: { rest: 'bored', faces: ['halfLid', 'unimpressed', 'drowsy'], energy: 1, every: [9, 20], sac: 0.5, blink: 1.3,
      like: ['bored', 'halfLid', 'unimpressed', 'drowsy', 'sleepy', 'yawn', 'squint', 'gloomy', 'annoyed', 'tiny', 'wide', 'smallL', 'smallR', 'content', 'dilated'],
      fams: ['drift', 'size', 'bored', 'glance', 'turn', 'blink', 'moment', 'tilt', 'story', 'classic'], react: ['unimpressed', 'bored', 'drowsy', 'annoyed'], greet: ['unimpressed', 'sleepy'] },
    sulky: { rest: 'meek', faces: ['gloomy', 'sad', 'grumpy', 'tiny'], energy: 1, every: [9, 20], sac: 0.6, blink: 1.2,
      like: ['gloomy', 'sad', 'grumpy', 'teary', 'tiny', 'meek', 'halfLid', 'unimpressed', 'shy', 'smallL', 'smallR', 'worried'],
      fams: ['drift', 'size', 'sulk', 'glance', 'turn', 'blink', 'moment', 'story', 'classic'], react: ['grumpy', 'sad', 'gloomy', 'tiny', 'meek', 'unimpressed'], greet: ['shy', 'unimpressed'] },
    cozy: { rest: 'content', faces: ['softSmile', 'drowsy', 'plump'], energy: 1, every: [10, 22], sac: 0.5, blink: 1.4,
      like: ['puppy', 'content', 'softSmile', 'drowsy', 'plump', 'puffy', 'happy', 'halfLid', 'sleepy', 'yawn', 'adore', 'meek', 'groove', 'wonder', 'dilated'],
      fams: ['drift', 'size', 'cozy', 'cuddle', 'glance', 'blink', 'moment', 'tilt', 'story', 'classic'], react: ['content', 'softSmile', 'plump', 'happy', 'drowsy'], greet: ['softSmile', 'sleepy'] },
  };
  // older moods borrow a few of the new families
  for (const [m, fs] of Object.entries({ happy: ['cuddle'], playful: ['silly'], hyper: ['silly'], grumpy: ['sulk'], shy: ['fret', 'cozy'], sleepy: ['cozy', 'bored'], sassy: ['proud'], curious: ['busy'], calm: ['cozy'], dreamy: ['cozy', 'cuddle'] }))
    MOODS[m].fams.push(...fs);
  // ───────────────────────────── PERSONALITY ─────────────────────────────
  // where each mood sits on the personality grid (x: chill → hyper, y: cute → feisty)
  const MOOD_AT = { cuddly: [-0.2, -0.9], silly: [0.8, -0.2], anxious: [0.6, 0.3], proud: [0, 0.6], busy: [0.1, 0.4], bored: [-0.8, 0.4], sulky: [-0.5, 0.6], cozy: [-0.9, -0.5],
    calm: [-0.6, -0.1], happy: [0.3, -0.6], sleepy: [-0.9, 0], grumpy: [-0.3, 0.9], curious: [0.3, 0], playful: [0.7, 0.1],
    shy: [-0.4, -0.9], dreamy: [-0.6, -0.6], hyper: [1, 0], sassy: [0.2, 0.8] };
  // how feisty (+) or cute (−) a face is
  const FEIST = { angry: 1, furious: 1, grumpy: 0.9, annoyed: 0.8, smug: 0.8, unimpressed: 0.7, suspicious: 0.7, determined: 0.6, cool: 0.6,
    focused: 0.3, wink: 0.2, winkR: 0.2, nervous: -0.2, worried: -0.3, sad: -0.3, teary: -0.4, derp: -0.3, tall: -0.3, listening: -0.3,
    puppy: -1, adore: -1, love: -1, shy: -0.9, puffy: -0.9, plump: -0.9, meek: -0.8, sparkly: -0.8, happy: -0.7, beam: -0.7, softSmile: -0.6,
    joy: -0.6, giggle: -0.6, starstruck: -0.6, tiny: -0.6, dilated: -0.6, content: -0.5, wonder: -0.5, wide: -0.5, bigL: -0.5, bigR: -0.5,
    smallL: -0.4, smallR: -0.4 };
  // signature moves: each goober does one family of animations ~3× more often than others do
  const SIGNATURES = ['puppyEyes', 'oneEye', 'growLook', 'swellTilt', 'perk', 'pulse', 'squishy', 'nuzzle', 'bashful', 'lookTilt', 'curiousTilt', 'drift', 'sideEye', 'eyeRoll', 'hop', 'boing'];
  const idCheck = (p, c, e) => { let h = 0x811c9dc5; for (const w of [p, c, e]) for (let i = 0; i < 4; i++) { h ^= (w >>> (i * 8)) & 255; h = Math.imul(h, 0x01000193); } return ((h >>> 16) ^ (h & 0xffff) ^ 0x60b3) & 0xffff; };
  // 25 personalities on a 5×5 grid. rows: very cute → very feisty, columns: very chill → very hyper. Each one is 1 in 25.
  const PERSONALITIES = [
    ['softie', 'snuggler', 'sweetie', 'sunbeam', 'sparkler'],
    ['cozy', 'marshmallow', 'darling', 'bubbly', 'zoomie'],
    ['sloth', 'mellow', 'easygoing', 'perky', 'bouncer'],
    ['aloof', 'moody', 'cheeky', 'rascal', 'firecracker'],
    ['diva', 'grouch', 'spicy', 'menace', 'gremlin'],
  ];

  // build each mood's pools from the library
  for (const M of Object.values(MOODS)) {
    const okFace = (fc) => !fc || M.like.includes(fc) || M.react.includes(fc);
    M.acts = Object.keys(ACTS).filter((n) => { const m = META[n]; const fits = m.energy <= M.energy || (m.face && M.like.includes(m.face) && m.energy <= M.energy + 1 && ['moment', 'notice', 'story', 'tilt'].includes(m.fam)); return M.fams.includes(m.fam) && fits && okFace(m.face) && !['react', 'greet'].includes(m.fam); });
    M.tap = Object.keys(ACTS).filter((n) => META[n].fam === 'react' && M.react.includes(META[n].face) && META[n].energy <= Math.max(2, M.energy));
    M.dbl = Object.keys(ACTS).filter((n) => ['special', 'hop', 'bigEye', 'blink'].includes(META[n].fam) && okFace(META[n].face) && META[n].energy <= M.energy);
    M.hello = Object.keys(ACTS).filter((n) => META[n].fam === 'greet' && M.greet.includes(META[n].face) && META[n].energy <= M.energy);
    if (!M.dbl.length) M.dbl = M.tap;
    if (!M.hello.length) M.hello = ['greet'];
  }

  function profile(P, inner, out) {
    const bot = clamp(P.bot, 0, 0.6), k = clamp(P.sharp, 0.03, 0.4);
    for (let i = 0; i < N; i++) {
      const th = (i / N) * TAU, s = Math.sin(th);
      let r = 1;
      if (bot > 0.001 && s > 1e-3) { const t = (1 - bot * 1.7) / s; if (t > 0) r = smin(r, t, k); }
      if (P.curve > 0.001 && s > 0) r *= 1 - P.curve * s * s * s;
      r *= 1 - 0.008 * Math.cos(3 * (th - Math.PI / 2) + 0.12 * inner); // a hair fuller at the top, never a perfect circle
      out[i] = Math.max(r, 0.04);
    }
  }

  // ───────────────────────────── one eye ─────────────────────────────
  class Eye {
    constructor(side) {
      this.side = side; this.inner = -side;
      const Sp = (v, f, z) => new Spring(v, f, z);
      this.s = { // critically damped: they arrive and stop, no bubbling
        x: Sp(0, 1.4, 1), y: Sp(0, 1.4, 1), ex: Sp(0, 1.1, 1), ey: Sp(0, 1.1, 1),
        sx: Sp(DEF.sx, 1.5, 0.95), sy: Sp(DEF.sy, 1.5, 0.95), bend: Sp(0, 1.5, 0.95), rot: Sp(0, 1.1, 1),
        pu: Sp(0, 2, 1), pv: Sp(0.085, 2, 1), pr: Sp(0.45, 0.9, 1),
        heart: Sp(0, 1.1, 1), star: Sp(0, 1.1, 1), shut: Sp(0, 2, 1), arc: Sp(1, 1.6, 1), shine: Sp(DEF.shine, 0.8, 1), glow: Sp(DEF.glow, 0.6, 1), fill: Sp(1, 0.9, 0.75),
      };
      this.r = new Float32Array(N).fill(1); this.rv = new Float32Array(N); this.rt = new Float32Array(N).fill(1);
      this.ph = rnd() * 100;
      this.blinkOK = 1; this.blinkUntil = -1; this.openUntil = -1; this.blinkSlow = 1;
      this.base = Object.assign({}, DEF);
      this.R = {}; this.pcx = 0; this.pcy = 0; this.vel = [0, 0];
    }
    wobble(amount) { const ph = rnd() * TAU; for (let i = 0; i < N; i++) this.rv[i] += amount * Math.cos(2 * ((i / N) * TAU) + ph); }
    stepRadii(dt, ax, ay, t) {
      const w = TAU * 3.2, k = w * w, c = 2 * 0.8 * w, kc = k * 0.7, r = this.r, rv = this.rv, rt = this.rt, ph = this.ph;
      const a2 = noise(t * 0.15 + ph) * 0.007, p2 = noise(t * 0.07 + ph + 9) * 3, a3 = noise(t * 0.18 + ph + 21) * 0.005, p3 = noise(t * 0.06 + ph + 33) * 3;
      for (let i = 0; i < N; i++) {
        const th = (i / N) * TAU;
        const drift = a2 * Math.cos(2 * th + p2) + a3 * Math.cos(3 * th + p3);
        const lap = r[(i + N - 1) % N] + r[(i + 1) % N] - 2 * r[i];
        const slosh = -(ax * Math.cos(th) + ay * Math.sin(th)) * 35;
        rv[i] += (k * (rt[i] + drift - r[i]) - c * rv[i] + kc * lap + slosh) * dt;
      }
      for (let i = 0; i < N; i++) r[i] = Math.max(0.03, r[i] + rv[i] * dt);
    }
    radius(th) {
      let f = (th / TAU) * N; f -= Math.floor(f / N) * N;
      const i = Math.floor(f), t = f - i, r = this.r;
      const p0 = r[(i + N - 1) % N], p1 = r[i % N], p2 = r[(i + 1) % N], p3 = r[(i + 2) % N];
      return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
    }
  }

  // ───────────────────────────── the creature ─────────────────────────────
  class Goober {
    constructor() {
      this.t = 0;
      this.eyes = [new Eye(-1), new Eye(1)];
      const Sp = (v, f, z) => new Spring(v, f, z);
      this.g = {
        ox: Sp(0, 1.6, 0.65), oy: Sp(0, 1.6, 0.65),
        tilt: Sp(0, 0.8, 0.95), rotAll: Sp(0, 0.8, 1), hold: Sp(0, 3, 1),
        lidY: Sp(-110, 1.3, 1), lidK: Sp(0, 1.3, 1), lidS: Sp(0, 1.3, 1),
        pitch: Sp(0, 0.7, 0.85), spin: Sp(0, 0.65, 0.9), zoom: Sp(1, 0.7, 1),
      };
      this.F = {}; this.gaze = [0, 0]; this.pull = {};
      this.look = { type: 'round', swatch: 'goober' };
      this.force = { x: 0, y: 0 }; this.slosh = { x: 0, y: 0 };
      this.mode = 'awake';
      this.pers = { col: 2, row: 2, x: 0, y: 0, kx: 1, ky: 1, pr: 0, tilt: 0, tempo: 1, blinkGap: 1, blinkSlow: 1, moodLen: 1, sacK: 1, dbl: 0.12 };
      this.dna = { blinkRate: 8, blinkSpeed: 4, moodLen: 8, restless: 8, dbl: 4, salt: 0, batch: 0, fav: 0, sig: 0, eyeSize: 3, pupilSize: 3, serial: 0 };
      this._rollDna(); this.rollPersonality(true);
      this.mood = this._pickMood(); this.moodUntil = rr(3600, 10800) * this.pers.moodLen;
      this.exprName = ''; this.expr = FACES.neutral;
      this.seq = null; this.seqI = 0; this.seqT = 0; this.locked = false; this.seqName = '';
      this.idleFace = null; this.idleFaceUntil = rr(20, 40); this.nextAct = rr(8, 14);
      this.nextBlink = rr(1, 4); this.nextSac = 1; this.lastInput = 0;
      this.btn = { down: false, t0: 0, long: false, taps: 0, lastTap: -9, tapTimes: [] };
      this.imu = { lp: { x: 0, y: -1, z: 0 }, E: 0, shakeT: 0, ffT: 0, falling: false, fallT0: 0, upT: 0, lastJolt: -9, dizzyTimes: [] };
      this.sense = { cold: 0, hot: 0, loud: 0, loudSlow: 0, light: 0.6, dark: 0, seen: null, seenSince: -1, lastSeen: -99, nextEnv: 15, battery: 1, charging: false, covered: false, coverT: 0 };
      this.parts = []; this.fxT = {}; this._tm = []; this.sleepPokes = []; this.listeners = [];
      this._apply('neutral');
    }

    // ── public
    on(fn) { this.listeners.push(fn); }
    _emit(msg) { for (const f of this.listeners) f(msg); }
    get faceNames() { return Object.keys(FACES); }
    get expressionNames() { return Object.keys(FACES); }
    get actNames() { return Object.keys(ACTS); }
    get moodNames() { return Object.keys(MOODS); }
    moodPool(m) { const M = MOODS[m || this.mood]; return { acts: M.acts.length, tap: M.tap.length, dbl: M.dbl.length, hello: M.hello.length }; }
    get moodLeft() { return Math.max(0, this.moodUntil - this.t); }
    get face() { return this.exprName; }
    get typeNames() { return Object.keys(TYPES); }
    get swatchNames() { return Object.keys(SWATCHES); }
    swatchColors(n) { return SWATCHES[n]; }
    get rarity() { return { types: Object.assign({}, TYPE_CHANCE), swatches: Object.assign({}, SWATCH_CHANCE) }; }
    lookOdds(type, swatch) { const p = (TYPE_CHANCE[type] / 100) * (SWATCH_CHANCE[swatch] / 100); return { chance: p, oneIn: Math.round(1 / p) }; }
    rollLook() { // what the factory would do: roll a type and a colourway by their odds
      const roll = (tbl) => { let r = rnd() * Object.values(tbl).reduce((a, b) => a + b, 0); for (const [k, w] of Object.entries(tbl)) { r -= w; if (r <= 0) return k; } return Object.keys(tbl)[0]; };
      this.setLook(roll(TYPE_CHANCE), roll(SWATCH_CHANCE)); return this.look;
    }
    setLook(type, swatch) {
      if (type && TYPES[type]) this.look.type = type;
      if (swatch && SWATCHES[swatch]) {
        this.look.swatch = swatch; const sw = SWATCHES[swatch];
        PAL.eye = hx(sw[0]); PAL.accent = PAL.eye; PAL.pupil = hx(sw[1]); PAL.pupilR = sw[2] ? hx(sw[2]) : null;
      }
      this._apply(this.exprName);
    }
    get shading() { return SHADE; }
    set shading(v) { SHADE = v === 'bowl' || v === 'flat' ? v : 'none'; }
    // ── power plan: the brain tells the hardware how hard it needs to work right now.
    //  fps      how often the screen must be redrawn (fast only while something actually moves; 0 = hold the frame)
    //  camFps   how often the camera should look (rare when nobody's around, quick bursts when someone is)
    //  bright   screen brightness 0..1 (dims when nothing happens, off when asleep)
    //  micOn    whether the mic needs to listen
    // The firmware renders at `fps`, light-sleeps between frames, keeps the camera in its low-power monitor mode
    // between `camFps` frames, and deep-sleeps (screen off, IMU wake-on-knock) when `screen` is false.
    _powerPlan(dt) {
      const P = this.power || (this.power = { fps: 30, camFps: 1, bright: 1, screen: true, micOn: true, activity: 1 });
      let act = 0;
      for (const e of this.eyes) { const s = e.s; act += Math.abs(s.x.v) + Math.abs(s.y.v) + Math.abs(s.sy.v) * 2 + Math.abs(s.shut.v) * 2 + Math.abs(s.pu.v) + Math.abs(s.pv.v) + Math.abs(s.pr.v); }
      const G = this.g; act += (Math.abs(G.ox.v) + Math.abs(G.oy.v)) / 150 + Math.abs(G.spin.v) + Math.abs(G.pitch.v) + Math.abs(G.zoom.v) + Math.abs(G.lidY.v) / 40;
      if (this.parts.length) act += 0.5;
      P.activity += (act - P.activity) * (1 - Math.exp(-dt / 0.2));
      const t = this.t, idle = t - this.lastInput, asleep = this.mode === 'asleep', E = this.sense;
      const dark = (E.light ?? 0.6) < 0.08;
      P.screen = !(asleep && dark) || !!this.seq;     // it's an accessory: the screen stays on unless it's asleep in the dark
      P.fps = !P.screen ? 0 : P.activity > (this.imu.carried ? 1.2 : 0.35) ? 30 : 15;  // never below 15: the float always moves (~13 px/s at its fastest)
      const attention = t < (E.attnUntil || 0) || t - (E.lastSeen || -99) < 4 || !!this.seq && /greet|peekaboo|where/.test(this.seqName);
      const carried = this.imu.carried;
      P.camFps = asleep && dark ? 0 : asleep ? 0.2 : attention ? 5 : E.seen ? 2 : carried ? 0.5 : idle > 120 ? 0.3 : 0.5;  // the camera mostly naps; monitor mode wakes it on motion
      P.bright = !P.screen ? 0 : dark ? 0.4 : 1;      // full brightness always; only very dark rooms get a dimmer screen
      if (E.charging && P.screen) {                    // plugged in: dim to 20 %, and once the wall-eyed stare has settled
        if (this.seq) E.busyUntil = t;                 // (~2.5 s after plugging in or after a reaction) stop redrawing:
        P.bright = 0.2;                                // the panel keeps showing the last frame
        if (t - (E.busyUntil || 0) > 2.5) P.fps = 0;
      }
      P.micOn = !asleep;
      return P;
    }
    get doing() { return this.seq ? this.seqName : ''; }
    preview(name, dur) { if (FACES[name]) { this.locked = false; this.play([{ e: name, d: dur }], name); this.locked = dur === Infinity; } }
    act(name) { if (ACTS[name]) { this.locked = false; if (this.mode === 'asleep') this.mode = 'awake'; this._act(name); } }
    unlock() { this.locked = false; this.seq = null; this._resetBall(); }
    // ── personality: every goober is born somewhere on a 2D grid and keeps it for life.
    //   a 5×5 grid: rows cute → feisty, columns chill → hyper (x, y = −1 … +1 in steps of 0.5)
    //   It weights which moods come up, which animations/reactions it picks (cute faces vs attitude faces, calm vs wild),
    //   how often it does things, and its resting eyes (cute: a bit bigger, bigger pupils, inner corners up;
    //   feisty: a bit smaller, smaller pupils, inner corners down).
    get personality() { const p = this.pers; return { col: p.col, row: p.row, x: p.x, y: p.y, name: PERSONALITIES[p.row][p.col] }; }
    get personalityGrid() { return PERSONALITIES.map((r) => r.slice()); }
    // setPersonality(col 0–4 chill→hyper, row 0–4 cute→feisty), or setPersonality('gremlin')
    setPersonality(col, row, quiet) {
      if (typeof col === 'string') { const r = PERSONALITIES.findIndex((rw) => rw.includes(col)); if (r < 0) return; row = r; col = PERSONALITIES[r].indexOf(col); }
      this.pers.col = clamp(Math.round(+col || 0), 0, 4); this.pers.row = clamp(Math.round(+row || 0), 0, 4);
      this._derive();
      if (!quiet) { this._emit('personality → ' + PERSONALITIES[this.pers.row][this.pers.col]); this._apply(this.exprName); }
    }
    rollPersonality(quiet) { this.setPersonality(Math.floor(rnd() * 5), Math.floor(rnd() * 5), quiet); return this.personality; }
    // the grid sets the broad strokes; the goober's own DNA bits fine-tune them (see the ID below)
    _derive() {
      const P = this.pers, D = this.dna, x = (P.col - 2) / 2, y = (P.row - 2) / 2;
      const eyeK = 1 + (D.eyeSize - 3) * 0.012;
      Object.assign(P, {
        x, y, kx: (1 - 0.03 * y) * eyeK, ky: (1 - 0.05 * y) * eyeK, pr: -0.035 * y + (D.pupilSize - 3) * 0.012, tilt: 0.04 * y,
        tempo: 1 - 0.3 * x,
        blinkGap: (1 - 0.2 * x) * (1 + 0.15 * y) * (0.75 + (D.blinkRate / 15) * 0.5),  // hyper blinks more often, feisty stares longer
        blinkSlow: (1 - 0.15 * x) * (0.85 + (D.blinkSpeed / 7) * 0.3),                 // chill blinks are slower and lazier
        moodLen: (1 - 0.25 * x) * (0.8 + (D.moodLen / 15) * 0.4),                      // hyper moods pass sooner, chill ones linger
        sacK: 0.85 + (D.restless / 15) * 0.3,
        dbl: clamp(0.06 + (D.dbl / 7) * 0.12 - 0.04 * y, 0.02, 0.25),                  // cute ones flutter (double blinks) more
      });
    }
    // ── what this goober is like, in words and numbers (for the recap card)
    get traits() {
      const P = this.pers, D = this.dna, M = Object.keys(MOODS);
      const word = (v, lo, hi, a, b, c) => (v < lo ? a : v > hi ? c : b);
      return {
        personality: PERSONALITIES[P.row][P.col], col: P.col, row: P.row,
        blinkEvery: [2.5 * P.blinkGap, 6.5 * P.blinkGap], blinkLength: 0.17 * P.blinkSlow + 0.11 * P.blinkSlow + 0.5 * P.blinkSlow,
        blinks: word(P.blinkGap, 0.9, 1.15, 'blinks a lot', 'blinks normally', 'stares, blinks rarely'),
        blinkStyle: word(P.blinkSlow, 0.92, 1.1, 'quick, snappy blinks', 'easy blinks', 'slow, lazy blinks'),
        flutter: P.dbl, moodHours: [P.moodLen, 3 * P.moodLen],
        restless: word(P.sacK * P.tempo, 0.85, 1.1, 'restless eyes', 'looks around normally', 'calm, steady gaze'),
        favourite: M[D.fav % M.length], signature: SIGNATURES[D.sig % SIGNATURES.length],
        eyeSize: (D.eyeSize - 3) * 1.2, pupilSize: (D.pupilSize - 3) * 1.2,
      };
    }
    // ── odds of this goober: the look, the look + personality, and every trait in the ID (not batch / serial / salt)
    get odds() {
      const look = this.lookOdds(this.look.type, this.look.swatch).chance, pers = 1 / 25;
      const traits = { 'favourite mood': Object.keys(MOODS).length, 'signature move': SIGNATURES.length, 'blink rate': 16, 'blink speed': 8,
        'mood length': 16, gaze: 16, 'double blinks': 8, 'eye size': 8, 'pupil size': 8 };
      const rest = Object.values(traits).reduce((x, n) => x / n, 1);
      return { look, personality: pers, lookPersonality: look * pers, traits, full: look * pers * rest };
    }
    // chance of each mood coming up next (every goober gets every mood; personality only tilts the odds)
    moodChances(not) {
      const p = this.pers, fav = Object.keys(MOODS)[this.dna.fav % Object.keys(MOODS).length], names = Object.keys(MOODS).filter((m) => m !== not);
      const w = names.map((m) => { const a = MOOD_AT[m]; return (0.45 + Math.exp(-((a[0] - p.x) ** 2 + (a[1] - p.y) ** 2) / 0.9)) * (m === fav ? 1.8 : 1); });
      const tot = w.reduce((x, y) => x + y, 0), out = {}; names.forEach((m, i) => (out[m] = w[i] / tot)); return out;
    }

    // ── goober ID: goob-PPPPPPPP-CCCCCCCC-EEEEEEEE-KKKK (hex). Three 32-bit words + a 16-bit check.
    //   P personality  bits 0–2 column (chill→hyper) · 3–5 row (cute→feisty) · 6–9 blink rate · 10–12 blink speed ·
    //                  13–16 mood length · 17–20 restlessness · 21–23 flutter (double blinks) · 24–31 salt
    //   C colour       bits 0–6 colourway (index in the colourway list) · 7–31 batch
    //   E everything else (not colour)  bits 0–1 eye type · 2–6 favourite mood · 7–10 signature move ·
    //                  11–13 eye size · 14–16 pupil size · 17–31 serial
    //   K check        FNV-1a of the 12 bytes, folded to 16 bits — catches typos
    get idParts() {
      const P = this.pers, D = this.dna;
      const p = (P.col | (P.row << 3) | (D.blinkRate << 6) | (D.blinkSpeed << 10) | (D.moodLen << 13) | (D.restless << 17) | (D.dbl << 21) | (D.salt << 24)) >>> 0;
      const c = (Object.keys(SWATCHES).indexOf(this.look.swatch) | (D.batch << 7)) >>> 0;
      const e = (Object.keys(TYPES).indexOf(this.look.type) | (D.fav << 2) | (D.sig << 7) | (D.eyeSize << 11) | (D.pupilSize << 14) | (D.serial << 17)) >>> 0;
      return { personality: p, colour: c, rest: e, check: idCheck(p, c, e) };
    }
    get id() { const q = this.idParts, h = (v, n) => v.toString(16).padStart(n, '0'); return `goob-${h(q.personality, 8)}-${h(q.colour, 8)}-${h(q.rest, 8)}-${h(q.check, 4)}`; }
    static parseId(str) {
      const m = /^\s*goob-([0-9a-f]{8})-([0-9a-f]{8})-([0-9a-f]{8})-([0-9a-f]{4})\s*$/i.exec(str || '');
      if (!m) return { ok: false, why: 'not a goober ID (goob-xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxx)' };
      const p = parseInt(m[1], 16) >>> 0, c = parseInt(m[2], 16) >>> 0, e = parseInt(m[3], 16) >>> 0;
      if (idCheck(p, c, e) !== parseInt(m[4], 16)) return { ok: false, why: 'check code doesn\'t match (typo?)' };
      const col = p & 7, row = (p >>> 3) & 7, sw = c & 127, ty = e & 3, fav = (e >>> 2) & 31;
      if (col > 4 || row > 4 || sw >= Object.keys(SWATCHES).length || fav >= Object.keys(MOODS).length) return { ok: false, why: 'made by a newer goober (unknown values)' };
      return { ok: true, col, row, swatch: Object.keys(SWATCHES)[sw], type: Object.keys(TYPES)[ty], dna: {
        blinkRate: (p >>> 6) & 15, blinkSpeed: (p >>> 10) & 7, moodLen: (p >>> 13) & 15, restless: (p >>> 17) & 15, dbl: (p >>> 21) & 7, salt: p >>> 24,
        batch: c >>> 7, fav, sig: (e >>> 7) & 15, eyeSize: (e >>> 11) & 7, pupilSize: (e >>> 14) & 7, serial: e >>> 17 } };
    }
    setId(str) {
      const r = Goober.parseId(str); if (!r.ok) return r;
      Object.assign(this.dna, r.dna); this.setLook(r.type, r.swatch); this.setPersonality(r.col, r.row, true);
      this.setMood(this._pickMood()); this._apply(this.exprName); this._emit('goober ' + this.id); return r;
    }
    _rollDna() {
      const R = (n) => Math.floor(rnd() * n);
      Object.assign(this.dna, { blinkRate: R(16), blinkSpeed: R(8), moodLen: R(16), restless: R(16), dbl: R(8), salt: R(256), batch: R(1 << 25),
        fav: R(Object.keys(MOODS).length), sig: R(SIGNATURES.length), eyeSize: R(8), pupilSize: R(8), serial: R(1 << 15) });
    }
    // a brand-new goober: look by rarity, personality 1 in 25, the rest of its DNA at random
    rollGoober() {
      this._rollDna(); this.rollLook(); this.rollPersonality(true); this.setMood(this._pickMood()); this._apply(this.exprName);
      return this.id;
    }
    _actWeight(n) {
      const m = META[n] || {}, p = this.pers, sig = SIGNATURES[this.dna.sig % SIGNATURES.length];
      return Math.exp(1.1 * p.y * (FEIST[m.face] || 0)) * Math.exp(0.8 * p.x * ((m.energy || 2) - 2)) * (n.startsWith(sig + '.') ? 3 : 1);
    }
    _pickAct(list) {
      if (!list || !list.length) return 'greet';
      let tot = 0; const w = list.map((n) => (tot += this._actWeight(n)));
      const r = rnd() * tot; for (let i = 0; i < list.length; i++) if (r <= w[i]) return list[i];
      return list[list.length - 1];
    }
    _pickMood(not) {
      const c = this.moodChances(not); let r = rnd();
      for (const m in c) { r -= c[m]; if (r <= 0) return m; }
      return Object.keys(c)[0];
    }
    // ── repeated things pull the mood: each event nudges one mood; nudges fade (≈10 min); enough of them flips it
    nudge(mood, amount, why) {
      if (!MOODS[mood]) return;
      this.pull[mood] = (this.pull[mood] || 0) + amount;
      if (mood !== this.mood && this.pull[mood] >= 3) {
        this.pull = {};
        this._emit('mood pulled → ' + mood + (why ? ' (' + why + ')' : ''));
        this.setMood(mood);
        const show = { happy: 'beam', grumpy: 'huff', sleepy: 'yawn', playful: 'giggle', hyper: 'laugh', dreamy: 'hearts', curious: 'idea', shy: 'bashful', sassy: 'proud', calm: 'slowBlink', cuddly: 'nuzzle.2.left.adore', silly: 'derpOut.2.googly', anxious: 'fret.left', proud: 'chinUp.long.smug', busy: 'work.3', bored: 'zoneOut.long.halfLid', sulky: 'pout.long.grumpy', cozy: 'snuggleDown.long.content' }[mood];
        if (show && ACTS[show] && !(this.imu && this.imu.dizzy)) this.after(0.6, () => { if (!this.seq && this.mode === 'awake') this._act(show); });
      }
    }
    get moodPull() { return Object.assign({}, this.pull); }
    setMood(name) { if (!MOODS[name]) return; this.mood = name; this.moodUntil = this.t + rr(3600, 10800) * this.pers.moodLen; this.idleFace = null; this.idleFaceUntil = this.t + rr(20, 40); this.nextAct = this.t + rr(6, 12); this._emit('mood → ' + name); }
    after(sec, fn) { this._tm.push({ at: this.t + sec, fn }); }

    // ── body helpers the animations use
    pop(sy) { for (const e of this.eyes) { e.s.sy.v += sy; e.s.sx.v -= sy * 0.6; } }          // squash (−) / stretch (+)
    squish(sy) { this.pop(sy); }
    wobble(a) { for (const e of this.eyes) e.wobble(a); }
    kick(vx, vy) { this.g.ox.v += vx; this.g.oy.v += vy; }
    roll(dir) { this.g.pitch.t -= dir * TAU; }   // +1: up over the top and back in from the bottom
    spin(dir) { this.g.spin.t += dir * TAU; }
    hide(p) { this.g.pitch.t = clamp(p, -0.42, 0.42); } // duck towards an edge, but never leave the screen
    _tiltOnce(v) { this.g.rotAll.t = v; this._stepTilt = v; }
    _groove(d) { this.grooveUntil = this.t + d; }
    zoom(z) { this.g.zoom.t = z; }
    showFill() { const b = this.sense.battery; for (const e of this.eyes) { e.s.fill.x = 0; e.s.fill.t = b; } }
    // ── arm lights: 3 RGB LEDs in a line on the top-right arm (index 0 = nearest the screen). Hardware: SK6812MINI-E
    //    chain on GPIO5, power switch on GPIO6 (switch off whenever all three are black). A battery gauge in the
    //    goober's own eye colour, shown while charging and for 4 s after a 👍: each LED is a third of the battery and
    //    glows brighter as its third fills (33 % = first full, 50 % = first full + second half); at 20 % or less the
    //    innermost one is red. Returns [[r, g, b] x 3].
    armLights() {
      const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], E = this.sense;
      if (!E.charging && !(this.t < (E.lightsUntil || 0))) return out;
      const b = clamp(E.battery, 0, 1), MAX = 0.45;          // dim: they sit right next to the screen
      for (let i = 0; i < 3; i++) {                            // each LED is a third: 50 % = first full, second half
        const k = clamp(b * 3 - i, 0, 1) * MAX;
        const col = i === 0 && b <= 0.2 ? [255, 40, 30] : PAL.eye;       // 20 % or less: the innermost one goes red
        out[i] = col.map((c) => Math.round(c * k));
      }
      return out;
    }
    // blink curve measured from the reference recording: the lid starts slow and snaps shut (~170 ms), stays shut
    // ~60–170 ms, then lifts and eases out (~500 ms). `slow` stretches it (sleepy blinks).
    blink(slow) {
      const k = Math.max(0.6, slow || 1), hold = rr(0.06, 0.17) * k;
      for (const e of this.eyes) {
        if (!e.blinkOK) continue;
        e.bl = { t0: this.t, close: 0.17 * k, hold, open: 0.5 * k };
        e.blinkUntil = this.t + e.bl.close + hold; e.openUntil = e.blinkUntil + e.bl.open;
      }
    }
    _blinkAmount(e) {
      const b = e.bl; if (!b) return 0;
      const u = this.t - b.t0;
      if (u < 0) return 0;
      if (u < b.close) return Math.pow(u / b.close, 1.3);                 // ease-in: slow start, snap shut
      if (u < b.close + b.hold) return 1;
      const v = (u - b.close - b.hold) / b.open;
      if (v < 1) return Math.pow(1 - v, 1.2);                              // quick lift, eased landing
      e.bl = null; return 0;
    }
    _blink(s) { this.blink(s); }
    _squish(a) { this.pop(a); }

    play(steps, name) {
      if (this.locked || (this.imu && this.imu.dizzy)) return;
      this._resetBall();
      this.seq = steps; this.seqI = 0; this.seqT = this.t; this.seqName = name || '';
      this._startStep(steps[0]);
    }
    _startStep(st) {
      if (st.zoom !== undefined) this.g.zoom.t = st.zoom;
      if (st.turn !== undefined) this.g.spin.t = Math.round(this.g.spin.t / TAU) * TAU + st.turn;
      if (st.blink) this.blink(typeof st.blink === 'number' ? st.blink : 1);
      if (st.run) st.run();
      const z = st.size !== undefined || st.sizeL !== undefined || st.sizeR !== undefined || st.lift !== undefined || st.pupil !== undefined;
      if (z || this._stepSize) { this._stepSize = z ? st : null; this._reapply = true; }
      this._stepTilt = st.tilt;
      if (st.tilt !== undefined) this.g.rotAll.t = st.tilt;
    }
    _act(name) { const M = MOODS[this.mood]; this.play(ACTS[name](this, this.idleFace || M.rest), name); }
    _resetBall() {
      const G = this.g;
      G.zoom.t = 1; this._stepTilt = undefined; G.rotAll.t = this.expr.rotAll || 0;
      if (this._stepSize) { this._stepSize = null; this._reapply = true; }
      for (const k of ['pitch', 'spin']) { const s = G[k]; s.t = Math.round(s.t / TAU) * TAU; }
    }

    // ── face → spring targets
    _apply(name) {
      const X = FACES[name] || FACES.neutral;
      this.exprName = name; this.expr = X;
      for (const e of this.eyes) {
        const side = e.side < 0 ? X.L : X.R;
        const P = Object.assign({}, DEF, X, side || {});
        const Z = this._stepSize, Q = this.pers;
        let kx = Q.kx, ky = Q.ky;
        if (Z) for (const v of [Z.size, e.side < 0 ? Z.sizeL : Z.sizeR]) { if (v == null) continue; if (typeof v === 'number') { kx *= v; ky *= v; } else { kx *= v[0]; ky *= v[1]; } }
        if (!(P.shut > 0.9)) { P.sx *= kx; P.sy *= ky; }
        P.pr += Q.pr + ((Z && Z.pupil) || 0); P.y += (Z && Z.lift) || 0; P.tilt += Q.tilt;
        e.base = P;
        profile(P, e.inner, e.rt);
        const s = e.s;
        s.sx.t = P.sx; s.sy.t = P.sy; s.bend.t = P.bend; s.rot.t = (P.tilt + P.rot) * e.inner;
        s.pr.t = P.pr; s.ex.t = P.x * e.inner; s.ey.t = P.y;
        s.heart.t = P.heart; s.star.t = P.star; s.shut.t = P.shut; s.arc.t = P.arc; s.shine.t = P.shine; s.glow.t = P.glow;
        if (name !== 'battery') s.fill.t = 1;
        e.blinkOK = (side && side.blink === false) || X.blink === false ? 0 : 1;
        const T = TYPES[this.look.type]; e.pinT = P.pin + T.pin; e.pvT = P.pv + T.pv;
        s.pu.t = P.pu + e.pinT * e.inner + this.gaze[0] * 0.08; s.pv.t = e.pvT + this.gaze[1] * 0.07;
      }
      this.g.rotAll.t = this._stepTilt !== undefined ? this._stepTilt : X.rotAll || 0;
      const lid = X.lid || [-110, 0, 0];
      this.g.lidY.t = lid[0]; this.g.lidK.t = lid[1]; this.g.lidS.t = lid[2];
      if (X.look) this.nextSac = this.t;
      this.fxT = {};
    }

    // ───────────────────────────── update ─────────────────────────────
    update(dt, input) {
      dt = Math.min(dt, 0.05);
      this.t += dt;
      input = input || {};
      if (this.t >= this.moodUntil) this.setMood(this._pickMood(this.mood));
      { const k = Math.exp(-dt / 600); for (const m in this.pull) { this.pull[m] *= k; if (this.pull[m] < 0.02) delete this.pull[m]; } }
      this._button(!!input.btn);
      this._imu(input.imu || { x: 0, y: -1, z: 0 }, dt);
      this._senses(input, dt);
      this._brain();
      this._behaviour(dt);
      this._particles(dt);
      const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
      for (let k = 0; k < n; k++) {
        for (const e of this.eyes) { for (const key in e.s) e.s[key].step(h); e.stepRadii(h, this.slosh.x, this.slosh.y, this.t); }
        for (const key in this.g) this.g[key].step(h, key === 'ox' ? this.force.x : key === 'oy' ? this.force.y : 0);
      }
      const G = this.g;
      G.ox.x = clamp(G.ox.x, -36, 36); G.oy.x = clamp(G.oy.x, -36, 36);
      for (const k of ['pitch', 'spin']) {
        const s = G[k];
        if (Math.abs(s.t) >= TAU - 1e-6 && Math.abs(s.x - s.t) < 0.02 && Math.abs(s.v) < 0.05) { const w = Math.round(s.t / TAU) * TAU; s.x -= w; s.t -= w; }
      }
      this.floatY = FLOAT_A * Math.sin((TAU * this.t) / FLOAT_T) * (this.mode === 'asleep' ? 0.5 : 1); // eyes and lids float together
      this._plane();
      for (const e of this.eyes) this._resolve(e, dt);
      this._powerPlan(dt);
      const F = this.F;
      F.y = G.lidY.x + this.floatY; F.k = G.lidK.x / 10000; F.sk = G.lidS.x / 100; F.on = G.lidY.x > -100;
    }

    // ── one button: tap / double tap / hold
    _button(down) {
      const B = this.btn, t = this.t;
      if (down && !B.down) { B.down = true; B.t0 = t; B.long = false; this.lastInput = t; this.pop(-1.6); }
      else if (!down && B.down) { B.down = false; this.pop(1.2); if (!B.long && t - B.t0 < 0.4) { B.taps++; B.lastTap = t; } }
      const held = B.down ? t - B.t0 : 0;
      this.g.hold.t = B.down && !B.long ? sstep(0.3, 0.95, held) : 0;
      if (B.down && !B.long && held > 0.95) { B.long = true; this.g.hold.t = 0; this.mode === 'asleep' ? this._wake() : this._sleep('hold → sleep'); }
      if (B.taps && this.imu.dizzy) B.taps = 0;
      if (B.taps && !B.down && t - B.lastTap > 0.3 && (this.imu.S || 0) < 0.3) { const n = B.taps; B.taps = 0; n === 1 ? this._onTap() : this._onDouble(); }
    }
    _onTap() {
      const t = this.t;
      this.locked = false;
      if (this.mode === 'asleep') {
        this.sleepPokes = this.sleepPokes.filter((x) => t - x < 4); this.sleepPokes.push(t);
        if (this.sleepPokes.length >= 2) this._wake(); else { this._emit('poke… still sleeping'); this.play([{ e: 'peek', d: 1.4 }], 'peek'); }
        return;
      }
      const B = this.btn; B.tapTimes = B.tapTimes.filter((x) => t - x < 3); B.tapTimes.push(t);
      if (B.tapTimes.length >= 6) { this.nudge('grumpy', 1.5, 'poked too much'); this._emit('poke poke poke → furious'); this.play([{ e: 'furious', d: 2.4 }, { e: 'grumpy', d: 2 }], 'furious'); return; }
      this.nudge(this.mood === 'shy' ? 'shy' : 'happy', 0.4, 'knocks'); const a = this._pickAct(MOODS[this.mood].tap); this._emit('knock → ' + a); this._act(a);
    }
    _onDouble() {
      this.locked = false;
      if (this.mode === 'asleep') { this._wake(); return; }
      this.nudge('playful', 0.6, 'double knocks'); const a = this._pickAct(MOODS[this.mood].dbl); this._emit('double knock → ' + a); this._act(a);
    }
    _sleep(msg) {
      this._emit(msg);
      this.play([{ e: 'drowsy', d: 1.2 }, { e: 'sleepy', d: 1.6 }, { e: 'asleep', d: 0.01, run: () => { this.mode = 'asleep'; } }], 'falling asleep');
    }
    _wake() {
      if (this.mode === 'asleep') this.nudge('grumpy', 0.9, 'woken up');
      this.mode = 'awake'; this.sleepPokes = []; this.lastInput = this.t; this.nextAct = this.t + rr(10, 20);
      this._emit('wakes up');
      this.play(this.mood === 'grumpy'
        ? [{ e: 'waking', d: 1.0 }, { e: 'grumpy', d: 2.4 }]
        : [{ e: 'waking', d: 1.1 }, { e: 'drowsy', d: 1.0 }, { e: 'neutral', d: 0.8, blink: true }], 'waking up');
    }

    // ── accelerometer
    _imu(a, dt) {
      const I = this.imu, t = this.t;
      const k = 1 - Math.exp(-dt / 0.6);
      I.lp.x += (a.x - I.lp.x) * k; I.lp.y += (a.y - I.lp.y) * k; I.lp.z += (a.z - I.lp.z) * k;
      const dx = a.x - I.lp.x, dy = a.y - I.lp.y, dz = a.z - I.lp.z;
      const dyn = Math.hypot(dx, dy, dz), mag = Math.hypot(a.x, a.y, a.z);
      I.E += (dyn * dyn - I.E) * (1 - Math.exp(-dt / 0.5));
      // being carried (swinging on a carabiner while you walk): sustained gentle motion for a few seconds
      I.carryT = I.E > 0.015 && I.E < 0.8 && !I.falling ? Math.min(6, (I.carryT || 0) + dt) : Math.max(0, (I.carryT || 0) - dt * 0.5);
      if (!I.carried && I.carryT > 3) { I.carried = true; this._emit('being carried → steadies its eyes'); }
      if (I.carried && I.carryT < 0.5) { I.carried = false; this._emit('set down'); }
      const sway = I.carried ? 0.3 : 1; // calm eyes while walking (also fewer redraws)
      this.force.x = -dx * 2600 * sway; this.force.y = -dy * 2600 * sway;
      this.slosh.x = clamp(dx * sway, -3, 3); this.slosh.y = clamp(dy * sway, -3, 3);
      const gx = -I.lp.x, gy = -I.lp.y;
      if (Math.hypot(gx, gy) > 0.35) this.g.tilt.t = clamp(-Math.atan2(gx, gy) * 0.85, -1.25, 1.25); else this.g.tilt.t *= 0.98;
      if (dyn > 0.15) this.lastInput = t;
      if (this.locked) return;
      if (mag < 0.35) { I.ffT += dt; if (I.ffT > 0.12 && !I.falling) { I.falling = true; I.fallT0 = t; this.btn.taps = 0; I.carryT = 0; this._emit('wheee (free fall)'); this.seq = null; this._resetBall(); } }
      else {
        I.ffT = 0;
        if (I.falling && mag > 0.7) {
          I.falling = false; const air = t - I.fallT0;
          // the low-pass drifted toward 0 g in the air: re-seat it on the new "down", or the landing reads as a bump + shake
          I.lp = { x: a.x / mag, y: a.y / mag, z: a.z / mag }; I.E = 0; I.S = 0; I.shakeT = 0; I.carryT = 0; I.lastJolt = t; I.patArmed = true;
          this.pop(-4);
          if (this.mode === 'asleep') this._wake();
          else if (air > 0.65) { this.nudge('grumpy', 1, 'dropped'); this._emit('hard landing → tumble'); this._act('tumble'); }
          else { this.nudge('hyper', 1, 'tossed'); this._emit('caught! → starstruck'); this.play([{ e: 'starstruck', d: 2.2 }], 'caught'); }
          return;
        }
      }
      if (I.falling) return;
      // shaking: a fast "shake energy" so dizzy starts within ~¼ s, lasts while you shake, and fades 2 s after you stop
      I.S = (I.S || 0) + (dyn * dyn - (I.S || 0)) * (1 - Math.exp(-dt / 0.12));
      if (I.S > 0.9) I.shakeT += dt; else I.shakeT = Math.max(0, I.shakeT - dt);
      if (!I.dizzy && I.shakeT > 0.22) { // starts while still shaking
        I.dizzy = true; I.dizzyStart = t; this.mode = 'awake'; this.seq = null; this.locked = false; this._resetBall();
        I.dizzyTimes = I.dizzyTimes.filter((x) => t - x < 25); I.dizzyTimes.push(t);
        this.btn.taps = 0; this.nudge('grumpy', 1.1, 'shaken'); this._emit('shaking → dizzy'); this.pop(2);
      }
      if (I.dizzy) {
        if (I.S > 0.5) I.shakeEnd = t;                      // still being shaken
        if (t - (I.shakeEnd || t) > 2) {                      // 2 s after the shaking stopped
          I.dizzy = false; I.shakeT = 0;
          if (I.dizzyTimes.length >= 3) { this._emit('shaken again → furious'); this.play([{ e: 'furious', d: 2.4 }, { e: 'grumpy', d: 2 }], 'mad'); }
          else this.play([{ e: 'wince', d: 0.6 }, { e: 'drowsy', d: 0.8 }], 'recovering');
        }
        return;
      }
      // a tap on the body: short knock, not a shake, not a big bump
      if (dyn > (I.carried ? 1.1 : 0.55) && dyn < 2.2 && I.E < 0.6 && t - (I.lastPat || -9) > 0.16 && !I.patArmed) {
        I.lastPat = t; I.patArmed = true; this.lastInput = t; this.pop(-1.2);
        const B = this.btn; B.taps++; B.lastTap = t;
      }
      if (dyn < 0.25) I.patArmed = false;
      if (dyn > 2.2 && I.E < 0.8 && t - I.lastJolt > 1.5 && t - (I.shakeEnd || -9) > 3) {
        I.lastJolt = t; this.nudge('grumpy', 0.4, 'bumped'); this._emit('bump!');
        if (this.mode === 'asleep') this._wake(); else this._act('startle');
      }
      if (gy < -0.6) I.upT += dt; else I.upT = 0;
    }

    // ── camera / mic / temperature / battery
    _senses(input, dt) {
      const E = this.sense, t = this.t, k = 1 - Math.exp(-dt / 2);
      const temp = typeof input.temp === 'number' ? input.temp : 21, loud = typeof input.loud === 'number' ? input.loud : 0;
      const light = typeof input.light === 'number' ? input.light : 0.6;
      if (typeof input.battery === 'number') E.battery = input.battery;
      const plug = !!input.charging;
      if (plug && !E.charging) { this._emit('plugged in → wall-eyed, screen dims to 20 % and holds the frame'); E.busyUntil = this.t; }
      E.charging = plug;
      E.cold += ((temp < 10 ? 1 : 0) - E.cold) * k; E.hot += ((temp > 31 ? 1 : 0) - E.hot) * k;
      const bang = loud - E.loudSlow; E.loud += (loud - E.loud) * (1 - Math.exp(-dt / 0.15)); E.loudSlow += (loud - E.loudSlow) * k;
      const flash = light - E.light, prevLight = E.light; E.light += (light - E.light) * (1 - Math.exp(-dt / 1.2));
      E.cool = E.cool || 0;
      E.dark = light < 0.08 ? E.dark + dt : 0;
      const awake = this.mode === 'awake';
      // someone in view: attention follows them (slowly, holding between moves)
      const seen = input.seen || null;
      E.attnUntil = E.attnUntil || 0; E.nextAttn = E.nextAttn || t + rr(15, 40);
      if (seen) {
        if (!E.seen && t - E.lastSeen > 25 && awake && !this.seq) { this._emit('someone appears → greets'); this._act('greet'); E.attnUntil = t + rr(4, 7); }
        if (t > E.nextAttn && awake) { E.attnUntil = t + rr(3, 6); E.nextAttn = t + rr(20, 60) / MOODS[this.mood].sac; this._emit('notices you for a moment'); }
        if (!E.seen) E.seenSince = t;
        E.seen = seen; E.lastSeen = t; this.lastInput = t;
        if (t - E.seenSince > 45 && t > (E.nextWatchNudge || 0)) { E.nextWatchNudge = t + 45; this.nudge(this.mood === 'shy' || this.mood === 'calm' ? 'shy' : 'curious', 0.8, 'being watched'); }
      } else E.seen = null;
      // camera gestures
      const gst = input.gesture;
      if (gst) {
        this.lastInput = t; this.locked = false;
        if (this.mode === 'asleep') this._wake();
        else {
          const M = this.mood, heartPool = this.actNames.filter((n) => /^(love|starstruck)\./.test(n) || n === 'hearts');
          const map = { wave: this._pickAct(MOODS[M].hello), thumbsup: pick(['blink.wink', 'blink.winkRight']), flick: M === 'grumpy' || M === 'sassy' ? pick(['glare.quick.angry', 'eyeRoll.cw.grumpy', 'hurt']) : 'hurt', heart: pick(heartPool), peace: pick(['blink.winkRight', 'blink.wink', 'react.wink.hop']), fist: 'determinedNod' };
          const a = map[gst];
          if (gst === 'wave') E.attnUntil = t + rr(8, 14);
          if (gst === 'thumbsup') { E.lightsUntil = t + 4; this._emit('👍 → arm lights show the battery'); }
          const pullOf = { wave: ['happy', 0.8], heart: [this.mood === 'shy' ? 'shy' : 'dreamy', 1], peace: ['playful', 0.7], fist: ['hyper', 0.8], flick: ['grumpy', 1.5] }[gst];
          if (pullOf) this.nudge(pullOf[0], pullOf[1], gst + 's');
          if (a === 'determinedNod') { this._emit('fist bump → determined'); this.play([{ e: 'determined', d: 1.4, run: () => this.kick(0, 120) }, { e: 'softSmile', d: 1 }], 'fist bump'); }
          else if (a) { this._emit('gesture ' + gst + ' → ' + a); this._act(a); }
        }
      }
      // covering the camera = peekaboo
      if (!E.covered && light < 0.04 && prevLight > 0.2) { E.covered = true; E.coverT = t; if (awake) { this._emit('camera covered → where did you go?'); this._act('whereDidYouGo'); } }
      if (E.covered && light > 0.2) { E.covered = false; E.cool = t + 3; if (awake && t - E.coverT < 6) { this.nudge('playful', 1, 'peekaboo'); this._emit('peekaboo!'); this._act('peekabooFound'); return; } }
      if (!awake) { if ((bang > 0.5 || flash > 0.5) && t > E.cool) { E.cool = t + 4; this._emit('woken by the world'); this._wake(); } return; }
      // sudden noise / light
      if (bang > 0.5 && t > E.cool) { E.cool = t + 3; this.nudge('grumpy', 0.5, 'loud bangs'); this._emit('BANG → startled'); this._act('startle'); return; }
      if (flash > 0.45 && !E.covered && t > E.cool) { E.cool = t + 5; this._emit('bright light → squints'); this._act('blinded'); return; }
      if (E.dark > 20 && !this.seq) { this.nudge('sleepy', 1.2, 'dark'); this._sleep('dark → sleeps'); E.dark = 0; return; }
      if (this.seq || t < E.nextEnv) return;
      if (E.loudSlow > 0.65) { this.nudge('grumpy', 0.8, 'too loud'); this._emit('too loud → nervous'); this.play([{ e: 'nervous', d: 3 }], 'too loud'); E.nextEnv = t + rr(10, 18); }
      else if (E.loudSlow > 0.3 && !(this.mood === 'happy' || this.mood === 'hyper' || this.mood === 'dreamy')) { this.nudge('happy', 0.7, 'music'); E.nextEnv = t + rr(8, 14); }
      else if (E.loudSlow > 0.3 && (this.mood === 'happy' || this.mood === 'hyper' || this.mood === 'dreamy')) { this.nudge('hyper', 0.5, 'music'); this._emit('music → grooves'); this._act(pick(this.actNames.filter((n) => n.startsWith('groove.')).concat('groove'))); E.nextEnv = t + rr(12, 20); }
      else if (E.cold > 0.6) { this.nudge('sleepy', 0.6, 'cold'); this._emit('cold → shivers'); this.play([{ e: 'nervous', d: 2.6 }], 'cold'); E.nextEnv = t + rr(14, 24); }
      else if (E.hot > 0.6) { this.nudge('sleepy', 0.7, 'heat'); this._emit('hot → wilting'); this.play([{ e: 'sleepy', d: 3, run: () => this.spawn('drop', 192, 52, { s: 6, vy: 6, ay: 50, life: 1.6 }) }], 'hot'); E.nextEnv = t + rr(16, 26); }
      else if (E.battery < 0.12 && !E.charging) { this._emit('battery low → drowsy'); this._act('yawn'); E.nextEnv = t + rr(20, 40); }
    }

    // ── what to do right now
    _brain() {
      const t = this.t, M = MOODS[this.mood], idle = t - this.lastInput;
      if (this.seq) {
        const st = this.seq[this.seqI];
        if (t - this.seqT >= st.d) {
          this.seqI++; this.seqT = t;
          if (this.seqI >= this.seq.length) { this.seq = null; this.locked = false; this._resetBall(); this.nextAct = t + rr(M.every[0], M.every[1]) * this.pers.tempo; }
          else this._startStep(this.seq[this.seqI]);
        }
      }
      let face;
      if (this.seq) face = this.seq[this.seqI].e;
      else if (this.imu.dizzy) face = 'dizzy';
      else if (this.imu.falling) face = 'wheee';
      else if (this.mode === 'asleep') {
        face = 'asleep';
        if (t >= this.nextAct) { this.nextAct = t + rr(20, 45); if (rnd() < 0.4) this.play([{ e: 'dreaming', d: rr(2, 4) }], 'dreaming'); }
      } else if (this.sense.charging) face = 'walleyed';      // plugged in: holds a derpy wall-eyed stare (reactions still play)
      else if (this.imu.upT > 1.2) face = 'upside';
      else if (this.mood === 'sleepy' && idle > 900 && !this.imu.carried) { this.nudge('sleepy', 1.5, 'left alone'); this._sleep('nobody around → dozes off'); face = 'drowsy'; }
      else if (t >= this.nextAct) { this._act(this._pickAct(M.acts)); face = this.seq ? this.seq[0].e : M.rest; }
      else {
        if (t > this.idleFaceUntil) { // settle into the mood's faces for long stretches
          const resting = !this.idleFace || this.idleFace === M.rest;
          this.idleFace = resting && rnd() < 0.6 ? pick(M.faces) : M.rest;
          this.idleFaceUntil = t + (this.idleFace === M.rest ? rr(15, 40) : rr(10, 25));
        }
        face = this.idleFace || M.rest;
      }
      if (face !== this.exprName || this._reapply) { this._reapply = false; this._apply(face); }
    }

    // eyes move together; big moves usually happen through a blink (like the reference)
    _setGaze(x, y, blinkChance) {
      const dist = Math.hypot(x - this.gaze[0], y - this.gaze[1]);
      this.gaze = [x, y];
      if (dist > 0.5 && rnd() < (blinkChance === undefined ? 0.65 : blinkChance)) this.blink(1);
      for (const e of this.eyes) {
        e.s.x.t = x; e.s.y.t = y;
        e.s.pu.t = e.base.pu + (e.pinT ?? e.base.pin) * e.inner + x * 0.08; e.s.pv.t = (e.pvT ?? e.base.pv) + y * 0.07; // the card turns; pupils barely move on their own
      }
    }

    _behaviour(dt) {
      const t = this.t, X = this.expr, fx = X.fx || [], M = MOODS[this.mood], E = this.sense;
      const step = this.seq && this.seq[this.seqI];
      if (step && step.look) { if (this.gaze[0] !== step.look[0] || this.gaze[1] !== step.look[1]) this._setGaze(step.look[0], step.look[1], step.blink ? 0 : 0.4); this.nextSac = t + 1; }
      else if (t >= this.nextSac) {
        if (X.look) { this._setGaze(X.look[0], X.look[1]); this.nextSac = t + rr(3, 6); }
        else if (this.mode === 'asleep') { this._setGaze(0, 0, 0); this.nextSac = t + 3; }
        else if (E.seen && !this.seq && t < E.attnUntil) { this._setGaze(clamp(E.seen.x, -0.9, 0.9) * 0.85, clamp(E.seen.y, -0.8, 0.8) * 0.7, 0.3); this.nextSac = t + rr(0.6, 1.2); }
        else {
          if (rnd() < 0.55) this._setGaze(rr(-0.18, 0.18), rr(-0.12, 0.12));
          else this._setGaze(rr(-0.8, 0.8), rr(-0.5, 0.45));
          this.nextSac = t + (rr(2, 6) / M.sac) * this.pers.tempo * this.pers.sacK;
        }
      }
      if (!this.seq && this.mode === 'awake' && t >= (this.nextFidget || 0)) this._fidget();
      const slow = (fx.includes('slowblink') ? 1.6 : 1) * (this.mode === 'awake' ? M.blink : 1);
      if (this.mode === 'awake' && t >= this.nextBlink) {
        const Q = this.pers;
        this.blink((slow > 1.3 ? 2 : 1) * Q.blinkSlow);
        if (rnd() < Q.dbl) this.after(0.28 * Q.blinkSlow, () => this.blink(Q.blinkSlow));
        this.nextBlink = t + rr(2.5, 6.5) * slow * Q.blinkGap;
      }
      if (fx.includes('roll')) for (const e of this.eyes) { e.s.pu.t = Math.cos(t * 4 * e.side) * 0.42; e.s.pv.t = Math.sin(t * 4 * e.side) * 0.42; }
      const due = this._tm.filter((x) => t >= x.at); this._tm = this._tm.filter((x) => t < x.at); for (const x of due) x.fn();
      for (const e of this.eyes) { // blinks like the reference: a flat lid sweeps down to a thin ‿ at the bottom, then lifts
        const s = e.s;
        s.shut.t = Math.max(e.base.shut, e.fidShut || 0); s.shut.f = 2; s.shut.z = 1; // blinks are drawn on top (see _blinkAmount)
      }
      const every = (key, sec, fn) => { this.fxT[key] = (this.fxT[key] || 0) + dt; if (this.fxT[key] >= sec) { this.fxT[key] -= sec; fn(); } };
      const R0e = this.eyes[0].R, R1e = this.eyes[1].R;
      if (fx.includes('zzz')) every('zzz', 2.2, () => this.spawn('z', 168, 80, { s: 5, vx: 10, vy: -16, life: 3, grow: 4, sway: 1 }));
      if (fx.includes('hearts')) every('hearts', 0.6, () => this.spawn('heart', rr(40, 200), rr(150, 178), { s: rr(5, 8), vy: -34, life: 2, sway: 1 }));
      if (fx.includes('sparkle')) every('sparkle', 0.45, () => this.spawn('spark', rr(30, 210), rr(40, 95), { s: rr(4, 7), life: 0.9, pop: 1, col: PAL.shine }));
      if (fx.includes('tears')) every('tears', 1.3, () => { const R = rnd() < 0.5 ? R0e : R1e; if (R.vis) this.spawn('drop', R.cx + R.side * 22, R.cy + 18, { s: 5, vy: 8, ay: 200, life: 1.2 }); });
      if (fx.includes('sweat')) every('sweat', 2.2, () => this.spawn('drop', 194, 54, { s: 6, vy: 6, ay: 50, life: 1.6 }));
    }

    // tiny slow changes while resting so the rest pose is never the same twice
    _fidget() {
      const t = this.t, G = this.g, hold = rr(2, 5), M = MOODS[this.mood];
      this.nextFidget = t + (rr(2.5, 6) / Math.sqrt(M.sac)) * this.pers.tempo;
      const kind = pick(['tilt', 'turn', 'turn', 'pupils', 'oneEye', 'oneEye', 'lean', 'size']);
      if (kind === 'tilt') { G.rotAll.t = (this.expr.rotAll || 0) + sgn() * rr(0.04, 0.09); this.after(hold, () => { if (!this.seq) G.rotAll.t = this.expr.rotAll || 0; }); }
      else if (kind === 'turn') { const v = sgn() * rr(0.12, 0.28); G.spin.t = Math.round(G.spin.t / TAU) * TAU + v; this._setGaze(clamp(this.gaze[0] + v * 1.2, -0.9, 0.9), this.gaze[1], 0.2); this.after(hold, () => { if (!this.seq) G.spin.t = Math.round(G.spin.t / TAU) * TAU; }); }
      else if (kind === 'pupils') { const d = rr(-0.07, 0.08); for (const e of this.eyes) e.s.pr.t = e.base.pr + d; this.after(hold, () => { for (const e of this.eyes) e.s.pr.t = e.base.pr; }); }
      else if (kind === 'oneEye') { const e = pick(this.eyes), big = rnd() < 0.5; if (big) { e.s.sx.t = e.base.sx * 1.07; e.s.sy.t = e.base.sy * 1.1; } else { e.s.sx.t = e.base.sx * 0.96; e.s.sy.t = e.base.sy * 0.92; } this.after(hold, () => { e.s.sx.t = e.base.sx; e.s.sy.t = e.base.sy; e.fidShut = 0; }); }
      else if (kind === 'lean') { G.zoom.t = rr(0.94, 1.07); this.after(hold, () => { if (!this.seq) G.zoom.t = 1; }); }
      else { const k = rr(0.95, 1.05); for (const e of this.eyes) e.s.sy.t = e.base.sy * k; this.after(hold, () => { for (const e of this.eyes) e.s.sy.t = e.base.sy; }); }
    }

    spawn(type, x, y, o) {
      if (this.parts.length > 40) return;
      this.parts.push(Object.assign({ type, x, y, vx: 0, vy: 0, ay: 0, s: 6, age: 0, life: 1.5, col: PAL.accent, grow: 0, pop: 0, sway: 0, ph: rnd() * TAU }, o));
    }
    _particles(dt) {
      for (const p of this.parts) { p.age += dt; p.vy += p.ay * dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.sway) p.x += Math.sin(p.age * 2 + p.ph) * 12 * dt; }
      this.parts = this.parts.filter((p) => p.age < p.life);
    }

    // ── the face is one flat card in 3D: both eyes, pupils and lids live on it. Looking around rotates the card
    //    (yaw + pitch) and perspective does the rest: the near eye grows, the far one shrinks, both turn into tilted ovals.
    _plane() {
      const G = this.g, P = this.P || (this.P = {}), t = this.t, s0 = this.eyes[0].s, asleep = this.mode === 'asleep';
      const drift = asleep ? 0 : 1;
      const gx = clamp(s0.x.x + noise(t * 0.22 + 3) * 0.04 * drift, -1.4, 1.4), gy = clamp(s0.y.x + noise(t * 0.19 + 17) * 0.04 * drift, -1.4, 1.4);
      // never quite still: the whole face slowly drifts and rolls a few degrees (as in the reference recording)
      const dY = noise(t * 0.16 + 5) * 0.07 * drift, dP = noise(t * 0.13 + 11) * 0.05 * drift, dR = noise(t * 0.14 + 23) * 0.06 * drift;
      const yaw = -(gx * 0.62 + G.spin.x) + dY, pitch = gy * 0.45 - G.pitch.x * 0.8 + dP;
      const cY = Math.cos(yaw), sY = Math.sin(yaw), cP = Math.cos(pitch), sP = Math.sin(pitch);
      P.ax = cY; P.ay = 0; P.az = -sY;                    // card's x axis in the world
      P.bx = sY * sP; P.by = cP; P.bz = cY * sP;          // card's y axis
      P.nx = cP * sY; P.ny = -sP; P.nz = cY * cP;         // card's normal
      P.D = 300; P.f = 300; P.np0 = P.D * P.nz;           // camera distance = focal length → no scaling when facing us
      P.zoom = G.zoom.x;
      P.tx = gx * 16; P.ty = gy * 12 + 140 * Math.sin(G.pitch.x);
      const roll = G.tilt.x + G.rotAll.x + gx * 0.06 + dR;
      P.cr = Math.cos(roll); P.sr = Math.sin(roll);
      P.ox = MID + G.ox.x; P.oy = MID + G.oy.x;
      P.vis = P.nz > 0.08;
      P.gx = gx;
      return P;
    }

    // ── final numbers for drawing this frame (eye geometry lives in card space, in px)
    _resolve(e, dt) {
      const s = e.s, t = this.t, X = this.expr, fx = X.fx || [], R = e.R, side = e.side, G = this.g, P = this.P;
      const hold = clamp(G.hold.x, 0, 1), asleep = this.mode === 'asleep';
      const breath = Math.sin(t * (fx.includes('deepbreath') ? 1.0 : 1.5));
      let sy = s.sy.x * (1 - hold * 0.45) * (1 + breath * (asleep ? 0.05 : 0.006));
      if (sy < 0.12) sy = 0.06 + 0.06 * Math.exp((sy - 0.12) / 0.06);
      let sx = s.sx.x * (1 + hold * 0.08);
      sx *= 1 + 0.08 * (1 - clamp(sy, 0, 1.4));
      // the float: the whole face bobs up and down in a slow sine, all the time (measured from the site recording:
      // period 2.85 s, ±6.1 px at 240 px, no sideways part, no size change); half as much while asleep
      const float = this.floatY;
      let ex = s.ex.x, ey = s.ey.x + float + (asleep ? breath * 2 : 0), rot = s.rot.x;
      if (fx.includes('bounce')) ey -= Math.abs(Math.sin(t * 4.5)) * 3;
      if (fx.includes('giggle')) ey -= Math.abs(Math.sin(t * 9)) * 2.5;
      if (fx.includes('tremble')) { ex += noise(t * 18) * 0.9; ey += noise(t * 19 + 50) * 0.9; }
      if (fx.includes('shiver')) ex += noise(t * 30) * 1.1;
      if (fx.includes('shake')) { ex += noise(t * 16) * 2; ey += noise(t * 17 + 9) * 1.4; }
      if (fx.includes('pulse')) { const p = (t * 1.0) % 1, bb = Math.exp(-((p / 0.08) ** 2)) + 0.6 * Math.exp(-(((p - 0.26) / 0.08) ** 2)); sx *= 1 + bb * 0.04; sy *= 1 + bb * 0.04; }
      if (fx.includes('sway') || t < (this.grooveUntil || 0)) { ex += Math.sin(t * 2.2) * 5; rot += Math.sin(t * 2.2) * 0.05; ey -= Math.abs(Math.cos(t * 2.2)) * 2; }
      if (fx.includes('orbit')) { const o = t * 3.5 + (side > 0 ? Math.PI : 0); ex += Math.cos(o) * 7; ey += Math.sin(o) * 5; rot += Math.sin(t * 2.5) * 0.15; }
      const bend = s.bend.x + hold * 0.22;
      R.pcx = side * SPACING + ex; R.pcy = ey;                     // eye centre on the card
      const sc0 = projectCard(P, R.pcx, R.pcy);
      const cx = sc0[0], cy = sc0[1];
      R.mag = sc0[2]; R.depth = -sc0[3]; R.vis = P.vis;
      if (dt > 0) { e.vel[0] = lerp(e.vel[0], (cx - e.pcx) / dt, 0.3); e.vel[1] = lerp(e.vel[1], (cy - e.pcy) / dt, 0.3); }
      e.pcx = cx; e.pcy = cy;
      const speed = Math.hypot(e.vel[0], e.vel[1]);
      R.st = Math.min(0.05, speed / 9000); R.sa = Math.atan2(e.vel[1], e.vel[0]);
      R.cx = cx; R.cy = cy; R.rot = rot; R.ax = R0 * Math.max(sx, 0.03); R.ay = R0 * Math.max(sy, 0.02); R.bend = bend; R.side = side;
      const pr = clamp(s.pr.x, 0.05, 0.9) * sstep(0.16, 0.4, sy) * (1 - sstep(0.8, 0.97, s.shut.x));
      let pu = s.pu.x, pv = s.pv.x; const m = Math.hypot(pu, pv), lim = 1 - pr * 0.2;
      if (m > lim) { pu *= lim / m; pv *= lim / m; }
      // parallax: the pupil sits ~PUPIL_DEPTH px *behind* the eye's surface, so when the face turns it travels a bit less
      // than the eye itself (like a pupil under a glass dome). Not a delay — pure depth through the same perspective.
      { const c = Math.cos(rot), sn = Math.sin(rot), ox0 = pu * R.ax, oy0 = pv * R.ay;
        const cu = R.pcx + ox0 * c - oy0 * sn, cv = R.pcy + ox0 * sn + oy0 * c;
        const q = behindCard(P, cu, cv, PUPIL_DEPTH), du = q[0] - cu, dv = q[1] - cv;
        pu += (du * c + dv * sn) / R.ax; pv += (-du * sn + dv * c) / R.ay; }
      R.pu = pu; R.pv = pv; R.pr = pr;
      R.heart = clamp(s.heart.x, 0, 1); R.star = clamp(s.star.x, 0, 1); R.spin = fx.includes('twirl') ? Math.sin(t * 1.4) * 0.4 : 0;
      R.type = TYPES[this.look.type];
      R.shut = Math.max(clamp(s.shut.x, 0, 1), this._blinkAmount(e)); R.arc = clamp(s.arc.x, -1, 1);
      R.shine = clamp(s.shine.x, 0, 1.2); R.glow = clamp(s.glow.x, 0, 1); R.fill = clamp(s.fill.x, 0, 1); R.t = t;
      return R;
    }

    // ───────────────────────────── render ─────────────────────────────
    render(buf, size) { // size: output pixels per side (default 240 = the real screen); everything is maths, so any size is crisp
      const W = size || SW;
      for (let i = 0; i < buf.length; i += 4) { buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255; }
      const order = this.eyes[0].R.depth <= this.eyes[1].R.depth ? [0, 1] : [1, 0];
      for (const i of order) if (this.eyes[i].R.vis) drawEye(buf, this.eyes[i], this.F, W, this.P);
      for (const p of this.parts) drawPart(buf, p, W);
    }
  }

  // card (u, v in px, relative to the face centre) → screen [x, y, px-per-card-px, depth]
  function projectCard(P, u, v) {
    u *= P.zoom; v *= P.zoom;
    const wx = P.ax * u + P.bx * v, wy = P.ay * u + P.by * v, wz = P.D + P.az * u + P.bz * v;
    const sx = (P.f * wx) / wz + P.tx, sy = (P.f * wy) / wz + P.ty;
    return [P.ox + sx * P.cr - sy * P.sr, P.oy + sx * P.sr + sy * P.cr, (P.f / wz) * P.zoom, wz];
  }

  // screen point → card (u, v) (the same ray–plane hit the renderer uses per pixel)
  function screenToCard(P, X, Y) {
    const dxs = X - P.ox, dys = Y - P.oy;
    const rx = dxs * P.cr + dys * P.sr - P.tx, ry = -dxs * P.sr + dys * P.cr - P.ty;
    const tt = P.np0 / (P.nx * rx + P.ny * ry + P.nz * P.f);
    const hx = tt * rx, hy = tt * ry, hz = tt * P.f - P.D;
    return [(P.ax * hx + P.ay * hy + P.az * hz) / P.zoom, (P.bx * hx + P.by * hy + P.bz * hz) / P.zoom];
  }
  // a point `depth` px behind the card at (u, v) → where it lands on the card when seen through the perspective (parallax)
  function behindCard(P, u, v, depth) {
    u *= P.zoom; v *= P.zoom; const dz = depth * P.zoom;
    const wx = P.ax * u + P.bx * v + P.nx * dz, wy = P.ay * u + P.by * v + P.ny * dz, wz = P.D + P.az * u + P.bz * v + P.nz * dz;
    const sx = (P.f * wx) / wz + P.tx, sy = (P.f * wy) / wz + P.ty;
    return screenToCard(P, P.ox + sx * P.cr - sy * P.sr, P.oy + sx * P.sr + sy * P.cr);
  }

  function drawEye(buf, e, F, W, P) {
    const sc = W / SW, E = e.R;
    let rmax = 0; for (let i = 0; i < N; i++) rmax = Math.max(rmax, e.r[i]);
    const halo = SHADE !== 'none' && E.glow > 0.02 ? 16 : 0;
    const ext = Math.max(E.ax, E.ay) * rmax * (1 + E.st) * 1.15 + Math.abs(E.bend) * R0 * 0.7 + 3 + halo / Math.max(E.mag, 0.2);
    // screen bounding box: project the card-space box around the eye
    let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const q = projectCard(P, E.pcx + u * ext, E.pcy + v * ext);
      bx0 = Math.min(bx0, q[0]); bx1 = Math.max(bx1, q[0]); by0 = Math.min(by0, q[1]); by1 = Math.max(by1, q[1]);
    }
    const x0 = Math.max(0, Math.floor(bx0 * sc) - 1), x1 = Math.min(W - 1, Math.ceil(bx1 * sc) + 1);
    const y0 = Math.max(0, Math.floor(by0 * sc) - 1), y1 = Math.min(W - 1, Math.ceil(by1 * sc) + 1);
    const cr = Math.cos(E.rot), sr = Math.sin(E.rot);
    const sa = E.sa - E.rot, cp = Math.cos(sa), sp = Math.sin(sa), k = 1 + E.st;
    const ax = E.ax, ay = E.ay, bend = E.bend, bendK = (R0 * 0.55) / ay;
    const pr = E.pr, wH = E.heart, wS = E.star, wD = Math.max(0, 1 - wH - wS), T = E.type, rnd2 = wH + wS;
    const prx = pr * PA * lerp(T.wx, 1, rnd2), pry = pr * lerp(T.wy, 1, rnd2);
    const pScale = Math.min(prx * ax, pry * ay) / k;
    const scs = Math.cos(E.spin), ssn = Math.sin(E.spin);
    const C = PAL.eye, PC = E.side > 0 && PAL.pupilR ? PAL.pupilR : PAL.pupil, WH = PAL.shine;
    const fillOn = E.fill < 0.995, fillY = 1 - 2 * E.fill;
    const ms = E.mag * sc; // card px → output px (for anti-aliasing)
    const zi = 1 / P.zoom, slopeL = F.on ? 2 * F.k * E.pcx + F.sk : 0, lidC = F.on ? F.y + F.k * E.pcx * E.pcx + F.sk * E.pcx : 0, lidN = Math.sqrt(1 + slopeL * slopeL);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // screen pixel → a ray → where it hits the card (exact perspective, still pure maths)
        const dxs = (x + 0.5) / sc - P.ox, dys = (y + 0.5) / sc - P.oy;
        const rx = dxs * P.cr + dys * P.sr - P.tx, ry = -dxs * P.sr + dys * P.cr - P.ty;
        const tt = P.np0 / (P.nx * rx + P.ny * ry + P.nz * P.f);
        const hx = tt * rx, hy = tt * ry, hz = tt * P.f - P.D;
        const cu = (P.ax * hx + P.ay * hy + P.az * hz) * zi, cv = (P.bx * hx + P.by * hy + P.bz * hz) * zi;
        let qx0 = cu - E.pcx, qy0 = cv - E.pcy;
        let qx = qx0 * cr + qy0 * sr, qy = -qx0 * sr + qy0 * cr;
        let a = qx * cp + qy * sp, b = -qx * sp + qy * cp;
        a /= k; b *= k; qx = a * cp - b * sp; qy = a * sp + b * cp;
        const ux = qx / ax; let uy = qy / ay;
        uy -= bend * (ux * ux - 0.35) * bendK;
        const L = Math.hypot(ux, uy);
        let d, rr0 = 1;
        if (L < 1e-4) d = -10;
        else { rr0 = e.radius(Math.atan2(uy, ux)); d = (L - rr0) / (Math.hypot(ux / (L * ax), uy / (L * ay)) * k); }
        if (E.shut > 0.004) { // the eyelid: flat, sweeping down from the top…
          d = Math.max(d, (-1.25 + E.shut * 2.12 - uy) * ay);
          const w = sstep(0.82, 1, E.shut);
          if (w > 0) { // …and fully shut it becomes a thin line: arc +1 → ‿ (asleep / blink), −1 → ^ (happy, wink)
            const c0 = 0.25 + 0.15 * E.arc, amp = 0.3 * E.arc, Xl = ux * ax, Yl = uy * ay, Ll = 0.78 * ax;
            const ye = ay * (c0 + 0.3916 * amp);
            const dl = sdBezier(Xl, Yl, -Ll, ye, 0, ye + 2 * 0.6084 * amp * ay, Ll, ye); // one exact parabola, no corners
            d = lerp(d, dl - (E.arc < 0 ? 3.4 : 2.4), w);
          }
        }
        if (F.on) d = Math.max(d, (lidC + slopeL * (cu - E.pcx) - cv) / lidN); // each eye's own straight, slanted lid (on the card)
        const i = (y * W + x) * 4;
        if (d * ms > 0.5) {
          if (halo && d * E.mag < halo) { const h = E.glow * 0.5 * Math.exp(-(d * E.mag) / 5.5); buf[i] += (C[0] - buf[i]) * h; buf[i + 1] += (C[1] - buf[i + 1]) * h; buf[i + 2] += (C[2] - buf[i + 2]) * h; }
          continue;
        }
        const cov = clamp(0.5 - d * ms, 0, 1);
        const f = L / rr0, vy = clamp(uy, -1, 1);
        const light = SHADE === 'none' ? 1 : SHADE === 'bowl' ? 0.86 + 0.18 * sstep(0.3, 1, f) + 0.07 * vy : 1.05 - 0.1 * (vy * 0.5 + 0.5);
        let rC = C[0] * light, gC = C[1] * light, bC = C[2] * light;
        if (pr > 0.02) {
          const px0 = (ux - E.pu) / prx, py0 = (uy - E.pv) / pry;
          let dq = 0;
          if (wD > 0.001) { const Lq = Math.hypot(px0, py0); const gq = Lq < 1e-4 ? 1 / pScale : Math.hypot(px0 / (Lq * prx * ax), py0 / (Lq * pry * ay)) * k; dq += (wD * (Lq - 1)) / gq / pScale; }
          if (wH > 0.001) dq += wH * sdHeart(px0, py0 + 0.05, 1.08, 1.0);
          if (wS > 0.001) { const sx2 = px0 * scs - py0 * ssn, sy2 = px0 * ssn + py0 * scs; dq += wS * (sdStar5(sx2, -sy2, 1.18, 0.5) - 0.08); }
          const ap = clamp(0.5 - Math.max(dq * pScale, d) * ms, 0, 1);
          if (ap > 0) { const pl = SHADE === 'none' ? 1 : 0.86 + 0.3 * clamp(py0 * 0.5 + 0.5, 0, 1); rC += (PC[0] * pl - rC) * ap; gC += (PC[1] * pl - gC) * ap; bC += (PC[2] * pl - bC) * ap; }
        }
        if (fillOn) {
          const surf = fillY + 0.035 * Math.sin(ux * 5 + E.t * 3);
          const above = clamp((surf - uy) * ay * 0.5 + 0.5, 0, 1);
          const dim = 1 - 0.8 * above;
          rC *= dim; gC *= dim; bC *= dim;
        }
        if (SHADE !== 'none' && E.shine > 0.01) {
          const hs = SHADE === 'bowl' ? Math.hypot((ux - 0.3) / 0.32, (uy - 0.5) / 0.16) : Math.hypot((ux + 0.34) / 0.3, (uy + 0.44) / 0.2);
          const hA = E.shine * 0.7 * (1 - sstep(0.35, 1, hs));
          if (hA > 0) { rC += (WH[0] - rC) * hA; gC += (WH[1] - gC) * hA; bC += (WH[2] - bC) * hA; }
        }
        buf[i] += (rC - buf[i]) * cov; buf[i + 1] += (gC - buf[i + 1]) * cov; buf[i + 2] += (bC - buf[i + 2]) * cov;
      }
    }
  }

  function partSDF(p, x, y, s) {
    switch (p.type) {
      case 'heart': return sdHeart(x, y, s, s * 0.95);
      case 'spark': return Math.min(sdRhombus(x, y, s, s * 0.26), sdRhombus(x, y, s * 0.26, s));
      case 'z': return Math.min(sdSeg(x, y, -s, -s, s, -s), sdSeg(x, y, s, -s, -s, s), sdSeg(x, y, -s, s, s, s)) - s * 0.2;
      case 'drop': return sdCap(x, y, 0, s * 0.35, s * 0.55, 0, -s * 0.7, s * 0.06);
      default: return Math.hypot(x, y) - s;
    }
  }
  function drawPart(buf, p, W) {
    const sc = W / SW;
    const life = p.age / p.life;
    let alpha = sstep(0, 0.12, life) * (1 - sstep(0.65, 1, life)), s = p.s + p.grow * life;
    if (p.pop) { s *= Math.sin(Math.PI * life); alpha = 1; }
    if (s < 0.3 || alpha <= 0) return;
    const R = s * 1.6 + 2, c = p.col;
    const x0 = Math.max(0, Math.floor((p.x - R) * sc)), x1 = Math.min(W - 1, Math.ceil((p.x + R) * sc)), y0 = Math.max(0, Math.floor((p.y - R) * sc)), y1 = Math.min(W - 1, Math.ceil((p.y + R) * sc));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = partSDF(p, (x + 0.5) / sc - p.x, (y + 0.5) / sc - p.y, s);
      if (d * sc > 0.5) continue;
      const a = clamp(0.5 - d * sc, 0, 1) * alpha, i = (y * W + x) * 4;
      buf[i] += (c[0] - buf[i]) * a; buf[i + 1] += (c[1] - buf[i + 1]) * a; buf[i + 2] += (c[2] - buf[i + 2]) * a;
    }
  }

  root.Goober = Goober;
  root.GOOBER_SIZE = SW;
})(typeof window !== 'undefined' ? window : globalThis);
