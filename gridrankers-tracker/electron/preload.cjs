// The window's only door to the tracker: a few named calls, no Node.js in the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
	view: () => ipcRenderer.invoke('view'),
	onView: (fn) => {
		const handler = (_e, v) => fn(v);
		ipcRenderer.on('view', handler);
		return () => ipcRenderer.removeListener('view', handler);
	},
	signIn: (server, code) => ipcRenderer.invoke('signIn', { server, code }),
	signOut: () => ipcRenderer.invoke('signOut'),
	start: (task) => ipcRenderer.invoke('start', task),
	stop: () => ipcRenderer.invoke('stop'),
	sync: () => ipcRenderer.invoke('sync'),
	dismiss: (id) => ipcRenderer.invoke('dismiss', id),
	answer: (prompt, choice) => ipcRenderer.invoke('answer', { prompt, choice }),
	snooze: () => ipcRenderer.invoke('snooze'),
	openPortal: () => ipcRenderer.invoke('openPortal'),
});
