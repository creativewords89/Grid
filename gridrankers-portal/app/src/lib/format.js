import { addDays, parts } from './cycles.js';

// Dates are 'YYYY-MM-DD' (local calendar dates) or UTC 'YYYY-MM-DD HH:MM:SS' from the server.

export const toDate = (s) => {
	if (!s) return null;
	if (s.length === 10) {
		const [y, m, d] = parts(s);
		return new Date(y, m, d);
	}
	return new Date(s.replace(' ', 'T') + (s.includes('Z') || s.includes('+') ? '' : 'Z'));
};
export const short = (s) => (s ? toDate(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
export const longDate = (s) => (s ? toDate(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const weekdayDate = (s) => (s ? toDate(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const dateTime = (s) => (s ? toDate(s).toLocaleString() : '');
export const localYmd = (s) => {
	const d = toDate(s);
	return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
};

export const mondayOf = (s) => {
	const d = toDate(s);
	return addDays(s.slice(0, 10), -((d.getDay() + 6) % 7));
};

// ISO week number.
export const weekNo = (s) => {
	const [y, m, d] = parts(s);
	const t = new Date(Date.UTC(y, m, d));
	const dn = t.getUTCDay() || 7;
	t.setUTCDate(t.getUTCDate() + 4 - dn);
	const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
	return Math.ceil(((t - y0) / 86400000 + 1) / 7);
};

export const monthEnd = (key) => {
	const [y, m] = key.split('-').map(Number);
	const d = new Date(Date.UTC(y, m, 0));
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
