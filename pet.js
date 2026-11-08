/* pet.js — goober as a desktop pet. Same engine as the goober simulator (engine/goober.js); this file is the "hardware":
 * the window is the body. Drag it, throw it, it falls onto the taskbar (free fall + landing go into the fake
 * accelerometer, so it goes "wheee" and lands starstruck or tumbles), click = a knock on its back, the mouse
 * cursor stands in for the camera's "someone in view", and the clock dims the light at night so it sleeps.
 * What it does with its body by itself (hops, leaps, peeking, playing with the mouse) is in play.js.
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
  const P = { x: 0, y: 0, vx: 0, vy: 0, rot: 0, rotV: 0, held: false, ground: false, self: false, outL: 0, outR: 0 };  // P.x/y = pivot on screen; self = its own hop
  const dev = $('device'), win = $('win'), cv = $('screen'), ctx = cv.getContext('2d');
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
    const c = Math.cos(P.rot), sn = Math.sin(P.rot), dx = (u - grab.x) * s, dy = (v - grab.y) * s;
    return { x: P.x + c * dx - sn * dy, y: P.y + sn * dx + c * dy };
  }
  function toDevice(x, y) {
    const c = Math.cos(P.rot), sn = Math.sin(P.rot), dx = x - P.x, dy = y - P.y;
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
    down = { x: p.x, y: p.y, t: performance.now(), moved: false };
    repivot(u.x, u.y); P.held = true; P.self = false; P.vx = P.vy = 0; P.outL = P.outR = 0; host.ignore(false);
    resetImu(); dev.classList.add('dragging');
  });
  dev.addEventListener('pointermove', (e) => {
    if (!down) return; const p = pt(e);
    if (Math.hypot(p.x - down.x, p.y - down.y) > 4) { down.moved = true; P.ground = false; }
    P.tx = p.x; P.ty = p.y;
  });
  const up = (e) => {
    if (!down) return;
    if (!down.moved && performance.now() - down.t < 300) knockUntil = nowS() + 0.05;
    down = null; P.held = false; P.tx = P.ty = undefined; dev.classList.remove('dragging');
    P.vx = clamp(IMU.vx, -4000, 4000); P.vy = clamp(IMU.vy, -4000, 4000);
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
  host.on('reroll', () => { g.rollGoober(); host.save({ id: g.id }); });
  host.on('loadId', (str) => { const r = g.setId(str); if (r.ok) host.save({ id: g.id }); });
  host.on('home', () => { home(true); P.outL = P.outR = 0; });
  host.on('displays', (d) => { displays = d; });
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
      IMU.ax = 0; IMU.ay = S.gravity && !P.ground && !P.self ? G : 0;   // its own hops: it knows it jumped, no "wheee"
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
    // let go: the body settles upright (it lands on its two bottom points); in its own hops it leans into the jump
    const lean = P.self && !P.ground ? clamp(P.vx / 6000, -0.22, 0.22) : 0;
    P.rotV += (-60 * (P.rot - lean) - 11 * P.rotV) * dt; P.rot += P.rotV * dt;
    const d = displayAt(P.x, P.y), e = edges();
    const floor = d.y + d.height - e.bottom, top = d.y - e.top, left = d.x - e.left - P.outL, right = d.x + d.width - e.right + P.outR;
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
    if (P.x < left) { P.x = left; P.vx *= -0.45; }
    if (P.x > right) { P.x = right; P.vx *= -0.45; }
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
    area: () => { const c = toScreen(SCREEN_C.x, SCREEN_C.y), d = displayAt(c.x, c.y);
      return { left: d.x + (SCREEN_C.x - EXT.left) * s, right: d.x + d.width - (EXT.right - SCREEN_C.x) * s,
        top: d.y + (SCREEN_C.y - EXT.top) * s, floor: d.y + d.height - (EXT.bottom - SCREEN_C.y) * s, screenL: d.x, screenR: d.x + d.width }; },
    jump, squash: (v) => { SQ.t = v; }, setOut: (l, r) => { P.outL = l; P.outR = r; },
    cursorTo: (x, y) => host.cursorTo && host.cursorTo(x, y), canSteal: () => !!init.canSteal,
    cursor: { get pos() { return cursor; }, vel: cursorVel, still: () => nowS() - cursorMoved,
      get over() { return !!cursor && !down && overBody(cursor.x, cursor.y); } },
  });

  // ── light: the room, unless it's night (fades over a couple of minutes so it notices "dark", not "covered")
  let light = 0.6;
  function lightNow(dt) {
    const h = new Date().getHours(), night = S.nightSleep && (h >= 23 || h < 7);
    light += ((night ? 0.02 : 0.6) - light) * Math.min(1, dt / 40);
    return light;
  }

  // ── main loop
  let last = nowS(), saved = { x: P.x, y: P.y }, saveT = 0, idleFrame = 0;
  function frame() {
    const now = nowS(), dt = Math.min(0.05, Math.max(0.001, now - last)); last = now;
    play.update(dt);
    physics(dt);
    squashStep(dt);
    const imu = feelImu(dt);
    // what it looks at: where it's hopping / what it's after (play.js), else the cursor like a person in view
    let seen = null, target = play.lookAt;
    if (!target && cursor && now - cursorMoved < 12) target = cursor;
    if (target) {
      const sc = toScreen(SCREEN_C.x, SCREEN_C.y), dx = target.x - sc.x, dy = target.y - sc.y;
      seen = { x: Math.tanh(dx / 450) * 1.25, y: Math.tanh(dy / 450) * 1.25 };
      if (play.lookAt && g.sense) g.sense.attnUntil = g.t + 0.4;     // keep its eyes on it while it's after it
    }
    g.update(dt, { imu, light: lightNow(dt), seen, temp: 21, loud: 0, battery: 1 });

    // place the window so the pivot is in its middle, and draw the body around the pivot
    host.move(P.x - W / 2, P.y - W / 2);
    const sy = 1 + SQ.x, sx = 1 - SQ.x * 0.8;                       // squash round the bottom of the body
    dev.style.transform = `translate(${W / 2}px, ${W / 2}px) rotate(${P.rot}rad) translate(${-grab.x * s}px, ${-grab.y * s}px) scale(${s}) translate(250px, ${EXT.bottom}px) scale(${sx}, ${sy}) translate(-250px, ${-EXT.bottom}px)`;
    // the screen: at rest the engine redraws at 15–30 fps, so don't burn more than that
    const busy = P.held || !P.ground || Math.abs(P.rotV) > 0.01 || Math.abs(SQ.v) > 0.05 || play.state !== 'idle';
    if (busy || ++idleFrame % 2 === 0) { g.render(img.data, RES); ctx.putImageData(img, 0, 0); }

    // remember where it sits
    saveT += dt;
    if (saveT > 2 && !P.held && Math.hypot(P.x - saved.x, P.y - saved.y) > 2) { saveT = 0; saved = { x: P.x, y: P.y }; host.save({ x: P.x, y: P.y }); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__goober = { g, P, play, get grab() { return grab; } };   // for tools/check.js and tools/play.js

  // ── a pretend desktop for plain browsers (no Electron): the page is the screen, #win is the window
  function fakeHost() {
    document.body.classList.add('fake');
    const handlers = {}, S0 = { id: localStorage.getItem('goober.id'), size: 'medium', body: 'black', gravity: true, onTop: true, nightSleep: true,
      roam: true, mousePlay: true, steal: true, x: null, y: null };
    const BOD = { black: ['#17181f', '#2a2c38'], white: ['#f4f1ea', '#ffffff'], pink: ['#ff8fb1', '#ffc2d4'], blue: ['#5b6cff', '#8f9bff'],
      green: ['#2bb673', '#6fe0a8'], orange: ['#ffb020', '#ffd27a'], purple: ['#8e5cff', '#bb9bff'] };
    const area = () => [{ x: 0, y: 0, width: innerWidth, height: innerHeight - 44 }];
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
      menu: () => {   // a tiny stand-in for the real right-click menu
        if (menu) menu.remove();
        menu = document.createElement('div');
        menu.style.cssText = 'position:fixed;right:14px;top:36px;background:#1b1e2b;border:1px solid #ffffff22;border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:2px;z-index:9';
        const item = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'all:unset;padding:4px 10px;cursor:pointer;color:#dde'; b.onclick = () => { fn(); menu.remove(); menu = null; }; menu.appendChild(b); };
        for (const [k, label] of [['roam', 'hops around by itself'], ['mousePlay', 'plays with the mouse'], ['steal', 'allowed to steal the mouse'], ['gravity', 'fall to the taskbar']])
          item((S0[k] ? '☑ ' : '☐ ') + label, () => { S0[k] = !S0[k]; handlers.settings({ ...S0 }); });
        for (const sz of ['small', 'medium', 'large']) item('size: ' + sz, () => { S0.size = sz; handlers.settings({ ...S0 }); });
        for (const b of Object.keys(BOD)) item('body: ' + b, () => { S0.body = b; handlers.settings({ ...S0 }); });
        item('hatch a new goober', () => handlers.reroll(1));
        item('bring back', () => handlers.home(1));
        document.body.appendChild(menu);
      },
    };
  }
})();
