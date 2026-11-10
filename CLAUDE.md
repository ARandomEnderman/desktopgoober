# desktopgoober — notes for Claude sessions

goober as a desktop pet (Electron). goober is a star-shaped creature with a round screen showing two animated eyes;
this repo is the desktop version: it lives on the taskbar, hops around and plays with the mouse. See README.md.

**This repo is public.** Never commit personal information (email addresses, names beyond the GitHub handle, links
to private pages or private repos, order / supplier / price details, session links in files). Commit as
`ARandomEnderman <ARandomEnderman@users.noreply.github.com>`.

## Layout
- `main.js` Electron (window, cursor read/move, menu, tray, settings) · `preload.js` bridge
- `pet.js` body, physics, fake accelerometer, cursor watching, battery, watchdog · `play.js` behaviour (hops, tricks,
  mouse play) · `pet.html` body + screen + the 3 arm LEDs
- `pet.html` opened in a plain browser fakes a desktop (`?screens=2` = two screens with different floors).
- `engine/goober.js` the eyes/moods engine. It's a COPY: the engine is developed in the main goober project. Don't
  edit it here; refresh it with `node tools/sync-engine.js [path]` (default `../goober/sim/goober.js`).
  The engine's public API used here: `update(dt, input)`, `render(rgba, size)`, `act(name)`, `preview(face, dur)`,
  `mood`, `mode`, `personality`, `look`, `actNames`, `faceNames`, `id` / `setId` / `rollGoober`, `on(fn)`,
  `armLights()`, `power` (fps 0 = hold the frame, bright); input `battery`, `charging`, `gesture` ('thumbsup' = show
  the battery). Internals it pokes (re-check after an engine sync): `sense.attnUntil`, `_setGaze`, `gaze`, `nextSac`,
  `nextAct` (watching the cursor), `_sleep` (tests only).

## Releases and updates
Every push to `main` that touches the app (not `*.md` / `tools/`) runs `.github/workflows/release.yml`: builds
Windows (NSIS one-click), macOS (universal dmg + zip, unsigned) and Linux (AppImage), then publishes release
`v0.2.<run number>`. Installed apps update themselves from it (`electron-updater`, set up in `main.js`; macOS only gets
a "download" menu item because unsigned apps can't self-update). So: every push to main ships to the user's
computer within a few hours. Don't push half-finished work to main; check the workflow run after pushing.
`npm run dist` builds locally (Linux works in the cloud container).

## Verify before committing
- **Always use the newest engine** (the user's rule): before every commit, update the main goober checkout (read only:
  `git -C ../goober pull --ff-only`; attach `ARandomEnderman/goober` to the session if it isn't there) and run
  `node tools/sync-engine.js`. `tools/check.js` fails while `engine/goober.js` differs from `../goober/sim/goober.js`.
  The goober repo is private, so the release workflow can't fetch it itself; never commit anything else from it here.
  Never write to the goober repo from desktopgoober work.
- `node tools/check.js [out-dir]` and `node tools/play.js [out-dir]` (headless; `pet.html` opened in a plain browser
  fakes a desktop and draws a fake cursor when goober steals it). Both fail on page errors / missed behaviours.
- Look at the screenshots for visual changes.
- The real app runs in the cloud container: `npm install`, then `xvfb-run -a ./node_modules/.bin/electron . --no-sandbox`,
  grab the screen with `ffmpeg -f x11grab`.

## Where we left off (2026-11-10, v0.2.4 released, user runs it on a Mac)
- Behaviour: hops / boings / big leaps (also onto another screen), 11 random events (flip, zoomies, roll, spin, dance,
  trip, sneeze, stretch, nap, climb the wall, hang from the top edge and drop), mouse play (watches the cursor while
  it moves, hops over, pounces on a still cursor, grabs it mid-air and carries + tosses it, dodges fast swipes, nuzzles
  when rubbed), throws keep the flick's speed, hatch always changes the eyes, menu shows who the goober is.
- Arm LEDs = battery gauge from the computer's battery: on for 4 s after menu "Show the battery", and the charging
  look (wall-eyed, gauge, dimmed, held frame) for ~8 s after plugging in a charger. Otherwise off (engine design).
- Removed on purpose (user didn't like them): the camera gestures in the menu, knock / shake menu items, peeking
  half off the screen edge (the watchdog now hops it back in if it's ever partly off).
- Offered, not done: make the LED windows faintly visible when off (dark grey on a black body = invisible).
- Not tested on real hardware: cursor stealing on Windows/macOS (PowerShell / JXA helpers), two real screens.
  macOS builds are unsigned: no self-update there, only a "download" menu item.
- The old copy in the main goober repo (`desktop/`, `tools/desktop-*.js`) is stale and still mentioned in that repo's
  CLAUDE.md; the user said not to write to that repo from desktop work, so it's untouched.

## User preferences
- Casual and brief; acts on clear requests. Wants it cute: lots of animations and events, mouse interaction.
- Tests on a Mac (and maybe Windows); reports problems in one line ("cant see him", "stays squished"): reproduce
  in the preview / xvfb, find the cause, fix, and ship a release.

## Gotchas
- The fake IMU is tuned: mouse drags are felt through a spring (raw mouse input is jittery and read as shaking),
  small hand accelerations are squashed (pickups aren't knocks), landings are one clean 3.4 g frame, and goober's own
  hops feed "at rest" (no "wheee" every hop). Rerun both tests after touching it.
- Stealing the cursor: a real mouse moves relative to where goober last put it, so pulling back is detected by adding
  up small deviations (over 0.6 s, after a 0.5 s grip), not one big jump. It grabs in mid-air at the catch.
- Single instance: after an update the new version starts while the old one closes, so it retries the lock for 10 s
  (giving up at once made goober vanish after updating). Starting goober again brings it back on screen.
- Squash: `squash(target)` holds until reset (only crouches use it); landings use `bounce(impulse)`. A resting goober
  always relaxes (watchdog), but don't set targets on landing.
- Two screens with different heights: the shared edge is a ledge near the floor. Own jumps slide up a wall instead of
  bouncing; target screens are looked up by column (`displayAtX`), not nearest point.
- The tests are timing-sensitive headless: they pin mood/personality, switch off unrelated behaviours, nudge the
  cursor so goober doesn't lose interest, and retry pounces. A miss is usually the test; check before "fixing" goober.
- Electron 45: `clipboard.readText/writeText` return promises.
- Push only when both tests pass (`r=$(node tools/play.js | tail -1); [ "$r" = "all behaviours seen" ]`): every push
  is a release on the user's computer.
