// node tools/sync-engine.js [path/to/goober.js] → copies the goober engine into engine/goober.js.
// The engine is developed in the main goober project (sim/goober.js); this repo keeps its own copy so it runs on
// its own. Default source: a goober checkout next to this one (../goober/sim/goober.js). Only reads the source.
const fs = require('fs'), path = require('path');
const src = path.resolve(process.argv[2] || path.join(__dirname, '../../goober/sim/goober.js'));
const dst = path.join(__dirname, '../engine/goober.js');
if (!fs.existsSync(src)) { console.error('no engine at ' + src + ' (pass its path)'); process.exit(1); }
const a = fs.readFileSync(src), b = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
if (b && a.equals(b)) { console.log('engine already up to date'); process.exit(0); }
fs.writeFileSync(dst, a);
console.log('engine/goober.js updated from ' + src + ' (' + (a.length / 1024).toFixed(0) + ' kB) — run node tools/check.js and node tools/play.js');
