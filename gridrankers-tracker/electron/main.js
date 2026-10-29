// GridRankers Tracker — the Electron main process (SPEC.md 6.21). It wires the controller (src/core) to
// the window, the tray, the operating system's keychain and the network.

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, net, safeStorage, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../src/core/api.js';
import { fmtClock } from '../src/core/clock.js';
import { createController } from '../src/core/controller.js';
import { createStore } from '../src/core/store.js';

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
	win.once('ready-to-show', () => {
		if (!app.getLoginItemSettings().wasOpenedAsHidden) win.show();
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
			{ type: 'separator' },
			{ label: 'Open GridRankers Tracker', click: showWindow },
			{ label: 'Quit', click: () => ((quitting = true), app.quit()) },
		])
	);
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
	ipcMain.handle('openPortal', () => shell.openExternal(ctl.state.server));

	tray = new Tray(nativeImage.createFromPath(asset('tray-idle.png')));
	tray.on('click', showWindow);
	createWindow();
	updateTray();

	// The tray's clock ticks; uploads and refreshes run every minute (and at once after a change).
	setInterval(updateTray, 1000);
	setInterval(() => ctl.sync(), 60 * 1000);
	ctl.sync({ refresh: true });
});

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => (quitting = true));
// The tracker lives in the tray: closing every window doesn't quit it.
app.on('window-all-closed', () => {});
