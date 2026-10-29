# GridRankers Tracker (desktop app)

The desktop time tracker for the GridRankers portal (SPEC.md 6.21). Team Leaders and Team Members sign
in with their **employee code**, start a timer on a task, and the time goes into their daily report on
the portal — where it is paid (SPEC.md 6.19). Time only: no screenshots, keystrokes, apps or websites.

## For the team

**Install** — from the latest release (`tracker-latest`, a GitHub pre-release of this repository):

- Windows: `GridRankers-Tracker-Setup.exe` — installs for the current user, starts it and adds it to
  start-up.
- Mac: `GridRankers-Tracker-mac.dmg` — drag it to Applications, open it once.

**Use**

1. Sign in with your code (the same one as the portal). Another portal address? *Another portal
   address?* under the code.
2. Pick what you're working on: your tasks (recent first, search), **No task**, or a project. Picking
   another one switches; **Stop** stops. The tray icon shows the time and has Stop and your recent tasks.
3. Your tracked time appears in **Daily reports** on the portal as "⏱ Tracked" lines; send the report as
   usual. Work you add by hand is paid too (the Super Admin is told about handwritten hours).

**Offline** — everything is written on your computer first. Without internet the window says
"Offline · N entries waiting to sync" and the tracker keeps working; when you're back it sends them
("Synced N entries"). Nothing is uploaded twice. If the portal refuses one (it overlaps other time, the
day's report is already sent…), it shows under **Needs attention** with why.

**Crashes and sleep** — while a timer runs the tracker saves every 30 s. If the computer crashes or
loses power, the next start asks *"Your timer stopped unexpectedly at {time} — Keep until {time} /
Discard / Keep running"*. Away 10 minutes, or asleep, with a timer running: *Keep / Discard* the time
away. Quitting the tracker or shutting the computer down stops the timer then.

**Reminders** — only during your working day (when it starts — set on the portal — for your working
hours from Pay), never on a day off or leave, worked out even offline: start your timer (5 minutes in,
then every 15), not connected (every 15), and the end of the day. **Snooze 15 min** on each.

**Sign out** — sends what's waiting first. A Super Admin or Team Leader can sign a computer out from the
portal (the person's **Time** tab → Desktop tracker → **Revoke**); so does setting a new code.

## For developers

```
cd gridrankers-tracker
npm install
npm start            # builds the window and opens the app (Linux as root: add --no-sandbox)
npm test             # Vitest: the core, with a fake portal
```

- `src/core/` — everything that isn't Electron, unit-tested: the API client (`api.js`, device token as
  `Authorization: Bearer`, `?rest_route=` URLs), the state (`tracker.js`: start / stop / switch, the
  outbox, answers, crash and away prompts), reminders (`reminders.js`), the atomic file store
  (`store.js`) and `controller.js`, which ties them together.
- `electron/main.js` — window, tray, notifications, the OS keychain for the token (`safeStorage`),
  idle / sleep / shutdown, start with the computer, auto-update. `electron/preload.cjs` is the
  window's only door in.
- `src/renderer/` — the window (React, built by Vite into `dist/`).

**Against a real portal** — the plugin's e2e site (`gridrankers-portal/app/e2e/site/setup.sh`, served
with `php -S 127.0.0.1:8090 -t /tmp/grp-e2e`):

```
TRACKER_LIVE_URL=http://127.0.0.1:8090 TRACKER_LIVE_CODE=MAXCODE11 npx vitest run test/live.test.js
TRACKER_LIVE_URL=http://127.0.0.1:8090 TRACKER_LIVE_CODE=MAXCODE11 xvfb-run -a npx playwright test -c e2e/playwright.config.mjs
```

Add `TRACKER_EXECUTABLE=release/linux-unpacked/gridrankers-tracker` to run the Electron test on a
packaged build (`npx electron-builder --linux dir`).

**Releases** — `.github/workflows/tracker.yml` tests every change and, for every change merged to main,
builds the Windows (NSIS) and macOS (universal DMG + zip) installers and publishes them as the
pre-releases `tracker-v1.0.N` and `tracker-latest`. The installed apps check `tracker-latest` every
6 hours and update when they next quit. Pre-releases keep the plugin's own updater (which reads the
repository's latest release) untouched. Code signing and notarization use the secrets listed at the top
of the workflow; without them the installers are unsigned (Windows SmartScreen and macOS Gatekeeper
warn, and macOS can't update itself). If the repository is private, the release files need a public
home instead: build with `-c.publish.url=<that address>` and put the files there.
