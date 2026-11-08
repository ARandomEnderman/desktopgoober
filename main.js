// goober desktop pet: the Electron side. One transparent, frameless, always-on-top window that the renderer
// (pet.js) moves around the screen itself. This file only does what a web page can't: move the window, read the
// cursor anywhere on screen, move the cursor (when goober steals it), menus, the tray icon, and remembering
// settings between runs.
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, clipboard, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const SIZES = { small: 140, medium: 200, large: 280 };              // device width in px (the star is 500 units wide)
const BODIES = { black: ['#17181f', '#2a2c38'], white: ['#f4f1ea', '#ffffff'], pink: ['#ff8fb1', '#ffc2d4'], blue: ['#5b6cff', '#8f9bff'],
  green: ['#2bb673', '#6fe0a8'], orange: ['#ffb020', '#ffd27a'], purple: ['#8e5cff', '#bb9bff'] };   // same list as the simulator
const DEFAULTS = { id: null, size: 'medium', body: 'black', gravity: true, onTop: true, nightSleep: true,
  roam: true, mousePlay: true, steal: true, autoUpdate: true, x: null, y: null };

// ── settings (userData/settings.json)
const file = () => path.join(app.getPath('userData'), 'settings.json');
let S = { ...DEFAULTS };
try { S = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch (e) { /* first run */ }
let saveT = null;
function save(patch) {
  Object.assign(S, patch || {});
  clearTimeout(saveT);
  saveT = setTimeout(() => { try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(S, null, 2)); } catch (e) { console.error(e); } }, 400);
}

const winSize = () => Math.round(SIZES[S.size] * 2.1);      // room for goober to swing round wherever you grab it
let win = null, tray = null;

// work areas of all screens, the main screen first (goober starts and is brought back there)
function displays() { const p = screen.getPrimaryDisplay().id; return screen.getAllDisplays().sort((a, b) => (b.id === p) - (a.id === p)).map((d) => d.workArea); }
const send = (ch, v) => { if (win && !win.isDestroyed()) win.webContents.send(ch, v); };

// ── moving the real cursor (goober grabs it and drags it about). Electron can't do this itself, so a small helper
// process per platform does it, fed one "x y" line per move. No native modules, nothing to compile.
//   Windows: PowerShell + user32 SetCursorPos (physical pixels, so DIP points are converted first)
//   macOS:   JavaScript for Automation + CoreGraphics CGWarpMouseCursorPosition (points, same as Electron)
//   Linux:   xdotool, if it's installed
const mouse = { proc: null, ok: false, kind: null, lastSpawn: 0 };
function startMouseHelper() {
  try {
    if (process.platform === 'win32') {
      const ps = `Add-Type -Name U -Namespace G -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();';
[G.U]::SetProcessDPIAware() | Out-Null
while ($true) { $l = [Console]::In.ReadLine(); if ($l -eq $null) { break }; $p = $l.Split(' '); [G.U]::SetCursorPos([int]$p[0], [int]$p[1]) | Out-Null }`;
      mouse.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      mouse.kind = 'pipe';
    } else if (process.platform === 'darwin') {
      const js = `ObjC.import('CoreGraphics'); ObjC.import('Foundation');
const inp = $.NSFileHandle.fileHandleWithStandardInput; let buf = '';
while (true) { const d = inp.availableData; if (d.length === 0) break;
  buf += $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js; const lines = buf.split('\\n'); buf = lines.pop();
  const l = lines.pop(); if (l) { const p = l.split(' '); $.CGWarpMouseCursorPosition({ x: +p[0], y: +p[1] }); $.CGAssociateMouseAndMouseCursorPosition(true); } }`;
      mouse.proc = spawn('osascript', ['-l', 'JavaScript', '-e', js], { stdio: ['pipe', 'ignore', 'ignore'] });
      mouse.kind = 'pipe';
    } else {
      execFileSync('xdotool', ['version'], { stdio: 'ignore' });
      mouse.kind = 'xdotool';
    }
    if (mouse.proc) { mouse.proc.on('exit', () => { mouse.proc = null; mouse.ok = false; }); mouse.proc.on('error', () => { mouse.ok = false; }); }
    mouse.ok = true;
  } catch (e) { mouse.ok = false; }
}
function moveCursor(x, y) {
  if (!mouse.ok) return;
  if (mouse.kind === 'pipe' && mouse.proc) {
    let p = { x: Math.round(x), y: Math.round(y) };
    if (process.platform === 'win32') p = screen.dipToScreenPoint(p);
    mouse.proc.stdin.write(`${Math.round(p.x)} ${Math.round(p.y)}\n`);
  } else if (mouse.kind === 'xdotool') {
    const t = Date.now(); if (t - mouse.lastSpawn < 30) return; mouse.lastSpawn = t;   // a process per move: keep it ≤ ~30/s
    spawn('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y))], { stdio: 'ignore' }).on('error', () => {});
  }
}

function createWindow() {
  const W = winSize(), wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: W, height: W, x: wa.x + wa.width - W, y: wa.y + wa.height - W,
    transparent: true, frame: false, resizable: false, hasShadow: false, skipTaskbar: true, focusable: true,
    alwaysOnTop: S.onTop, fullscreenable: false, maximizable: false, minimizable: false, backgroundColor: '#00000000',
    title: 'goober', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  if (S.onTop) win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.setIgnoreMouseEvents(true, { forward: true });         // clicks fall through the empty corners; pet.js turns this off over the body
  win.loadFile(path.join(__dirname, 'pet.html'));
  win.on('closed', () => { win = null; });
}

// ── cursor anywhere on screen → goober watches it, chases it, pounces on it
setInterval(() => { if (win) send('cursor', screen.getCursorScreenPoint()); }, 33);

// ── IPC
ipcMain.handle('init', () => ({ settings: S, sizes: SIZES, bodies: BODIES, displays: displays(), win: winSize(), canSteal: mouse.ok }));
ipcMain.on('move', (e, x, y) => { if (win) win.setBounds({ x: Math.round(x), y: Math.round(y), width: winSize(), height: winSize() }); });
ipcMain.on('ignore', (e, on) => { if (win) win.setIgnoreMouseEvents(!!on, { forward: true }); });
ipcMain.on('cursorTo', (e, x, y) => { if (S.steal) moveCursor(x, y); });
ipcMain.on('save', (e, patch) => save(patch));
ipcMain.on('menu', () => buildMenu().popup({ window: win }));

function set(patch) { save(patch); send('settings', S); updateTray(); }

function buildMenu() {
  const radio = (key, val, label) => ({ label, type: 'radio', checked: S[key] === val, click: () => set({ [key]: val }) });
  const check = (key, label, extra) => ({ label, type: 'checkbox', checked: !!S[key], click: (m) => { set({ [key]: m.checked }); if (extra) extra(m.checked); } });
  return Menu.buildFromTemplate([
    { label: 'goober ' + app.getVersion(), enabled: false },
    { type: 'separator' },
    check('roam', 'Hops around by itself'),
    check('mousePlay', 'Plays with the mouse'),
    { ...check('steal', mouse.ok ? 'Allowed to steal the mouse' : 'Allowed to steal the mouse (not on this computer)'), enabled: mouse.ok },
    check('gravity', 'Fall to the taskbar'),
    check('nightSleep', 'Sleep at night (23–07)'),
    { type: 'separator' },
    { label: 'Size', submenu: [radio('size', 'small', 'Small'), radio('size', 'medium', 'Medium'), radio('size', 'large', 'Large')] },
    { label: 'Body colour', submenu: Object.keys(BODIES).map((b) => radio('body', b, b[0].toUpperCase() + b.slice(1))) },
    check('onTop', 'Always on top', (on) => { if (win) win.setAlwaysOnTop(on, 'floating'); }),
    ...(process.platform === 'linux' ? [] : [{ label: 'Start with the computer', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked }) }]),
    { type: 'separator' },
    // the clipboard is async since Electron 45 (readText/writeText return promises); await works on older ones too
    { label: 'Copy goober ID', click: async () => { try { await clipboard.writeText(S.id || ''); } catch (e) { console.error(e); } } },
    { label: 'Load goober ID from clipboard', click: async () => { try { send('loadId', String((await clipboard.readText()) || '').trim()); } catch (e) { console.error(e); } } },
    { label: 'Hatch a new goober…', click: () => send('reroll', 1) },
    { label: 'Bring back on screen', click: () => send('home', 1) },
    { type: 'separator' },
    ...updateItems(),
    ...(app.isPackaged ? [{ type: 'separator' }] : []),
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function updateTray() { if (tray) tray.setContextMenu(buildMenu()); }

// ── updates: every push to main on GitHub builds a new release (.github/workflows/release.yml). The installed app
// checks for it at start and every 3 hours, downloads it in the background and restarts into it (or waits for
// "Restart to update" if automatic updates are off). macOS only lets signed apps replace themselves, so there it
// just offers the download page. Not in `npm start` (no installed app to update).
const RELEASES = 'https://github.com/ARandomEnderman/desktopgoober/releases/latest';
const upd = { au: null, state: 'idle', version: null, error: null };   // idle | checking | none | available | ready | error
function setupUpdates() {
  if (!app.isPackaged) return;
  try { upd.au = require('electron-updater').autoUpdater; } catch (e) { return; }
  const au = upd.au, mac = process.platform === 'darwin';
  au.autoDownload = !mac; au.autoInstallOnAppQuit = true; au.logger = null;
  au.on('checking-for-update', () => { upd.state = 'checking'; updateTray(); });
  au.on('update-not-available', () => { upd.state = 'none'; updateTray(); });
  au.on('update-available', (i) => { upd.state = 'available'; upd.version = i.version; updateTray(); });
  au.on('update-downloaded', (i) => {
    upd.state = 'ready'; upd.version = i.version; updateTray();
    if (S.autoUpdate) setTimeout(() => au.quitAndInstall(true, true), 4000);   // silent install, then start again
  });
  au.on('error', (e) => { upd.state = 'error'; upd.error = String((e && e.message) || e).split('\n')[0]; updateTray(); });
  const check = () => { au.checkForUpdates().catch(() => {}); };
  setTimeout(check, 8000); setInterval(check, 3 * 3600 * 1000);
}
function updateItems() {
  if (!app.isPackaged) return [];
  const v = upd.version ? ' (v' + upd.version + ')' : '';
  const items = [];
  if (upd.state === 'ready') items.push({ label: 'Restart to update' + v, click: () => upd.au.quitAndInstall(true, true) });
  else if (upd.state === 'available' && process.platform === 'darwin') items.push({ label: 'New version' + v + ' — download…', click: () => shell.openExternal(RELEASES) });
  else if (upd.state === 'available') items.push({ label: 'Downloading update' + v + '…', enabled: false });
  else items.push({ label: upd.state === 'checking' ? 'Checking for updates…' : upd.state === 'none' ? 'Up to date — check again' : upd.state === 'error' ? 'Couldn\'t check for updates — try again' : 'Check for updates',
    enabled: upd.state !== 'checking' && !!upd.au, click: () => upd.au && upd.au.checkForUpdates().catch(() => {}) });
  if (process.platform !== 'darwin') items.push({ label: 'Update automatically', type: 'checkbox', checked: S.autoUpdate, click: (m) => set({ autoUpdate: m.checked }) });
  return items;
}

// One goober at a time. After an update the installer starts the new version while the old one is still closing,
// so don't give up at once: keep asking for the lock for up to 10 s (giving up straight away is how goober went
// missing after the first update). Starting goober again while it runs brings it back on screen.
function whenSingle(cb, tries) {
  if (app.requestSingleInstanceLock()) return cb();
  if (tries <= 0) return app.quit();
  setTimeout(() => whenSingle(cb, tries - 1), 500);
}
app.on('second-instance', () => send('home', 1));
app.whenReady().then(() => whenSingle(start, 20));
function start() {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  startMouseHelper();
  createWindow();
  setupUpdates();
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 18, height: 18 }));
    tray.setToolTip('goober'); updateTray();
    tray.on('click', () => send('home', 1));
  } catch (e) { console.error('no tray:', e.message); }
  screen.on('display-added', () => send('displays', displays()));
  screen.on('display-removed', () => send('displays', displays()));
  screen.on('display-metrics-changed', () => send('displays', displays()));
}
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { if (mouse.proc) { try { mouse.proc.stdin.end(); mouse.proc.kill(); } catch (e) { /* gone */ } } });
