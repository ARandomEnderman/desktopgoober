# goober desktop pet

goober living on your computer: a little star that sits on your taskbar, hops around the screen and plays with your
mouse. The eyes run the goober engine (`engine/goober.js`, a copy of the one from the main goober project), with its
own goober ID, moods and personality.

## Install
Download the newest version from **[Releases](https://github.com/ARandomEnderman/desktopgoober/releases/latest)**:

| | file | |
|---|---|---|
| Windows | `goober-setup-….exe` | run it; goober appears straight away. Windows may say "Windows protected your PC" (the app isn't code-signed): **More info → Run anyway**. |
| macOS | `goober-…-mac.dmg` | drag goober into Applications. The first time, **right-click → Open** (it isn't signed). If macOS says it's "damaged", run `xattr -cr /Applications/goober.app` in Terminal once. |
| Linux | `goober-….AppImage` | make it executable and run it. Cursor stealing needs `xdotool`. |

**Updates are automatic** (Windows and Linux): every change pushed here builds a new release, and goober checks for
it when it starts and every 3 hours, downloads it in the background and restarts into the new version by itself.
Right-click → "Update automatically" turns that off (then it shows "Restart to update" instead). macOS doesn't let
unsigned apps update themselves, so on a Mac the menu shows "New version — download…" when there is one.

To have goober start with your computer: right-click → "Start with the computer".

## Run from the source
Needs [Node.js](https://nodejs.org) (any recent LTS):

```bash
npm install
```

```bash
npm start
```

**Just want a peek?** Open `pet.html` in a browser: it fakes a desktop inside the page (no Electron needed).

`npm run dist` builds an installer for the computer you're on into `dist/`.

## What it does
**By itself** (more or less often depending on its mood and personality): hops about in little chains, boings in
place, takes big leaps across the screen, and slides half off the screen edge to peek back in. It squashes and
stretches and leans into its jumps.

**With your mouse**
| you | goober |
|---|---|
| move the cursor around | watches it; sometimes hops over to sit next to it |
| hold the cursor still above it | wiggles… and pounces on it (boop!) |
| … and it catches it | now and then it **steals the cursor** and hops off with it; pull the mouse back to free it |
| swipe fast at it | hops out of the way (shy and anxious moods especially) |
| rub the cursor over it | nuzzles into it, then hearts |
| click it | a knock on its back (double click = double knock) |
| drag it | it hangs from wherever you grabbed it and swings; grab an arm and it turns to hang below it |
| throw it | free fall → "wheee", lands starstruck, or tumbles if the fall was long |
| shake it hard | dizzy (and grumpy if you keep doing it) |

At night (23–07) it gets sleepy and sleeps; it wakes in the morning or with a double knock.

**Right-click menu** (on goober or the tray icon): hops around by itself, plays with the mouse, allowed to steal the
mouse, fall to the taskbar (off = it floats where you put it), sleep at night, size, body colour, always on top, start
with the computer, copy / load goober ID, hatch a new goober, bring it back on screen.

Stealing the cursor uses what each system already has: PowerShell on Windows, JavaScript for Automation on macOS,
`xdotool` on Linux (if installed; otherwise that option is greyed out).

## How it's built
- `main.js` (Electron): a transparent, frameless, always-on-top window; reads the cursor anywhere on screen, moves it
  when goober steals it; menu, tray, settings (`settings.json` in the app's user data folder).
- `pet.js`: the body. The window is goober: it moves the window, runs the physics (gravity, landing, pendulum swing
  round the grab point, squash & stretch) and turns that into a fake accelerometer for the engine (±2 g, free fall ≈ 0 g).
  The empty corners of the window let clicks through.
- `play.js`: what it does with its body: hops, leaps, peeking, and everything with the mouse.
- `pet.html`: the star body + the round screen canvas.
- `engine/goober.js`: the eyes, moods, personality and IDs (a copy; `node tools/sync-engine.js` refreshes it).
- Tests (headless, browser preview, need Playwright): `node tools/check.js` (drop, land, hang, throw, knock, shake),
  `node tools/play.js` (hops, pounce, steal, pull back, nuzzle, dodge, peek). Both take an output folder for screenshots.

- Releases: `.github/workflows/release.yml` builds Windows / macOS / Linux on every push to `main` (version
  `0.2.<run number>`) and publishes them; `electron-updater` in `main.js` picks them up.
