// GridRankers Tracker — the Electron main process (SPEC.md 6.21). It wires the controller (src/core) to
// the window, the tray, the operating system's keychain and the network.

import { app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, ipcMain, nativeImage, net, powerMonitor, safeStorage, screen, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../src/core/api.js';
import { fmtClock } from '../src/core/clock.js';
import { createController } from '../src/core/controller.js';
import { createStore } from '../src/core/store.js';
import updater from 'electron-updater';

const here = path.dirname(fileURLToPath(import.meta.url));
const asset = (name) => path.join(here, '..', 'assets', name);

// Tests run the app with its own data folder.
if (process.env.GRT_USER_DATA) app.setPath('userData', process.env.GRT_USER_DATA);

// One tracker per computer user.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let tray = null;
let ctl = null;
let quitting = false;

// The device token, encrypted by the operating system (Keychain, DPAPI, libsecret).
const tokenFile = () => path.join(app.getPath('userData'), 'token.bin');
function loadToken() {
	try {
		const raw = fs.readFileSync(tokenFile());
		return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
	} catch (e) {
		return null;
	}
}
function saveToken(token) {
	try {
		if (!token) return fs.rmSync(tokenFile(), { force: true });
		fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
		fs.writeFileSync(tokenFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8'), { mode: 0o600 });
	} catch (e) {
		console.error('Could not store the sign-in token', e);
	}
}

function createWindow() {
	win = new BrowserWindow({
		width: 420,
		height: 640,
		minWidth: 360,
		minHeight: 480,
		show: false,
		title: 'GridRankers Tracker',
		icon: asset('icon.png'),
		autoHideMenuBar: true,
		webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
	});
	win.loadFile(path.join(here, '..', 'dist', 'index.html'));
	// Started with the computer: stay in the tray.
	win.once('ready-to-show', () => {
		if (!app.getLoginItemSettings().wasOpenedAsHidden && !process.argv.includes('--hidden')) win.show();
	});
	// Closing the window keeps the tracker running in the tray.
	win.on('close', (e) => {
		if (!quitting) {
			e.preventDefault();
			win.hide();
		}
	});
	// Links (Open the portal) go to the browser.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});
}

const showWindow = () => {
	if (!win) createWindow();
	win.show();
	win.focus();
};

// The tray: the status icon, the running time, Stop / Start on a recent task, Open, Quit.
function updateTray() {
	if (!tray) return;
	const v = ctl.view();
	const status = v.running ? 'running' : v.sync.online === false ? 'offline' : 'idle';
	tray.setImage(nativeImage.createFromPath(asset(`tray-${status}.png`)));
	const clock = v.running ? fmtClock((Date.now() - v.running.startedMs) / 1000) : '';
	tray.setToolTip(v.running ? `GridRankers Tracker · ${clock} · ${v.running.label}` : v.sync.online === false ? `GridRankers Tracker · Offline · ${v.waiting} waiting to sync` : 'GridRankers Tracker');
	if (process.platform === 'darwin') tray.setTitle(clock ? ` ${clock}` : '');
	const recent = v.recent.map((k) => v.choices.find((c) => c.key === k)).filter(Boolean);
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: v.running ? `⏱ ${clock} · ${v.running.label}` : v.signedIn ? 'No timer running' : 'Not signed in', enabled: false },
			{ label: v.sync.online === false ? `Offline · ${v.waiting} entr${v.waiting === 1 ? 'y' : 'ies'} waiting to sync` : 'Online', enabled: false },
			{ type: 'separator' },
			...(v.running ? [{ label: 'Stop timer', click: () => ctl.stop() }] : []),
			...(v.signedIn ? recent.map((c) => ({ label: `Start: ${c.label}`, click: () => ctl.start(c) })) : []),
			...(v.reminder ? [{ label: 'Snooze reminders 15 min', click: () => ctl.snooze() }] : []),
			{ type: 'separator' },
			{ label: 'Open GridRankers Tracker', click: showWindow },
			{ label: 'Quit', click: () => ((quitting = true), app.quit()) },
		])
	);
}

// A desktop notification; clicking it opens the window (where Snooze 15 min is); on macOS it also
// carries a Snooze button.
function remind({ title, body }, snoozable = true) {
	if (!Notification.isSupported()) return;
	const n = new Notification({ title, body, icon: asset('icon.png'), actions: snoozable && process.platform === 'darwin' ? [{ type: 'button', text: 'Snooze 15 min' }] : [] });
	n.on('click', showWindow);
	n.on('action', () => ctl.snooze());
	n.show();
}

// Screenshots (SPEC.md 6.23): every screen side by side, at most 1920 px wide, as a JPEG, saved in
// the tracker's folder until the portal has it.
const shotsDir = () => path.join(app.getPath('userData'), 'shots');
const MAX_WIDTH = 1920;
let composer = null;

// Several screens are drawn side by side on a canvas in a hidden window with no access to anything.
async function compose(images) {
	if (images.length === 1) return images[0];
	if (!composer || composer.isDestroyed()) {
		composer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true } });
		await composer.loadURL('about:blank');
	}
	const urls = images.map((img) => img.toDataURL());
	const js = `(async (urls) => {
		const imgs = await Promise.all(urls.map((u) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = u; })));
		const c = document.createElement('canvas');
		c.width = imgs.reduce((w, i) => w + i.width, 0);
		c.height = Math.max(...imgs.map((i) => i.height));
		const g = c.getContext('2d');
		let x = 0;
		for (const i of imgs) { g.drawImage(i, x, 0); x += i.width; }
		return c.toDataURL('image/png');
	})(${JSON.stringify(urls)})`;
	return nativeImage.createFromDataURL(await composer.webContents.executeJavaScript(js));
}

async function takeShot(take) {
	try {
		const displays = screen.getAllDisplays();
		const per = Math.max(320, Math.floor(MAX_WIDTH / Math.max(1, displays.length)));
		const biggest = displays.reduce((m, d) => Math.max(m, d.size.width * d.scaleFactor), 1);
		const scale = Math.min(1, per / biggest);
		const tallest = displays.reduce((m, d) => Math.max(m, d.size.height * d.scaleFactor), 1);
		const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(biggest * scale), height: Math.round(tallest * scale) } });
		const images = sources.map((s) => s.thumbnail).filter((img) => !img.isEmpty());
		if (!images.length) return;
		let picture = await compose(images);
		if (picture.getSize().width > MAX_WIDTH) picture = picture.resize({ width: MAX_WIDTH });
		const jpeg = picture.toJPEG(70);
		fs.mkdirSync(shotsDir(), { recursive: true });
		const file = path.join(shotsDir(), `${take.id}.jpg`);
		fs.writeFileSync(file, jpeg, { mode: 0o600 });
		ctl.addShot(take, file);
		if (Notification.isSupported()) {
			const n = new Notification({ title: 'Screenshot taken', body: 'For your tracked time. Your manager can see it.', icon: picture.resize({ width: 256 }), silent: true });
			n.on('click', showWindow);
			n.show();
		}
	} catch (e) {
		console.error('Screenshot failed', e.message);
	}
}

function push() {
	if (win && !win.isDestroyed()) win.webContents.send('view', ctl.view());
	updateTray();
}

app.whenReady().then(() => {
	ctl = createController({
		store: createStore(app.getPath('userData')),
		loadToken,
		saveToken,
		device: { device_name: os.hostname(), platform: process.platform, app_version: app.getVersion() },
		// Chromium's network stack: uses the computer's proxy settings.
		createApi: (opts) => createClient({ ...opts, fetchImpl: (url, init) => net.fetch(url, init) }),
		onChange: push,
		readShot: (file) => {
			try {
				return fs.readFileSync(file);
			} catch (e) {
				return null;
			}
		},
		removeShot: (file) => fs.rmSync(file, { force: true }),
	});

	ipcMain.handle('view', () => ctl.view());
	ipcMain.handle('signIn', async (_e, { server, code }) => {
		try {
			await ctl.signIn(server, code);
			return { ok: true };
		} catch (err) {
			return { ok: false, message: err.message };
		}
	});
	ipcMain.handle('signOut', () => ctl.signOut().then(() => ({ ok: true })));
	ipcMain.handle('start', (_e, task) => (ctl.start(task), { ok: true }));
	ipcMain.handle('stop', () => (ctl.stop(), { ok: true }));
	ipcMain.handle('sync', () => ctl.sync({ refresh: true }).then(() => ({ ok: true })));
	ipcMain.handle('dismiss', (_e, id) => (ctl.dismiss(id), { ok: true }));
	ipcMain.handle('answer', (_e, { prompt, choice }) => (ctl.answer(prompt, choice), { ok: true }));
	ipcMain.handle('snooze', () => (ctl.snooze(), { ok: true }));
	ipcMain.handle('openPortal', () => shell.openExternal(ctl.state.server));

	tray = new Tray(nativeImage.createFromPath(asset('tray-idle.png')));
	tray.on('click', showWindow);
	createWindow();
	updateTray();

	// The tray's clock ticks; the state is saved every 30 s while a timer runs (a crash loses at most
	// that); uploads run every minute, sooner after a failure (5 s, 15 s, 1 min, 5 min), and at once
	// after a change.
	setInterval(updateTray, 1000);
	setInterval(() => ctl.heartbeat(), 30 * 1000);
	const loop = () => ctl.sync().finally(() => setTimeout(loop, ctl.nextSyncMs()));
	ctl.sync({ refresh: true }).finally(() => setTimeout(loop, ctl.nextSyncMs()));
	// The computer shutting down: the timer stops now (a power cut is caught by the heartbeat instead).
	powerMonitor.on('shutdown', () => ctl.stop());
	// Asleep with a timer running asks on waking: "You were away {n} min — Keep / Discard".
	powerMonitor.on('suspend', () => ctl.suspended());
	powerMonitor.on('resume', () => ctl.resumed());

	// Reminders and "away" checks every 30 s (SPEC.md 6.21).
	const check = () => {
		const due = ctl.tick({ idleSeconds: powerMonitor.getSystemIdleTime() });
		if (due) remind(due);
		const v = ctl.view();
		if (v.prompts.away && !asked) {
			asked = true;
			remind({ title: v.prompts.away.kind === 'sleep' ? `You were away ${v.prompts.away.minutes} min` : 'You’ve been away 10 min', body: 'Keep the time, or discard it? Open the tracker to choose.' }, false);
		}
		if (!v.prompts.away) asked = false;
	};
	let asked = false;
	setInterval(check, 30 * 1000);
	check();

	// A screenshot due while a timer runs (checked every 15 s).
	setInterval(() => {
		const take = ctl.shotDue();
		if (take) takeShot(take);
	}, 15 * 1000);

	// Starts with the computer (installed app only), quietly in the tray.
	if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ['--hidden'] });

	// Updates itself (installed app only): checks now and every 6 hours, downloads in the background and
	// installs when the tracker next quits (SPEC.md 6.21).
	if (app.isPackaged && !process.env.GRT_NO_UPDATES) {
		const { autoUpdater } = updater;
		const look = () => autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error('Update check failed', e.message));
		look();
		setInterval(look, 6 * 3600 * 1000);
	}
});

app.on('second-instance', showWindow);
app.on('activate', showWindow);
// Quitting the tracker stops the timer at that moment.
app.on('before-quit', () => {
	quitting = true;
	if (ctl && ctl.view().running) ctl.stop();
});
// The tracker lives in the tray: closing every window doesn't quit it.
app.on('window-all-closed', () => {});
