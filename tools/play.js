// node tools/play.js [out-dir] → the desktop pet's play (play.js), headless in browser-preview mode:
// hops by itself, pounces on a still cursor and steals it, lets go when you pull it back, nuzzles when you rub the
// cursor over it, dodges a fast swipe, stays in sight, leaps between two screens. Prints what happened; fails on page errors or if a
// behaviour never shows up. With out-dir, saves screenshots and a filmstrip of a hop (hop-strip.png).
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 720 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.addInitScript(() => { window.__playLog = []; window.__log = []; });
  await p.goto('file://' + path.join(__dirname, '../pet.html'));
  await p.waitForFunction(() => window.__goober);
  await p.evaluate(() => window.__goober.g.on((m) => window.__log.push(m)));
  await p.mouse.move(5, 5);
  const face = () => p.evaluate(() => { const { P, grab } = window.__goober, s = 200 / 500; return { x: P.x + (250 - grab.x) * s, y: P.y + (262 - grab.y) * s }; });
  const drain = () => p.evaluate(() => ({ play: window.__playLog.splice(0), eng: window.__log.splice(0) }));
  const fails = [];
  const expect = async (what, re, ms, nudge) => {
    const t0 = Date.now(); let seen = [], lastNudge = t0;
    while (Date.now() - t0 < ms) {
      if (nudge && Date.now() - lastNudge > 4000) { lastNudge = Date.now(); await nudge(); } const d = await drain(); seen = seen.concat(d.play.map((m) => '[' + m + ']'), d.eng); if (seen.some((m) => re.test(m))) break; await p.waitForTimeout(100); }
    const ok = seen.some((m) => re.test(m)); if (!ok) fails.push(what);
    console.log((ok ? 'ok   ' : 'MISS ') + what.padEnd(24), seen.slice(0, 8).join(' · '));
    return ok;
  };
  // pin mood + personality and switch off everything but the behaviour under test (so a dodge or a hop over to the
  // cursor can't move goober away mid-test)
  const ALL = ['pounce', 'approach', 'flee', 'nuzzle', 'steal'];
  const setup = (mood, row, allow) => p.evaluate(([m, r, ok, all]) => { const g = window.__goober.g; g.setPersonality(3, r, true); g.setMood(m);
    const B = window.__goober.play.B; B.cd = {}; for (const k of all) if (ok.indexOf(k) < 0) B.cd[k] = 1e12; B.nextWhim = 1e9; }, [mood, row, allow || ALL, ALL]);
  await p.waitForTimeout(2500); await drain();

  // 0. it watches the mouse: wiggle the cursor on its left, then on its right; its gaze should follow
  await setup('curious', 2, []);
  await p.evaluate(() => { window.__goober.watch.on = true; window.__goober.watch.until = 1e12; });   // its mood can't look away now
  let fw = await face(), sides = [];
  for (let i = 0; i < 60; i++) { await p.mouse.move(fw.x + Math.sin(i * 0.3) * 80, fw.y - 200); await p.waitForTimeout(50); }   // it greets you first
  for (const side of [-1, 1]) {
    let g0 = 0;   // the furthest it looked that way while the cursor was there
    for (let i = 0; i < 40; i++) { await p.mouse.move(Math.max(60, Math.min(1140, fw.x + side * 380)) + Math.sin(i * 0.4) * 40, fw.y - 120 + Math.cos(i * 0.3) * 30); await p.waitForTimeout(50);
      if (i > 15 && i % 3 === 0) { const gx = await p.evaluate(() => window.__goober.g.gaze[0]); if (gx * side > g0 * side) g0 = gx; } }
    sides.push(+g0.toFixed(2));
  }
  // judge a side only if the cursor could get well away from goober on it (it may sit near a screen edge)
  const room = [fw.x - Math.max(60, fw.x - 380), Math.min(1140, fw.x + 380) - fw.x];
  const watches = (room[0] < 200 || sides[0] < -0.1) && (room[1] < 200 || sides[1] > 0.1) && (room[0] >= 200 || room[1] >= 200);
  if (!watches) fails.push('watches the cursor');
  console.log((watches ? 'ok   ' : 'MISS ') + 'watches the cursor'.padEnd(24), 'gaze x left/right:', sides.join(' / '));
  await p.evaluate(() => { window.__goober.watch.until = 0; });
  await p.mouse.move(5, 5); await p.waitForTimeout(500); await drain();

  // 1. by itself: a few whims; it must stay on the screen. Filmstrip of the first hop.
  await setup('hyper', 2, ['approach', 'pounce']);
  const strip = [];
  await p.evaluate(() => { window.__goober.play.B.nextWhim = 0; });
  for (let i = 0; i < 14 && out; i++) { strip.push(await p.screenshot({ clip: { x: 0, y: 300, width: 1200, height: 376 } })); await p.waitForTimeout(45); }
  await p.waitForTimeout(3000);
  for (let i = 0; i < 6; i++) { await p.evaluate(() => window.__goober.play.whim()); await p.waitForTimeout(2600); }
  const f1 = await face(); const onScreen = f1.x > 0 && f1.x < 1200 && f1.y < 680;
  if (!onScreen) fails.push('stays on screen');
  console.log((onScreen ? 'ok   ' : 'MISS ') + 'whims'.padEnd(24), (await drain()).play.join(' · '), JSON.stringify(f1));

  // 2. hold the cursor still above it: wiggle, pounce, catch → steal (sassy + feisty = always steals a caught cursor)
  await setup('sassy', 4, ['pounce', 'steal']); await p.waitForTimeout(1500); await drain();
  let f = await face(); await p.mouse.move(f.x + (f.x < 800 ? 120 : -120), f.y - 170, { steps: 8 });
  // goober loses interest in a cursor left still for > 6 s: nudge it a pixel now and then, like a hand resting on a mouse
  let nud = 1; const nudge = async () => { const c = await p.evaluate(() => window.__goober.play.B.steal ? null : 1); if (c) { nud = -nud; const m = await face(); await p.mouse.move(m.x + (m.x < 800 ? 120 : -120) + nud, m.y - 170); } };
  await expect('pounce', /pounces/, 20000, nudge);
  const stole = await expect('steal', /steals the cursor|boop|missed/, 4000);
  if (out) await p.screenshot({ path: path.join(out, 'play-steal.png') });
  await expect('lets go', /lets go|you took it back/, 6000);

  // 3. steal again, and pull the cursor back mid-steal
  await setup('sassy', 4, ['pounce', 'steal']); await p.waitForTimeout(1500); await drain();
  f = await face(); await p.mouse.move(f.x + (f.x > 400 ? -100 : 100), f.y - 160, { steps: 8 });
  let got = false;
  for (let k = 0; k < 3 && !got; k++) {      // a pounce can genuinely miss the cursor: then let it try again
    got = await expect('pounce + steal' + (k ? ' (again)' : ''), /steals the cursor/, 9000, async () => { nud = -nud; await p.mouse.move(f.x + (f.x > 400 ? -100 : 100) + nud, f.y - 160); });
    if (!got) { console.log('     state:', await p.evaluate(() => { const G = window.__goober, B = G.play.B; return JSON.stringify({ st: B.st, stealing: B.stealing, toss: !!B.toss, ground: G.P.ground, mode: G.g.mode, cd: B.cd }); }), JSON.stringify(await face()));
      await p.evaluate(() => { window.__goober.play.B.cd.pounce = 0; }); f = await face(); await p.mouse.move(f.x + (f.x > 400 ? -103 : 103), f.y - 163, { steps: 4 }); }
  }
  if (got) { fails.splice(fails.indexOf('pounce + steal'), fails.indexOf('pounce + steal') >= 0 ? 1 : 0); fails.splice(fails.indexOf('pounce + steal (again)'), fails.indexOf('pounce + steal (again)') >= 0 ? 1 : 0);
    // tug it back the way a hand does: a steady pull over half a second (after its half-second grip)
    await p.waitForTimeout(650); const c0 = await p.evaluate(() => window.__goober.play.B.steal && window.__goober.play.B.steal.sets.slice(-1)[0]);
    if (c0) for (let i = 1; i <= 12; i++) { await p.mouse.move(c0.x - i * 35, c0.y - i * 20); await p.waitForTimeout(40); }
    await expect('pulled back', /you took it back/, 2000);
  }

  // 4. rub the cursor over it
  await p.mouse.move(1190, 10); await setup('cuddly', 0, ['nuzzle']); await p.waitForTimeout(2500); await drain();
  f = await face();
  for (let i = 0; i < 60; i++) { await p.mouse.move(f.x + Math.cos(i * 0.5) * 30, f.y + Math.sin(i * 0.5) * 20); await p.waitForTimeout(40); }
  await expect('nuzzle', /nuzzles/, 1500);
  if (out) await p.screenshot({ path: path.join(out, 'play-nuzzle.png') });

  // 5. swipe at it fast (anxious: skittish)
  await p.mouse.move(f.x - 600, f.y - 30); await setup('anxious', 1, ['flee']); await p.waitForTimeout(1200); await drain();
  f = await face(); let ok5 = false;
  for (let k = 0; k < 4 && !ok5; k++) {
    await p.mouse.move(f.x - 500, f.y - 20);
    for (let i = 0; i <= 8; i++) { await p.mouse.move(f.x - 500 + i * 60, f.y - 20); await p.waitForTimeout(12); }
    await p.waitForTimeout(400); const d = await drain(); ok5 = d.play.some((m) => /dodges/.test(m));
    if (!ok5) console.log('     swipe', k, d.play.join(' · '), await p.evaluate(() => JSON.stringify({ st: window.__goober.play.B.st, mood: window.__goober.g.mood })));
    if (!ok5) { await p.evaluate(() => { window.__goober.play.B.cd.flee = 0; }); await p.mouse.move(f.x - 600, f.y - 30); await p.waitForTimeout(500); f = await face(); }
  }
  if (!ok5) fails.push('dodge'); console.log((ok5 ? 'ok   ' : 'MISS ') + 'dodge');

  // 6. it stays in sight: no squash left after big leaps; half off the edge → hops back in; lost / broken → comes back
  await p.mouse.move(600, 100); await setup('hyper', 2, []); await p.waitForTimeout(1500); await drain();
  let sqMax = 0;
  for (let k = 0; k < 3; k++) {
    await p.evaluate(() => { const A = window.__goober; A.play.B.nextWhim = 1e9; });
    for (let w = 0; w < 30; w++) { if (await p.evaluate(() => window.__goober.play.state === 'idle' && window.__goober.P.ground)) break; await p.waitForTimeout(100); }
    // force a big leap (the whim that used to leave it squashed)
    await p.evaluate(() => { const r = Math.random; Math.random = () => 0.6; try { window.__goober.play.whim(); } finally { Math.random = r; } });
    await p.waitForTimeout(2600);
    sqMax = Math.max(sqMax, await p.evaluate(() => Math.abs(window.__goober.SQ.x)));
  }
  const relaxed = sqMax < 0.03; if (!relaxed) fails.push('relaxes after leaps');
  console.log((relaxed ? 'ok   ' : 'MISS ') + 'relaxes after leaps'.padEnd(24), 'leftover squash', sqMax.toFixed(3));
  await p.evaluate(() => { const { P } = window.__goober; P.x = 20; P.ground = true; P.vx = P.vy = 0; });    // half off the left edge
  let back = false;
  for (let w = 0; w < 30 && !back; w++) { await p.waitForTimeout(100); back = (await face()).x > 95; }
  if (!back) fails.push('hops back in'); console.log((back ? 'ok   ' : 'MISS ') + 'hops back in from the edge', JSON.stringify(await face()));
  await p.evaluate(() => { window.__goober.P.x = NaN; });
  await p.waitForTimeout(1500); let fb = await face(); const okNaN = Number.isFinite(fb.x) && fb.x > 0 && fb.x < 1200;
  await p.evaluate(() => { const { P } = window.__goober; P.x = -3000; P.y = 300; P.vx = P.vy = 0; });
  await p.waitForTimeout(4500); fb = await face(); const okLost = fb.x > 0 && fb.x < 1200 && fb.y > 0 && fb.y < 720;
  if (!okNaN || !okLost) fails.push('comes back'); console.log((okNaN && okLost ? 'ok   ' : 'MISS ') + 'comes back when lost', JSON.stringify(fb));

  // 7. two screens side by side (?screens=2; the right one has a higher floor): leap over and back
  {
    const q = await b.newPage({ viewport: { width: 1200, height: 720 } });
    q.on('pageerror', (e) => errs.push(e.message));
    await q.goto('file://' + path.join(__dirname, '../pet.html') + '?screens=2'); await q.waitForFunction(() => window.__goober);
    await q.mouse.move(5, 5); await q.waitForTimeout(2500);
    await q.evaluate(() => { const G = window.__goober; G.play.B.nextWhim = 1e9; for (const k of ['pounce', 'approach', 'flee', 'nuzzle', 'steal']) G.play.B.cd[k] = 1e12; });
    const fq = () => q.evaluate(() => { const { P, grab } = window.__goober, s = 200 / 500; return { x: Math.round(P.x + (250 - grab.x) * s), y: Math.round(P.y + (262 - grab.y) * s), ground: P.ground }; });
    const floorL = 720 - 44 - (471 - 262) * 0.4, floorR = 720 - 164 - (471 - 262) * 0.4, res = [];
    const startRight = (await fq()).x > 600;
    for (const side of startRight ? [-1, 1] : [1, -1]) {
      for (let k = 0; k < 40; k++) { if (await q.evaluate(() => window.__goober.play.state === 'idle' && window.__goober.P.ground)) break; await q.waitForTimeout(100); }
      const went = await q.evaluate((sd) => window.__goober.play.leapToScreen(sd), side);
      await q.waitForTimeout(2600); const r = await fq();
      const ok = went && (side > 0 ? r.x > 600 && Math.abs(r.y - floorR) < 3 : r.x < 600 && Math.abs(r.y - floorL) < 3) && r.ground;
      res.push(ok); console.log((ok ? 'ok   ' : 'MISS ') + ('leap to the ' + (side > 0 ? 'right' : 'left') + ' screen').padEnd(24), JSON.stringify(r));
      if (out) await q.screenshot({ path: path.join(out, 'play-screens-' + (side > 0 ? 'right' : 'left') + '.png') });
    }
    if (res.some((v) => !v)) fails.push('other screen');
    await q.close();
  }

  if (out && strip.length) {
    const imgs = strip.map((buf) => 'data:image/png;base64,' + buf.toString('base64'));
    const q = await b.newPage({ viewport: { width: 1200, height: 376 * 2 } });
    await q.setContent(`<body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(7,1fr)">${imgs.map((s) => `<img src="${s}" style="width:100%;height:188px;object-fit:cover;object-position:right">`).join('')}</body>`);
    await q.screenshot({ path: path.join(out, 'hop-strip.png'), fullPage: true });
  }
  console.log(errs.length ? 'ERRORS: ' + errs.join(' | ') : 'no page errors');
  console.log(fails.length ? 'MISSED: ' + fails.join(', ') : 'all behaviours seen');
  await b.close(); process.exit(errs.length || fails.length ? 1 : 0);
})();
