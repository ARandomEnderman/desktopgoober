// node tools/check.js [out-dir] → opens the desktop pet (pet.html) in its browser preview mode,
// headless: first run drops it from the top, then it is grabbed by an arm, swung, thrown, and knocked.
// Prints the engine's log and fails on page errors. With out-dir, saves screenshots there.
const path = require('path');
const { chromium } = require('playwright');
// the engine must be the newest goober.js: if a goober checkout sits next to this repo and its engine differs, fail
{ const fs = require('fs'), src = path.join(__dirname, '../../goober/sim/goober.js'), dst = path.join(__dirname, '../engine/goober.js');
  if (fs.existsSync(src) && !fs.readFileSync(src).equals(fs.readFileSync(dst))) {
    console.log('ENGINE IS OLD: ../goober/sim/goober.js is different. Run: git -C ../goober pull --ff-only && node tools/sync-engine.js'); process.exit(1); } }
(async () => {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.addInitScript(() => { window.__log = []; });
  await p.goto('file://' + path.join(__dirname, '../pet.html'));
  await p.waitForFunction(() => window.__goober);
  await p.evaluate(() => window.__goober.g.on((m) => window.__log.push(m)));
  const st = () => p.evaluate(() => { const { P } = window.__goober; return { x: Math.round(P.x), y: Math.round(P.y), rot: +P.rot.toFixed(2), ground: P.ground, face: window.__goober.g.face }; });
  const log = async (what) => { const l = await p.evaluate(() => window.__log.splice(0)); console.log(what.padEnd(14), JSON.stringify(await st()), l.length ? '· ' + l.join(' · ') : ''); };
  await p.waitForTimeout(300); await log('falling');
  await p.waitForTimeout(1700); await log('landed');
  if (out) await p.screenshot({ path: path.join(out, 'desk-1-landed.png') });
  // grab the right arm tip and hold it up: it should hang with its middle below the grab point
  const arm = await p.evaluate(() => { const { P, grab } = window.__goober, s = 200 / 500; return { x: P.x + (440 - grab.x) * s, y: P.y + (200 - grab.y) * s }; });
  await p.mouse.move(arm.x, arm.y); await p.mouse.down();
  for (let i = 0; i < 20; i++) { await p.mouse.move(arm.x - i * 15, arm.y - i * 12); await p.waitForTimeout(16); }
  await p.waitForTimeout(1800); await log('hanging');
  if (out) await p.screenshot({ path: path.join(out, 'desk-2-hanging.png') });
  for (let i = 0; i < 12; i++) { await p.mouse.move(arm.x - 300 + i * 40, arm.y - 240 - i * 8); await p.waitForTimeout(16); }
  await p.mouse.up(); await p.waitForTimeout(250); await log('thrown');
  if (out) await p.screenshot({ path: path.join(out, 'desk-3-flying.png') });
  await p.waitForTimeout(2500); await log('after throw');
  const c = await p.evaluate(() => { const { P, grab } = window.__goober, s = 200 / 500; return { x: P.x + (250 - grab.x) * s, y: P.y + (262 - grab.y) * s }; });
  await p.mouse.click(c.x, c.y); await p.waitForTimeout(900); await log('knock');
  await p.mouse.move(c.x - 400, c.y - 300); await p.waitForTimeout(2500);
  if (out) await p.screenshot({ path: path.join(out, 'desk-4-watching.png') });
  // grab it and shake it hard (~4 Hz): should go dizzy
  const c2 = await p.evaluate(() => { const { P, grab } = window.__goober, s = 200 / 500; return { x: P.x + (250 - grab.x) * s, y: P.y + (262 - grab.y) * s }; });
  await p.mouse.move(c2.x, c2.y); await p.mouse.down();
  for (let i = 0; i < 90; i++) { await p.mouse.move(c2.x + Math.sin(i * 0.42) * 120, c2.y - 150 + Math.sin(i * 0.3) * 30); await p.waitForTimeout(16); }
  await log('shaken');
  await p.mouse.up(); await p.waitForTimeout(6000); await log('6 s later');
  console.log(errs.length ? 'ERRORS: ' + errs.join(' | ') : 'no page errors');
  await b.close(); process.exit(errs.length ? 1 : 0);
})();
