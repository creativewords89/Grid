// Times as the portal stores them: UTC `Y-m-d H:i:s`. Days and times of day are local (the computer's
// time zone, which is the office's).

const pad = (n) => String(n).padStart(2, '0');

// Epoch ms → UTC `Y-m-d H:i:s`.
export const toUtc = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ');

// UTC `Y-m-d H:i:s` → epoch ms.
export const fromUtc = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : NaN);

// Epoch ms → local `YYYY-MM-DD`.
export function localDay(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Epoch ms → minutes since local midnight.
export function localMinutes(ms) {
	const d = new Date(ms);
	return d.getHours() * 60 + d.getMinutes();
}

// `HH:MM` → minutes since midnight.
export const hhmm = (s) => {
	const [h, m] = String(s || '0:0').split(':').map(Number);
	return h * 60 + m;
};

// Seconds as "0:42" or "1:05:09".
export function fmtClock(seconds) {
	const s = Math.max(0, Math.floor(+seconds || 0));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// Minutes as "1h 30m", "2h" or "45m".
export function fmtMinutes(min) {
	const m = Math.max(0, Math.round(+min || 0));
	const h = Math.floor(m / 60);
	return h ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${m % 60}m`;
}

// Epoch ms → local "9:05 AM".
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
