# desktopgoober — notes for Claude sessions

goober as a desktop pet (Electron). goober is a star-shaped creature with a round screen showing two animated eyes;
this repo is the desktop version: it lives on the taskbar, hops around and plays with the mouse. See README.md.

**This repo is public.** Never commit personal information (email addresses, names beyond the GitHub handle, links
to private pages or private repos, order / supplier / price details, session links in files). Commit as
`ARandomEnderman <ARandomEnderman@users.noreply.github.com>`.

## Layout
- `main.js` Electron (window, cursor read/move, menu, tray, settings) · `preload.js` bridge
- `pet.js` body, physics, fake accelerometer · `play.js` behaviour (hops, mouse play) · `pet.html` body + screen
- `engine/goober.js` the eyes/moods engine. It's a COPY: the engine is developed in the main goober project. Don't
  edit it here; refresh it with `node tools/sync-engine.js [path]` (default `../goober/sim/goober.js`).
  The engine's public API used here: `update(dt, input)`, `render(rgba, size)`, `act(name)`, `preview(face, dur)`,
  `mood`, `mode`, `personality`, `actNames`, `id` / `setId` / `rollGoober`, `on(fn)`; plus `sense.attnUntil` to keep
  its eyes on what it's chasing.

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

## Gotchas
- The fake IMU is tuned: mouse drags are felt through a spring (raw mouse input is jittery and read as shaking),
  small hand accelerations are squashed (pickups aren't knocks), landings are one clean 3.4 g frame, and goober's own
  hops feed "at rest" (no "wheee" every hop). Rerun both tests after touching it.
- Stealing the cursor: a real mouse moves relative to where goober last put it, so pulling back is detected by adding
  up small deviations, not one big jump.
