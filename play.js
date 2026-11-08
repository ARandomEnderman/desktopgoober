/* play.js — what goober does with its body on the desktop: hopping about by itself and playing with the mouse.
 * The eyes are still all goober.js (moods, faces, animations); this only decides where the body goes and, through
 * the engine's public act()/preview() and the "someone in view" input, what it looks at and how it reacts.
 *
 *   by itself   hop chains, boings in place, big leaps across the screen, peeking in from the screen edge
 *   the mouse   hops over to the cursor, pounces on it when it sits still, boops it, runs away from fast swipes,
 *               nuzzles into it when you rub it over goober, and now and then grabs it and drags it off
 * How often depends on the mood and the personality (chill → hyper, cute → feisty).
 */
(function (root) {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rr = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  // how bouncy each mood is (whims per minute ×), and how keen on the mouse
  const ENERGY = { calm: 0.6, happy: 1.3, sleepy: 0.3, grumpy: 0.5, curious: 1.2, playful: 1.8, shy: 0.7, dreamy: 0.6, hyper: 2.2,
    sassy: 1.0, cuddly: 0.8, silly: 1.6, anxious: 0.9, proud: 1.0, busy: 1.1, bored: 0.8, sulky: 0.4, cozy: 0.4 };
  const PLAYFUL = { calm: 0.35, happy: 0.7, sleepy: 0.15, grumpy: 0.25, curious: 0.9, playful: 1, shy: 0.3, dreamy: 0.3, hyper: 1,
    sassy: 0.6, cuddly: 0.6, silly: 0.9, anxious: 0.2, proud: 0.5, busy: 0.4, bored: 0.5, sulky: 0.2, cozy: 0.25 };
  const MISCHIEF = { sassy: 1, silly: 0.9, playful: 0.8, hyper: 0.7, grumpy: 0.5, bored: 0.6, curious: 0.4 };   // others ~0.15
  const SKITTISH = { shy: 0.9, anxious: 1, sleepy: 0.5, sulky: 0.6, cozy: 0.4, calm: 0.3, dreamy: 0.3 };       // others ~0.2

  root.GooberPlay = function (X) {
    // X: { g, P, G, now(), size(), face(), area(), jump(vx, vy), squash(v), lean(r), setOut(l, r), cursorTo(x, y),
    //      canSteal(), settings(), cursor: { pos, vel, still(), over } }
    const g = X.g;
    const B = { st: 'idle', hops: [], nextWhim: X.now() + rr(4, 9), cd: {}, rubT: 0, hoverT: 0, lookAt: null, msg: '' };
    const cd = (k, t) => { B.cd[k] = X.now() + t; };
    const ready = (k) => X.now() >= (B.cd[k] || 0);
    const say = (m) => { B.msg = m; if (root.__playLog) root.__playLog.push(m); };
    const mood = () => g.mood, energy = () => (ENERGY[mood()] || 1) * (0.7 + 0.15 * g.personality.col);
    const feisty = () => g.personality.row / 4;                // 0 very cute … 1 very feisty
    const free = () => !g.doing;                               // don't talk over an animation the engine is playing
    const act = (n) => { if (g.actNames.indexOf(n) >= 0) g.act(n); };

    // ── body moves
    // a hop (or a glide when gravity is off) so the face centre lands at x (and, gliding, y). h = how high, px.
    // Across an open edge onto the next screen too (it lands on that screen's floor, higher or lower).
    function hopTo(x, h, y) {
      const C = X.face(), G = X.G, A0 = X.area();
      let A = X.area({ x, y: C.y });
      if (A.screenL !== A0.screenL && !(x < C.x ? A0.openL : A0.openR)) A = A0;   // a wall there: stay on this screen
      x = clamp(x, A.left, A.right);
      if (!X.settings().gravity) { const ty = y === undefined ? C.y : clamp(y, A.top, A.floor); X.jump((x - C.x) * 3.5, (ty - C.y) * 3.5); return; }
      const ty = A.screenL === A0.screenL ? C.y : A.floor;        // where the face ends up: same height, or the other floor
      h = Math.max(12, h, C.y - ty + 30);
      const T = Math.sqrt((2 * h) / G) + Math.sqrt((2 * (h + ty - C.y)) / G);
      X.jump((x - C.x) / T, -Math.sqrt(2 * G * h));
    }
    // a big leap over to the next screen (if there's one beside this one); false if there isn't
    function leapToScreen(side) {
      const A = X.area(), sz = X.size();
      const sides = [A.openL ? -1 : 0, A.openR ? 1 : 0].filter(Boolean);
      if (!sides.length) return false;
      side = side && sides.indexOf(side) >= 0 ? side : pick(sides);
      const B2 = X.area({ x: side < 0 ? A.screenL - 40 : A.screenR + 40, y: X.face().y });
      const x = rr(B2.left + (B2.right - B2.left) * 0.15, B2.right - (B2.right - B2.left) * 0.15);
      say('leaps to the other screen');
      chain([{ x, h: rr(1.6, 2.8) * sz, crouch: 0.32, onLaunch: () => g.preview('excited', 1.1),
        onLand: () => { X.squash(-0.28); if (free()) act(pick(['giggle.small', 'proudNod.1', 'lookAround', 'hop.1.joy'])); } }]);
      return true;
    }
    // a leap whose top is at point q (so the face goes through it)
    function leapAt(q) {
      const C = X.face(), G = X.G;
      if (!X.settings().gravity) { X.jump((q.x - C.x) * 3.5, (q.y - C.y) * 3.5); return; }
      const h = clamp(C.y - q.y, 30, 900), ta = Math.sqrt((2 * h) / G);
      X.jump(clamp((q.x - C.x) / ta, -2600, 2600), -Math.sqrt(2 * G * h));
    }
    // queue a chain of hops; each one crouches first (anticipation), then launches
    function chain(list, then) { B.hops = list.slice(); B.then = then || null; B.st = 'hopping'; B.phase = 'pause'; B.phaseT = X.now() + 0.05; }
    function stepChain() {
      const t = X.now(), P = X.P;
      if (B.phase === 'pause' && t >= B.phaseT) {
        if (!B.hops.length) { const f = B.then; B.then = null; B.st = 'idle'; B.lookAt = null; if (f) f(); return; }
        B.cur = B.hops.shift(); B.phase = 'crouch'; B.phaseT = t + (B.cur.crouch || rr(0.1, 0.16)); X.squash(-0.16);
        B.lookAt = { x: B.cur.x, y: X.face().y - 40 };
      } else if (B.phase === 'crouch') {
        if (B.cur.wiggle) X.squash(-0.15 + Math.sin(t * 38) * 0.05);   // pounce wiggle
        if (t >= B.phaseT) {
          X.squash(0);
          if (B.cur.at) leapAt(B.cur.at()); else hopTo(B.cur.x, B.cur.h, B.cur.y);
          if (B.cur.onLaunch) B.cur.onLaunch();
          B.phase = 'air'; B.phaseT = t + 0.06;
        }
      } else if (B.phase === 'air') {
        if (B.cur.inAir) B.cur.inAir();
        if (t >= B.phaseT && P.ground) { B.phase = 'pause'; B.phaseT = t + (B.cur.rest || rr(0.06, 0.22)); if (B.cur.onLand) B.cur.onLand(); }
      }
    }
    const cancel = () => { B.hops = []; B.then = null; B.st = 'idle'; B.lookAt = null; X.squash(0); };

    // ── things it does by itself
    function whim() {
      const A = X.area(), C = X.face(), sz = X.size(), e = energy();
      const roll = Math.random(), skittish = SKITTISH[mood()] || 0.2;
      const away = C.x - A.left < sz * 1.5 ? 1 : A.right - C.x < sz * 1.5 ? -1 : (Math.random() < 0.5 ? -1 : 1);
      if (roll < 0.42) {                                           // a little wander: 1–4 hops one way
        const n = 1 + Math.floor(Math.random() * Math.min(4, 1 + e * 1.6)), dir = away, list = [];
        let x = C.x;
        for (let i = 0; i < n; i++) { x += dir * rr(0.35, 0.9) * sz; list.push({ x, h: rr(0.15, 0.35) * sz }); }
        say('wanders'); chain(list);
      } else if (roll < 0.58) {                                    // boing boing in place
        say('boings'); if (free()) act(pick(['boing.2.quick', 'boing.3.quick', 'boing.2.easy']));
        chain([{ x: C.x, h: 0.3 * sz }, { x: C.x, h: 0.55 * sz, rest: 0.05 }, { x: C.x, h: 0.25 * sz }]);
      } else if (roll < 0.74 && e > 0.6) {                         // a big leap somewhere else on the screen, or onto the next one
        if ((A.openL || A.openR) && Math.random() < 0.4 && leapToScreen()) return;
        const x = rr(A.left, A.right), h = rr(1.2, 2.4) * sz;
        say('big leap');
        chain([{ x, h, crouch: 0.28, onLaunch: () => g.preview('excited', 0.9),
          onLand: () => { X.squash(-0.25); if (free()) act(pick(['giggle.small', 'proudNod.1', 'squishy.1.quick', 'hop.1.joy'])); } }]);
      } else if (roll < 0.74 + 0.12 * (0.5 + skittish) && peek() !== false) {   // go and peek in from the edge of the screen

      } else {                                                     // just looks around
        if (free()) act(pick(['lookAround', 'lookAroundSlow.2', 'stretch.small', 'wiggle']));
        say('looks around');
      }
    }

    // ── peek: hop to the nearest side, slide half out of the screen, look back in, come back later (or when you come near)
    function peek() {
      const A = X.area(), C = X.face(), sz = X.size();
      // only at an outer edge of the desktop (an edge with another screen beyond it isn't an edge to peek round)
      if (A.openL && A.openR) return false;
      const side = A.openL ? 1 : A.openR ? -1 : C.x - A.left < A.right - C.x ? -1 : 1;
      const edgeX = side < 0 ? A.left : A.right, list = []; let x = C.x;
      while (Math.abs(edgeX - x) > 2 && list.length < 9) { x += side * Math.min(sz * 0.9, Math.abs(edgeX - x)); list.push({ x, h: 0.25 * sz }); }
      say('goes to peek'); chain(list, () => { B.st = 'peek'; B.side = side; B.peekT = X.now() + rr(5, 12); B.slide = 0; });
    }
    function stepPeek(dt) {
      // slide out until the face centre is just inside the screen edge: half the screen (one eye) still peeks in
      const sz = X.size(), out = Math.max(0, (B.side < 0 ? X.area().left - X.area().screenL : X.area().screenR - X.area().right) - 0.08 * sz), cur = X.cursor;
      B.slide = Math.min(1, B.slide + dt / 0.9);
      X.setOut(B.side < 0 ? out * B.slide : 0, B.side > 0 ? out * B.slide : 0);
      X.P.x += B.side * out * (dt / 0.9) * (B.slide < 1 ? 1 : 0);
      const C = X.face(); B.lookAt = { x: C.x - B.side * 600, y: C.y - 80 };           // looks back into the screen
      const near = cur.pos && cur.still() < 2 && Math.hypot(cur.pos.x - C.x, cur.pos.y - C.y) < sz * 1.6;
      if (X.now() > B.peekT || near) {
        X.setOut(0, 0); B.st = 'idle'; B.lookAt = null;
        if (near && free()) act('peekabooFound');
        const A = X.area(); chain([{ x: clamp(C.x - B.side * sz * 1.4, A.left, A.right), h: 0.45 * sz, crouch: 0.2 }]);
        say(near ? 'peekaboo!' : 'comes back');
      }
    }

    // ── the mouse
    function mouseBits(dt) {
      const cur = X.cursor, t = X.now(), sz = X.size(), C = X.face(), A = X.area(), m = mood();
      if (!cur.pos) return false;
      const q = cur.pos, dx = q.x - C.x, dy = q.y - C.y, dist = Math.hypot(dx, dy), sp = Math.hypot(cur.vel.x, cur.vel.y);
      // rubbing the cursor over goober: nuzzles into it, then hearts
      if (cur.over) {
        B.hoverT += dt; if (cur.still() < 0.35) B.rubT += dt;
        B.nextWhim = Math.max(B.nextWhim, t + 4);
        if (B.rubT > 0.9 && ready('nuzzle') && free()) {
          const side = dx < 0 ? 'left' : 'right', n = B.rubT > 4 ? 3 : B.rubT > 2 ? 2 : 1;
          act(B.rubT > 5 && Math.random() < 0.5 ? pick(['hearts', 'love.short']) : `nuzzle.${n}.${side}.${pick(['adore', 'plump', 'softSmile'])}`);
          cd('nuzzle', rr(2.5, 4)); say('nuzzles the cursor');
        }
        return true;
      }
      B.hoverT = 0; B.rubT = Math.max(0, B.rubT - dt * 0.5);
      // a fast swipe right at it: hop out of the way (more likely when shy / anxious)
      const coming = (cur.vel.x * -dx + cur.vel.y * -dy) / (dist + 1e-6);
      if (sp > 1100 && coming > 700 && dist < sz * 1.4 && ready('flee') && Math.random() < (SKITTISH[m] || 0.1) + 0.15) {
        cd('flee', rr(3, 6)); say('dodges');
        if (free()) act(pick(['startle.small.surprised', 'startle.small.worried']));
        const dir = dx > 0 ? -1 : 1;
        chain([{ x: C.x + dir * sz * 0.9, h: 0.45 * sz, crouch: 0.05 }, { x: C.x + dir * sz * 1.7, h: 0.25 * sz }]);
        return true;
      }
      const keen = PLAYFUL[m] || 0.4;
      // the cursor sits still within reach above it: wiggle… and pounce
      const reach = sz * 2.6, still = cur.still();
      if (still > 0.9 && still < 6 && Math.abs(dx) < reach && dy < -sz * 0.25 && dy > -sz * 3.2 && ready('pounce')) {
        cd('pounce', 2.5);                                         // re-check soon, but don't decide every frame
        if (Math.random() < keen * 0.9) {
          cd('pounce', rr(7, 22) / Math.max(0.4, energy()));
          say('pounces!');
          let caught = false;
          const sneaky = (MISCHIEF[m] || 0.15) * (0.6 + 0.8 * feisty());
          const willSteal = () => X.canSteal() && X.settings().steal && ready('steal') && Math.random() < sneaky;
          chain([{ at: () => ({ x: q.x, y: q.y }), crouch: rr(0.45, 0.8), wiggle: true, rest: 0.25,
            onLaunch: () => g.preview('focused', 0.5),
            // caught it in mid-air: either a boop, or it grabs the cursor right there and carries it down
            inAir: () => { if (!caught && cur.pos) { const F = X.face(); if (Math.hypot(cur.pos.x - F.x, cur.pos.y - F.y) < sz * 0.45) { caught = true; if (willSteal()) grab(cur.pos); } } },
            onLand: () => {
              if (!caught) { if (free()) act(pick(['pout.short.meek', 'huff', 'lookAround'])); say('missed'); return; }
              if (B.stealing) { runOff(); return; }
              if (free()) act(pick(['giggle.small', 'hop.1.joy', 'squishy.1.quick', 'proudNod.1'])); say('boop!');
            } }]);
        }
        return true;
      }
      // the cursor is about, but far: hop over to have a look (and sit next to it)
      if (still < 3 && Math.abs(dx) > sz * 2.4 && dy > -sz * 4 && ready('approach')) {
        cd('approach', 3);
        if (Math.random() < keen * 0.5) {
          cd('approach', rr(10, 25) / Math.max(0.4, energy()));
          const dir = Math.sign(dx), stop = q.x - dir * sz * 1.2, list = []; let x = C.x;
          while (Math.abs(stop - x) > sz * 0.3 && list.length < 7) { x += dir * Math.min(sz * rr(0.6, 1.0), Math.abs(stop - x)); list.push({ x, h: rr(0.2, 0.4) * sz }); }
          if (list.length) { say('hops over to the cursor'); chain(list, () => { B.lookAt = null; if (free() && Math.random() < 0.5) act(pick(['curiousTilt.left', 'lookTilt.left', 'wonder', 'stareAtYou'].filter((n) => g.actNames.indexOf(n) >= 0).concat(['wonder']))); }); }
          return true;
        }
      }
      return false;
    }

    // ── steal the cursor. It grabs it in mid-air the moment it catches it (the cursor slides onto the tip of an arm
    // in ~0.2 s, no jump), carries it down, hops off with it, then tosses it away. Pull the mouse back to free it.
    function grab(from) {
      const A = X.area(), C = X.face(), sz = X.size();
      const dir = C.x - A.left < sz * 3 ? 1 : A.right - C.x < sz * 3 ? -1 : (Math.random() < 0.5 ? -1 : 1);
      say('steals the cursor!'); cd('steal', rr(90, 240));
      if (free()) act(pick(['mischief', 'scheme']));
      B.steal = { dir, t0: X.now(), from: { x: from.x, y: from.y }, sets: [], pull: 0, seen: null };
      B.stealing = true; X.squash(-0.12); setTimeout(() => X.squash(0), 120);   // a little "got it!" squeeze
    }
    function runOff() {                                           // after landing with it: hop away, then toss it
      const C = X.face(), sz = X.size(), dir = B.steal.dir; let x = C.x;
      const list = [];
      for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) { x += dir * rr(0.7, 1.1) * sz; list.push({ x, h: rr(0.3, 0.6) * sz, rest: rr(0.1, 0.3) }); }
      B.hops = list; B.then = () => letGo(true);
    }
    // where an arm tip is on screen (the arm on the side it's running to)
    const armTip = (dir) => X.toScreen(dir > 0 ? 452 : 48, 196);
    function holdCursor() {
      const S = B.steal; if (!S) return;
      const t = X.now(), cur = X.cursor, tip = armTip(S.dir), k = Math.min(1, (t - S.t0) / 0.22), e = k * k * (3 - 2 * k);
      const to = { x: S.from.x + (tip.x - S.from.x) * e, y: S.from.y + (tip.y - S.from.y) * e };
      // you pulling it back: a real mouse moves relative to where goober last put it, so each cursor reading is off
      // by your bit of motion. Add those up against the nearest position goober set in the last 0.6 s (moving the
      // cursor and reading it back both lag, more on Windows), ignoring the first half second and small wobble.
      if (cur.pos && cur.pos !== S.seen && S.sets.length && t - S.t0 > 0.5) {
        S.seen = cur.pos;
        let dmin = Infinity; for (const q of S.sets) dmin = Math.min(dmin, Math.hypot(cur.pos.x - q.x, cur.pos.y - q.y));
        if (dmin > 14) S.pull += dmin - 14; else S.pull = Math.max(0, S.pull - 4);
        if (S.pull > X.size() * 1.2) { letGo(false); return; }
      }
      X.cursorTo(to.x, to.y); S.sets.push({ x: to.x, y: to.y, t }); while (S.sets.length && t - S.sets[0].t > 0.6) S.sets.shift();
      B.lookAt = to;
    }
    function letGo(done) {
      if (!B.steal) return;
      const S = B.steal; B.steal = null; B.stealing = false;
      if (done) {                                                 // toss it: the cursor flies off the arm and slows down
        const tip = armTip(S.dir);
        B.toss = { x: tip.x, y: tip.y, vx: S.dir * rr(900, 1400), vy: -rr(350, 650), t0: X.now() };
        say('lets go'); if (free()) act(pick(['giggle.small', 'giggle', 'proudWink.wink', 'mischief']));
      } else { cancel(); say('you took it back'); if (free()) act(pick(['pout.short.grumpy', 'huff', 'pout.short.meek'])); }
    }
    function stepToss(dt) {
      const T = B.toss, A = X.area();
      if (X.now() - T.t0 > 0.45) { B.toss = null; return; }
      T.vy += 2200 * dt; T.vx *= Math.exp(-dt * 4); T.vy *= Math.exp(-dt * 2);
      T.x = clamp(T.x + T.vx * dt, A.screenL + 2, A.screenR - 2); T.y += T.vy * dt;
      X.cursorTo(T.x, T.y);
    }

    // ── every frame
    function update(dt) {
      const t = X.now(), P = X.P;
      if (P.held || g.mode !== 'awake') {                          // in your hand, asleep or waking: the body is yours
        if (B.stealing) letGo(false);
        if (B.st !== 'idle') { cancel(); X.setOut(0, 0); }
        B.nextWhim = Math.max(B.nextWhim, t + rr(3, 6));
        return;
      }
      if (B.toss) stepToss(dt);
      if (B.stealing) holdCursor();
      if (B.st === 'hopping') { stepChain(); return; }
      if (B.st === 'peek') { stepPeek(dt); return; }
      if (!P.ground && X.settings().gravity) return;                // thrown: wait until it's down
      if (X.settings().mousePlay && mouseBits(dt)) return;
      if (X.settings().roam && t >= B.nextWhim) { B.nextWhim = t + rr(6, 20) / Math.max(0.25, energy()); whim(); }
    }
    return { update, get lookAt() { return B.lookAt; }, get state() { return B.st; }, get stealing() { return !!B.stealing; }, B, peek, whim, grab, runOff, leapToScreen };
  };
})(typeof window !== 'undefined' ? window : globalThis);
