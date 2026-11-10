/* pet.js — goober as a desktop pet. Same engine as the goober simulator (engine/goober.js); this file is the "hardware":
 * the window is the body. Drag it, throw it, it falls onto the taskbar (free fall + landing go into the fake
 * accelerometer, so it goes "wheee" and lands starstruck or tumbles), click = a knock on its back, the mouse
 * cursor stands in for the camera's "someone in view", and the clock dims the light at night so it sleeps.
 * What it does with its body by itself (hops, leaps, playing with the mouse) is in play.js.
 *
 * In Electron the window moves around the real screen (main.js). Opened in a plain browser it fakes a desktop
 * inside the page, so it can be tried and tested without Electron.
 */
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ── host: Electron (window.pet from preload.js) or a pretend desktop in the page
  const host = window.pet || fakeHost();
  const init = await host.init();
  let S = init.settings;
  const SIZES = init.sizes, BODIES = init.bodies;
  let displays = init.displays;

  // ── goober
  const g = new Goober();
  if (!(S.id && g.setId(S.id).ok)) host.save({ id: g.id });
  g.on((m) => { if (/^goober goob-/.test(m)) host.save({ id: g.id }); });

  // ── geometry. Everything below is in screen px. The device is drawn 500 units wide (like the sim), scaled by s.
  // The window is a square of side W; the point you grabbed ("pivot") always sits in the middle of it, so goober
  // can swing round your grab point without leaving the window.
  let s = 1, W = 0;
  const EXT = { top: -26, bottom: 471, left: 11, right: 489 };    // the body's extent in device units (ring and stroke included)
  const SCREEN_C = { x: 250, y: 262 };                             // centre of the round screen, device units
  let grab = { x: 250, y: 262 };                                   // pivot, device units
  const P = { x: 0, y: 0, vx: 0, vy: 0, rot: 0, rotV: 0, held: false, ground: false, self: false,
    spin: 0, lift: 0, stick: false };   // spin/lift: extra turn and raise for tricks (play.js); stick: on a wall / the top edge, physics off  // P.x/y = pivot on screen; self = its own hop
  const dev = $('device'), win = $('win'), cv = $('screen'), ctx = cv.getContext('2d'), leds = [0, 1, 2].map((i) => $('led' + i));
  let img = null, RES = 0;

  function applySize() {
    s = SIZES[S.size] / 500; W = Math.round(SIZES[S.size] * 2.1);
    win.style.width = W + 'px'; win.style.height = W + 'px';
    RES = Math.min(480, Math.round(218 * s * Math.min(2, window.devicePixelRatio || 1)));
    cv.width = RES; cv.height = RES; img = ctx.createImageData(RES, RES);
  }
  function applyBody() { const b = BODIES[S.body] || BODIES.black; dev.style.setProperty('--body', b[0]); dev.style.setProperty('--body2', b[1]); }
  // device units → screen px (around the pivot, rotated)
  function toScreen(u, v) {
    const r = P.rot + P.spin, c = Math.cos(r), sn = Math.sin(r), dx = (u - grab.x) * s, dy = (v - grab.y) * s;
    return { x: P.x + c * dx - sn * dy, y: P.y - P.lift + sn * dx + c * dy };
  }
  function toDevice(x, y) {
    const r = P.rot + P.spin, c = Math.cos(r), sn = Math.sin(r), dx = x - P.x, dy = y - P.y + P.lift;
    return { x: grab.x + (c * dx + sn * dy) / s, y: grab.y + (-sn * dx + c * dy) / s };
  }
  // move the pivot to another point of the body without anything moving on screen
  function repivot(u, v) { const p = toScreen(u, v); P.x = p.x; P.y = p.y; grab = { x: u, y: v }; }
  function displayAt(x, y) {
    let best = displays[0], bd = Infinity;
    for (const d of displays) {
      const dx = Math.max(d.x - x, 0, x - (d.x + d.width)), dy = Math.max(d.y - y, 0, y - (d.y + d.height)), dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  }
  // the screen under x (by column first: a point below a shorter screen's bottom still belongs to that screen)
  function displayAtX(x, y) {
    const col = displays.filter((d) => x >= d.x && x < d.x + d.width);
    if (!col.length) return displayAt(x, y);
    let best = col[0], bd = Infinity;
    for (const d of col) { const dd = Math.max(d.y - y, 0, y - (d.y + d.height)); if (dd < bd) { bd = dd; best = d; } }
    return best;
  }
  // another screen right next to this one on that side (−1 left, +1 right) that the body fits into at height bottomY:
  // the edge between them is open (goober can hop, wander or be thrown across); other edges are walls
  function neighbor(d, side, bottomY) {
    for (const o of displays) {
      if (o === d) continue;
      const touch = side < 0 ? Math.abs(o.x + o.width - d.x) < 4 : Math.abs(o.x - (d.x + d.width)) < 4;
      if (touch && (bottomY === undefined || (bottomY <= o.y + o.height + 2 && bottomY >= o.y))) return o;
    }
    return null;
  }
  // the body's centre on screen, and where its edges are relative to the pivot (unrotated: used at rest / in flight)
  const centre = () => toScreen(250, 250);
  const edges = () => ({ top: (EXT.top - grab.y) * s, bottom: (EXT.bottom - grab.y) * s, left: (EXT.left - grab.x) * s, right: (EXT.right - grab.x) * s });

  // ── start: last place it was, or bottom right of the main screen
  applySize(); applyBody();
  function home(drop) {
    const d = displays[0]; grab = { x: 250, y: 262 }; P.rot = P.rotV = 0;
    const e = edges();
    P.x = d.x + d.width - e.right - 40; P.y = drop ? d.y - e.top + 20 : d.y + d.height - e.bottom; P.vx = P.vy = 0;
  }
  if (typeof S.x === 'number' && typeof S.y === 'number') { P.x = S.x; P.y = S.y; const d = displayAt(P.x, P.y); if (P.x < d.x || P.x > d.x + d.width || P.y < d.y || P.y > d.y + d.height) home(false); }
  else home(true);

  // ── pointer: grab, drag, throw, click = knock, right-click = menu
  let down = null, knockUntil = 0, cursor = null, cursorMoved = -1e9, lastCursor = null, cursorT = 0;
  const cursorVel = { x: 0, y: 0 };
  const nowS = () => performance.now() / 1000;
  const pt = (e) => (host.fake ? { x: e.clientX, y: e.clientY } : { x: e.screenX, y: e.screenY });
  dev.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dev.setPointerCapture(e.pointerId); const p = pt(e), u = toDevice(p.x, p.y);
    down = { x: p.x, y: p.y, t: performance.now(), moved: false, track: [{ x: p.x, y: p.y, t: performance.now() }] };
    P.spin = 0; P.lift = 0; P.stick = false;
    repivot(u.x, u.y); P.held = true; P.self = false; P.vx = P.vy = 0; host.ignore(false);
    resetImu(); dev.classList.add('dragging');
  });
  dev.addEventListener('pointermove', (e) => {
    if (!down) return; const p = pt(e);
    if (Math.hypot(p.x - down.x, p.y - down.y) > 4) { down.moved = true; P.ground = false; }
    P.tx = p.x; P.ty = p.y;
    const tn = performance.now(); down.track.push({ x: p.x, y: p.y, t: tn });
    while (down.track.length > 2 && tn - down.track[0].t > 120) down.track.shift();
  });
  const up = (e) => {
    if (!down) return;
    if (!down.moved && performance.now() - down.t < 300) knockUntil = nowS() + 0.05;
    // throw speed: how fast your hand actually moved over the last ~0.1 s (the smoothed "hand" goober feels lags
    // behind a flick, so using it made every throw lose speed the moment you let go). Holding still before letting
    // go is a gentle drop, not a throw.
    const tn = performance.now(), tr = down.track.filter((q) => tn - q.t < 120);
    let vx = 0, vy = 0;
    if (tr.length >= 2) { const a = tr[0], b = tr[tr.length - 1], dt = Math.max(0.016, (b.t - a.t) / 1000); if (tn - b.t < 60) { vx = (b.x - a.x) / dt; vy = (b.y - a.y) / dt; } }
    down = null; P.held = false; P.tx = P.ty = undefined; dev.classList.remove('dragging');
    P.vx = clamp(vx, -6000, 6000); P.vy = clamp(vy, -6000, 6000);
    if (Math.hypot(P.vx, P.vy) < 80) P.vx = P.vy = 0;
  };
  dev.addEventListener('pointerup', up); dev.addEventListener('pointercancel', up);
  dev.addEventListener('contextmenu', (e) => { e.preventDefault(); host.menu(); });

  // the cursor anywhere on screen: watched like a person in the camera's view, and used to tell main.js when the
  // pointer is over the body (so the empty corners of the window let clicks through to whatever is underneath)
  let ignoring = true;
  host.on('cursor', (c) => {
    const t = nowS();
    if (!lastCursor || c.x !== lastCursor.x || c.y !== lastCursor.y) cursorMoved = t;
    if (lastCursor && t > cursorT) { const k = Math.min(1, (t - cursorT) / 0.08), dt = Math.max(0.016, t - cursorT);
      cursorVel.x += ((c.x - lastCursor.x) / dt - cursorVel.x) * k; cursorVel.y += ((c.y - lastCursor.y) / dt - cursorVel.y) * k; }
    lastCursor = c; cursor = c; cursorT = t;
    const over = down || overBody(c.x, c.y);
    if (over === ignoring) { ignoring = !over; host.ignore(ignoring); }
  });
  const hit = document.createElement('canvas').getContext('2d');
  const STAR = new Path2D('M250,50 L318.2,168.2 L451.6,196.5 L360.3,297.8 L374.6,433.5 L250,378 L125.4,433.5 L139.7,297.8 L48.4,196.5 L181.8,168.2 Z');
  hit.lineWidth = 74; hit.lineJoin = 'round';
  function overBody(x, y) {
    const u = toDevice(x, y);
    return hit.isPointInPath(STAR, u.x, u.y) || hit.isPointInStroke(STAR, u.x, u.y) || Math.hypot(u.x - 250, u.y - 10) < 32;
  }

  // ── menu commands (main.js)
  // hatch a new goober: everything is rolled again (eyes, colour, the rest of its DNA). The eye type is
  // rolled until it differs from the old one, so you can always see it's someone new; then a little hatch moment.
  host.on('reroll', () => hatch());
  function hatch() {
    const old = g.look.type;
    for (let i = 0; i < 40; i++) { g.rollGoober(); if (g.look.type !== old) break; }
    host.save({ id: g.id }); sendInfo(true);
    if (!P.held) { P.vx = 0; jump(0, -900); P.spin = 0; }
    g.preview('starstruck', 1.6);
  }
  // what's shown at the top of the menu: who this goober is
  let infoKey = '';
  function sendInfo(force) {
    const info = { eyes: g.look.type, colour: g.look.swatch, mood: g.mood, id: g.id };
    const k = JSON.stringify(info); if (!force && k === infoKey) return; infoKey = k;
    if (host.info) host.info(info);
  }
  setInterval(() => sendInfo(false), 2000); sendInfo(true);
  host.on('loadId', (str) => { const r = g.setId(str); if (r.ok) host.save({ id: g.id }); });
  host.on('home', () => { home(true); });
  host.on('displays', (d) => { displays = d; });
  let gesture = null;
  host.on('gesture', (v) => { gesture = v; });            // menu "Show the battery" = the 👍 (arm lights for 4 s)
  host.on('settings', (v) => { const sizeWas = S.size; S = v; applyBody(); if (S.size !== sizeWas) { const c = centre(); applySize(); grab = { x: 250, y: 250 }; P.x = c.x; P.y = c.y; P.rot = P.rotV = 0; P.ground = false; } });

  // ── fake accelerometer: what a real one in the body would feel (specific force = acceleration − gravity), as in
  // the sim. Screen gravity G px/s² is "1 g", so free fall reads ~0 g and the engine notices it by itself.
  const G = 3000;
  let landed = false, softLand = 0;
  // In your hand: mouse events arrive unevenly between frames, so the raw position is jittery and its second
  // derivative is noise (it read as ±2 g of "shaking"). A real hand is smooth, so the body's motion is felt through
  // a critically damped spring (ω 12 rad/s): steady drags read ~0 g, a real shake (~4 Hz) still saturates.
  // Flying or sitting: the physics knows its own acceleration exactly (gravity in flight → 0 g, the engine's "wheee").
  const IMU = { x: null, y: 0, vx: 0, vy: 0, ax: 0, ay: 0 }, W_HAND = 12;
  function resetImu() { IMU.x = null; IMU.ax = IMU.ay = 0; }
  function feelImu(dt) {
    if (IMU.x === null) { IMU.x = P.x; IMU.y = P.y; IMU.vx = P.vx || 0; IMU.vy = P.vy || 0; }
    if (P.held) {
      IMU.ax = W_HAND * W_HAND * (P.x - IMU.x) - 2 * W_HAND * IMU.vx;
      IMU.ay = W_HAND * W_HAND * (P.y - IMU.y) - 2 * W_HAND * IMU.vy;
      IMU.vx += IMU.ax * dt; IMU.vy += IMU.ay * dt; IMU.x += IMU.vx * dt; IMU.y += IMU.vy * dt;
      // soft deadzone: picking it up or stopping a drag (< ~1 g) shouldn't count as a knock; a real shake (≥ 2 g) passes as is
      const m = Math.hypot(IMU.ax, IMU.ay) / G;
      if (m > 1e-6 && m < 2) { const k = (m * m / 2) / m; IMU.fax = IMU.ax * k; IMU.fay = IMU.ay * k; } else { IMU.fax = IMU.ax; IMU.fay = IMU.ay; }
    } else {
      IMU.ax = 0; IMU.ay = S.gravity && !P.ground && !P.self && !P.stick ? G : 0;   // its own hops: it knows it jumped, no "wheee"
      IMU.x = P.x; IMU.y = P.y; IMU.vx = P.vx; IMU.vy = P.vy; IMU.fax = IMU.ax; IMU.fay = IMU.ay;
    }
    // the tilt it feels follows the drawn swing at ≤ 0.5 rad/s: turning over to hang from an arm is then a slow
    // tilt (the eyes level themselves), not a jolt the engine would count as a knock
    IMU.rot = IMU.rot === undefined || !P.held ? P.rot : IMU.rot + clamp(P.rot - IMU.rot, -0.5 * dt, 0.5 * dt);
    const fx = (IMU.fax || 0) / G, fy = (IMU.fay || 0) / G - 1, c = Math.cos(IMU.rot), sn = Math.sin(IMU.rot);
    const sat = (v) => clamp(v, -2, 2);                         // the LIS2DW12 runs at ±2 g: a landing saturates, it doesn't read as a shake
    let imu = { x: sat(c * fx + sn * fy), y: sat(-sn * fx + c * fy), z: 0 };
    if (landed) { landed = false; imu = { x: 0, y: -3.4, z: 0 }; resetImu(); }   // landing: one clean jolt, then at rest
    if (softLand) { imu = { x: 0, y: -1 - softLand, z: 0 }; softLand = 0; }       // its own landing: a little bump (eyes slosh, no knock)
    if (nowS() < knockUntil) imu.z -= 1.1;                       // a knock on the back
    return imu;
  }

  // ── physics: held (swings round your grab point like a pendulum), flying, or sitting on the taskbar
  function physics(dt) {
    if (P.held) {
      if (P.tx !== undefined) { const k = Math.min(1, dt * 40); P.x += (P.tx - P.x) * k; P.y += (P.ty - P.y) * k; }
      // pendulum round the grab point. α = angle of the centre of mass from straight down (on screen):
      // α'' = −(g/L)·sin α − (a/L)·cos α. With CSS rotation rot, α = hang − rot, so the body comes to rest at
      // rot = hang (grab a tip and the middle hangs below it) and lags behind when you swing it about.
      const L = Math.max(60, Math.hypot(250 - grab.x, 250 - grab.y) * s);
      const hang = Math.atan2(250 - grab.x, 250 - grab.y), a = hang - P.rot;
      // swings slower than real gravity would, so turning over to hang doesn't read as a shake (= dizzy)
      const k = 0.3 * G / L;
      P.rotV += (k * Math.sin(a) + 0.3 * (IMU.ax / L) * Math.cos(a) - 1.3 * Math.sqrt(k) * P.rotV) * dt;
      P.rot += P.rotV * dt;
      return;
    }
    if (P.stick) { P.vx = P.vy = 0; return; }                     // on a wall / hanging from the top: play.js moves it
    // let go: the body settles upright (it lands on its two bottom points); in its own hops it leans into the jump
    const lean = P.self && !P.ground ? clamp(P.vx / 6000, -0.22, 0.22) : 0;
    P.rotV += (-60 * (P.rot - lean) - 11 * P.rotV) * dt; P.rot += P.rotV * dt;
    const d = displayAt(P.x, P.y), e = edges();
    const floor = d.y + d.height - e.bottom, top = d.y - e.top, bottomY = P.y + e.bottom;
    const left = neighbor(d, -1, bottomY) ? -Infinity : d.x - e.left, right = neighbor(d, 1, bottomY) ? Infinity : d.x + d.width - e.right;
    if (S.gravity) {
      if (!P.ground) P.vy += G * dt;
      P.x += P.vx * dt; P.y += P.vy * dt;
      if (P.y >= floor) {
        P.y = floor;
        if (P.self) { softLand = Math.min(0.4, P.vy / 5000); SQ.v -= Math.min(4, P.vy / 450); P.self = false; P.vx = 0; }
        else { if (P.vy > 600) landed = true; SQ.v -= Math.min(3, P.vy / 900); }   // thrown: the thump, one frame of 3.4 g
        P.vy = 0; P.ground = true; P.vx *= 0.6;
      } else if (P.y < floor - 1) P.ground = false;            // the taskbar moved, or it was dragged up
      if (P.ground) P.vx *= Math.exp(-dt * 7);
    } else {                                                    // no gravity: slides to a stop wherever you threw it
      P.x += P.vx * dt; P.y += P.vy * dt; P.vx *= Math.exp(-dt * 3.5); P.vy *= Math.exp(-dt * 3.5);
      P.ground = Math.hypot(P.vx, P.vy) < 15; if (P.ground) P.self = false;
      if (P.y > floor) { P.y = floor; P.vy *= -0.4; }
      if (P.y < top) { P.y = top; P.vy *= -0.4; }
    }
    // walls: a throw bounces off; its own jump slides up the wall and carries on once it's above the ledge (the
    // bottom edge of a shorter screen next door), so it can leap from right beside it onto the other screen
    if (P.x < left) { P.x = left; if (!P.self) P.vx *= -0.45; }
    if (P.x > right) { P.x = right; if (!P.self) P.vx *= -0.45; }
    if (Math.abs(P.vx) < 4) P.vx = 0;
  }

  // ── squash & stretch (the body only; the eyes stay the eyes): a bouncy spring, 0 = round, < 0 squashed
  const SQ = { x: 0, v: 0, t: 0 };
  function squashStep(dt) {
    const air = !P.ground && !P.held && S.gravity ? clamp(-P.vy / 9000, -0.06, 0.12) : 0;   // stretches going up
    const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
    for (let i = 0; i < n; i++) { SQ.v += (900 * ((SQ.t || air) - SQ.x) - 22 * SQ.v) * h; SQ.x += SQ.v * h; }
    SQ.x = clamp(SQ.x, -0.35, 0.3);
  }
  function jump(vx, vy) {
    if (P.held) return;
    if (grab.x !== 250 || grab.y !== 262) { P.rot = P.rotV = 0; repivot(250, 262); }
    P.vx = vx; P.vy = vy; P.ground = false; P.self = true; SQ.v += 2.5;
  }
  const play = GooberPlay({
    g, P, G, now: nowS, size: () => SIZES[S.size], settings: () => S, toScreen,
    face: () => toScreen(SCREEN_C.x, SCREEN_C.y),
    // where the face centre can go on the screen it's on (or the screen at point pt), and which side edges are open
    area: (pt) => { const c = pt || toScreen(SCREEN_C.x, SCREEN_C.y), d = pt ? displayAtX(c.x, c.y) : displayAt(c.x, c.y);
      return { left: d.x + (SCREEN_C.x - EXT.left) * s, right: d.x + d.width - (EXT.right - SCREEN_C.x) * s,
        top: d.y + (SCREEN_C.y - EXT.top) * s, floor: d.y + d.height - (EXT.bottom - SCREEN_C.y) * s, screenL: d.x, screenR: d.x + d.width,
        openL: !!neighbor(d, -1), openR: !!neighbor(d, 1) }; },
    jump, squash: (v) => { SQ.t = v; }, bounce: (v) => { SQ.v += v; },
    // tricks: turn round the face's middle, and lift the body so a turned star stands on its lowest point, not in the floor
    centrePivot: () => { if (grab.x !== 250 || grab.y !== 262) { P.rot = P.rotV = 0; repivot(250, 262); } },
    liftFor: (spin) => liftFor(spin),
    cursorTo: (x, y) => host.cursorTo && host.cursorTo(x, y), canSteal: () => !!init.canSteal,
    cursor: { get pos() { return cursor; }, vel: cursorVel, still: () => nowS() - cursorMoved,
      get over() { return !!cursor && !down && overBody(cursor.x, cursor.y); } },
  });

  // how far the body's lowest point drops below its normal bottom when turned by `spin` round the face's middle (px)
  const STAR_PTS = [[250, 50], [318.2, 168.2], [451.6, 196.5], [360.3, 297.8], [374.6, 433.5], [250, 378], [125.4, 433.5], [139.7, 297.8], [48.4, 196.5], [181.8, 168.2]];
  function liftFor(spin) {
    const c = Math.cos(spin), sn = Math.sin(spin); let low = -Infinity;
    for (const [u, v] of STAR_PTS) low = Math.max(low, sn * (u - 250) + c * (v - 262) + 37);   // 37 = half the rounded stroke
    low = Math.max(low, sn * 0 + c * (-22 - 262));                                              // the key ring
    return Math.max(0, (low - (EXT.bottom - 262)) * s);
  }

  // ── never lost, never half off the screen
  // · a broken position (NaN) or the body's middle off every screen for 3 s (a screen unplugged, a bad throw):
  //   it drops back in on the main screen
  // · sitting still with part of its body off the screen: it hops back in
  // · resting with a squash left over: it relaxes (only a crouch before a hop should hold a squash)
  let lostT = 0, outT = 0;
  function keepInSight(dt) {
    if (!Number.isFinite(P.x) || !Number.isFinite(P.y) || !Number.isFinite(P.rot)) { home(true); return; }
    if (P.held) { lostT = outT = 0; return; }
    const c = centre(), on = displays.some((d) => c.x >= d.x && c.x <= d.x + d.width && c.y >= d.y - 60 && c.y <= d.y + d.height);
    lostT = on ? 0 : lostT + dt;
    if (lostT > 3) { lostT = 0; home(true); return; }
    if (!P.ground || play.state !== 'idle') { outT = 0; return; }
    if (SQ.t !== 0) SQ.t = 0;
    const d = displayAt(c.x, c.y), e = edges();
    const offL = d.x - (P.x + e.left), offR = (P.x + e.right) - (d.x + d.width);
    const open = (side) => !!neighbor(d, side, P.y + e.bottom);
    outT = (offL > 2 && !open(-1)) || (offR > 2 && !open(1)) ? outT + dt : 0;
    if (outT > 0.6) { outT = 0; const sz = SIZES[S.size]; play.hopIn(offL > 2 ? c.x + offL + sz * 0.3 : c.x - offR - sz * 0.3); }
  }

  // ── the computer's battery, if it has one. The level feeds the engine's battery (arm-light gauge, low-battery
  // yawns). Plugging the charger in gives the engine's charging look (wall-eyed stare, gauge lit, dimmed screen) for
  // ~8 s, then it's back to normal: a laptop that's always plugged in shouldn't keep goober wall-eyed and dimmed.
  // Desktops report "charging, 100 %" forever and never change, so they never trigger it.
  const BAT = { level: 1, charging: false, pulseUntil: 0 };
  if (navigator.getBattery) navigator.getBattery().then((b) => {
    const read = () => { BAT.level = b.level; if (b.charging && !BAT.charging && BAT.seen) BAT.pulseUntil = nowS() + 8; BAT.charging = b.charging; BAT.seen = true; };
    read(); b.addEventListener('levelchange', read); b.addEventListener('chargingchange', read);
  }).catch(() => {});

  // ── light: the room, unless it's night (fades over a couple of minutes so it notices "dark", not "covered")
  let light = 0.6;
  function lightNow(dt) {
    const h = new Date().getHours(), night = S.nightSleep && (h >= 23 || h < 7);
    light += ((night ? 0.02 : 0.6) - light) * Math.min(1, dt / 40);
    return light;
  }

  // ── watching the mouse: while you move it, goober mostly follows the cursor with its eyes (the engine glances there
  // in its own calm way, a look every ~1 s). Every few seconds it decides again whether to keep watching or look
  // off at its own things for a bit; how much it watches depends on the mood. A cursor close by is always watched.
  // When the mouse has been still for a few seconds it goes back to its own business.
  const WATCH = { shy: 0.45, sulky: 0.4, sleepy: 0.35, dreamy: 0.5, bored: 0.55, busy: 0.55, grumpy: 0.6, anxious: 0.7, calm: 0.7,
    cozy: 0.6, curious: 0.95, playful: 0.95, hyper: 0.9, cuddly: 0.9, happy: 0.85, silly: 0.85, sassy: 0.75, proud: 0.75 };
  const watch = { on: false, until: 0 };
  function watchingCursor(now, dist) {
    if (g.mode !== 'awake') return false;
    if (now - cursorMoved > rrW(2.5, 4)) return false;                 // the mouse is resting: goober does its own thing
    if (dist < SIZES[S.size] * 1.8) return true;                         // right next to it: can't not look
    if (now > watch.until) { watch.on = Math.random() < (WATCH[g.mood] || 0.75); watch.until = now + (watch.on ? rrW(4, 9) : rrW(1.5, 4)); }
    return watch.on;
  }
  function rrW(a, b) { return a + (b - a) * 0.5; }   // fixed midpoints: no flicker from re-rolling every frame
  // keep the eyes on a point. The engine's own "someone in view" only looks once a second and not during its
  // animations, which read as ignoring you; so between animations the gaze is set here, as soon as the point has
  // moved a bit (small moves glide, big ones go through a blink like every big look), and the engine is told to hold it.
  let lastFollow = 0;
  function follow(now, seen) {
    if (g.sense) g.sense.attnUntil = g.t + 0.4;
    if (g.doing || typeof g._setGaze !== 'function' || !g.gaze) return;
    const x = clamp(seen.x, -0.9, 0.9) * 0.85, y = clamp(seen.y, -0.8, 0.8) * 0.7, d = Math.hypot(x - g.gaze[0], y - g.gaze[1]);
    if (d > 0.08 && now - lastFollow > 0.12) { lastFollow = now; g._setGaze(x, y, d > 0.6 ? 0.5 : 0); }
    g.nextSac = g.t + 0.8;
    if (!play.lookAt && typeof g.nextAct === 'number') g.nextAct = Math.max(g.nextAct, g.t + 1.5);   // no idle animations while it watches you
  }

  // ── main loop
  let last = nowS(), saved = { x: P.x, y: P.y }, saveT = 0, idleFrame = 0;
  function frame() {
    const now = nowS(), dt = Math.min(0.05, Math.max(0.001, now - last)); last = now;
    play.update(dt);
    physics(dt);
    keepInSight(dt);
    squashStep(dt);
    const imu = feelImu(dt);
    // what it looks at: where it's hopping / what it's after (play.js), else the cursor like a person in view
    let seen = null, target = play.lookAt;
    if (!target && cursor && now - cursorMoved < 12) target = cursor;
    if (target) {
      const sc = toScreen(SCREEN_C.x, SCREEN_C.y), dx = target.x - sc.x, dy = target.y - sc.y;
      seen = { x: Math.tanh(dx / 450) * 1.25, y: Math.tanh(dy / 450) * 1.25 };
      if (play.lookAt || watchingCursor(now, Math.hypot(dx, dy))) follow(now, seen);   // eyes on it
    }
    g.update(dt, { imu, light: lightNow(dt), seen, gesture, temp: 21, loud: 0, battery: BAT.level, charging: nowS() < BAT.pulseUntil });
    gesture = null;

    // place the window so the pivot is in its middle, and draw the body around the pivot
    host.move(P.x - W / 2, P.y - W / 2);
    const sy = 1 + SQ.x, sx = 1 - SQ.x * 0.8;                       // squash round the bottom of the body
    dev.style.transform = `translate(${W / 2}px, ${W / 2 - P.lift}px) rotate(${P.rot + P.spin}rad) translate(${-grab.x * s}px, ${-grab.y * s}px) scale(${s}) translate(250px, ${EXT.bottom}px) scale(${sx}, ${sy}) translate(-250px, ${-EXT.bottom}px)`;
    // the screen: at rest the engine redraws at 15–30 fps, so don't burn more than that
    const busy = P.held || !P.ground || P.stick || P.spin !== 0 || Math.abs(P.rotV) > 0.01 || Math.abs(SQ.v) > 0.05 || play.state !== 'idle';
    const hold = g.power && g.power.screen && g.power.fps === 0;          // charging: the panel keeps its last frame
    if (!hold && (busy || ++idleFrame % 2 === 0)) { g.render(img.data, RES); ctx.putImageData(img, 0, 0); }
    if (g.power) { const br = g.power.screen ? Math.sqrt(g.power.bright) : 1; cv.style.filter = br < 0.99 ? `brightness(${br.toFixed(2)})` : ''; }
    g.armLights().forEach(([r, gg, b], i) => {                              // the 3 RGB lights on the top-right arm
      const el = leds[i], on = r + gg + b > 0;
      el.style.background = on ? `rgb(${Math.min(255, r * 2.2)},${Math.min(255, gg * 2.2)},${Math.min(255, b * 2.2)})` : '';
      el.style.boxShadow = on ? `0 0 ${6 + (r + gg + b) / 30}px 2px rgba(${r * 2.2},${gg * 2.2},${b * 2.2},.75)` : '';
    });

    // remember where it sits
    saveT += dt;
    if (saveT > 2 && !P.held && P.ground && Math.hypot(P.x - saved.x, P.y - saved.y) > 2) { saveT = 0; saved = { x: P.x, y: P.y }; host.save({ x: P.x, y: P.y }); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__goober = { g, P, play, watch, SQ, hatch, get grab() { return grab; } };   // for tools/check.js and tools/play.js

  // ── a pretend desktop for plain browsers (no Electron): the page is the screen, #win is the window
  function fakeHost() {
    document.body.classList.add('fake');
    const handlers = {}, S0 = { id: localStorage.getItem('goober.id'), size: 'medium', body: 'black', gravity: true, onTop: true, nightSleep: true,
      roam: true, mousePlay: true, steal: true, x: null, y: null };
    const BOD = { black: ['#17181f', '#2a2c38'], white: ['#f4f1ea', '#ffffff'], pink: ['#ff8fb1', '#ffc2d4'], blue: ['#5b6cff', '#8f9bff'],
      green: ['#2bb673', '#6fe0a8'], orange: ['#ffb020', '#ffd27a'], purple: ['#8e5cff', '#bb9bff'] };
    // ?screens=2: two screens side by side, the right one with a taller taskbar (a different floor), to try hopping across
    const two = /screens=2/.test(location.search);
    const area = () => two ? [{ x: 0, y: 0, width: Math.floor(innerWidth / 2), height: innerHeight - 44 }, { x: Math.floor(innerWidth / 2), y: 0, width: innerWidth - Math.floor(innerWidth / 2), height: innerHeight - 164 }]
      : [{ x: 0, y: 0, width: innerWidth, height: innerHeight - 44 }];
    if (two) { const sep = document.createElement('div'); sep.style.cssText = 'position:fixed;left:50%;top:0;bottom:0;width:2px;background:#ffffff30';
      const bar = document.createElement('div'); bar.style.cssText = 'position:fixed;left:50%;right:0;bottom:44px;height:120px;background:#0b0d14e6;border-top:1px solid #ffffff14';
      document.body.append(sep, bar); }
    // the page can't move the real cursor, so a stolen cursor is drawn (and the real one hidden while it's held)
    const fakeArrow = document.createElement('div'); let stolenUntil = 0;
    fakeArrow.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;border-left:9px solid #fff;border-top:7px solid transparent;border-bottom:7px solid transparent;transform-origin:0 0;filter:drop-shadow(0 1px 1px #000);pointer-events:none;z-index:20;display:none';
    document.body.appendChild(fakeArrow);
    setInterval(() => { if (performance.now() > stolenUntil) { fakeArrow.style.display = 'none'; document.body.style.cursor = ''; } }, 100);
    addEventListener('mousemove', (e) => handlers.cursor && handlers.cursor({ x: e.clientX, y: e.clientY }));
    addEventListener('resize', () => handlers.displays && handlers.displays(area()));
    let menu = null;
    addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) { menu.remove(); menu = null; } });
    return {
      fake: true,
      init: async () => ({ settings: S0, sizes: { small: 140, medium: 200, large: 280 }, bodies: BOD, displays: area(), canSteal: true }),
      cursorTo: (x, y) => {
        if (!S0.steal) return;
        stolenUntil = performance.now() + 250; document.body.style.cursor = 'none';
        fakeArrow.style.display = 'block'; fakeArrow.style.transform = `translate(${x}px, ${y}px) rotate(-60deg)`;
        if (handlers.cursor) handlers.cursor({ x, y });
      },
      move: (x, y) => { $('win').style.transform = `translate(${x}px, ${y}px)`; },
      ignore: () => {},
      save: (p) => { if (p.id) localStorage.setItem('goober.id', p.id); },
      on: (ch, fn) => { handlers[ch] = fn; },
      info: (v) => { window.__info = v; },
      menu: () => {   // a tiny stand-in for the real right-click menu
        if (menu) menu.remove();
        menu = document.createElement('div');
        menu.style.cssText = 'position:fixed;right:14px;top:36px;background:#1b1e2b;border:1px solid #ffffff22;border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:2px;z-index:9';
        const item = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'all:unset;padding:4px 10px;cursor:pointer;color:#dde'; b.onclick = () => { fn(); menu.remove(); menu = null; }; menu.appendChild(b); };
        for (const [k, label] of [['roam', 'hops around by itself'], ['mousePlay', 'plays with the mouse'], ['steal', 'allowed to steal the mouse'], ['gravity', 'fall to the taskbar']])
          item((S0[k] ? '☑ ' : '☐ ') + label, () => { S0[k] = !S0[k]; handlers.settings({ ...S0 }); });
        for (const sz of ['small', 'medium', 'large']) item('size: ' + sz, () => { S0.size = sz; handlers.settings({ ...S0 }); });
        for (const b of Object.keys(BOD)) item('body: ' + b, () => { S0.body = b; handlers.settings({ ...S0 }); });
        item('show the battery', () => handlers.gesture('thumbsup'));
        item('hatch a new goober', () => handlers.reroll(1));
        item('bring back', () => handlers.home(1));
        document.body.appendChild(menu);
      },
    };
  }
})();
