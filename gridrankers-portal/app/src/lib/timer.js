// The time tracker on the portal (SPEC.md 6.21): the running timer, how long it has run, and the
// tracked / handwritten time of a daily report. Pure helpers, unit-tested.

import { rowsOf } from './store.js';

// UTC `Y-m-d H:i:s` → epoch ms.
export const utcMs = (dt) => (dt ? Date.parse(String(dt).replace(' ', 'T') + 'Z') : NaN);

// The person's running entry, or null.
export function runningOf(data, memberId) {
	return rowsOf(data, 'time_entries').find((e) => e.member_id === memberId && !e.ended_at && !e.deleted_at) || null;
}

// Seconds as "0:42" (minutes) or "1:05:09".
export function fmtClock(seconds) {
	const s = Math.max(0, Math.floor(+seconds || 0));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	const pad = (n) => String(n).padStart(2, '0');
	return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

// Seconds an entry has run until `nowMs` (or its end).
export function elapsed(entry, nowMs) {
	if (!entry) return 0;
	const end = entry.ended_at ? utcMs(entry.ended_at) : nowMs;
	return Math.max(0, Math.round((end - utcMs(entry.started_at)) / 1000));
}

// What an entry is about: its task's title, else its project, else "No task".
export function entryLabel(entry, data) {
	if (!entry) return '';
	const task = entry.ref_kind === 'item' ? data.meeting_tasks?.[entry.ref_id] : entry.ref_kind === 'record' ? data.monthly_tasks?.[entry.ref_id] : null;
	if (task) return task.title;
	const project = entry.project_id && data.projects?.[entry.project_id];
	return project ? project.name : 'No task';
}

// Whether a report entry was made from tracked time.
export const isTracked = (entry) => !!entry && entry.source === 'tracked';

// Tracked and handwritten minutes of a list of report entries.
export function splitMinutes(entries) {
	const out = { tracked: 0, hand: 0, total: 0 };
	(entries || []).forEach((e) => {
		const m = Math.max(0, +e.minutes || 0);
		out[isTracked(e) ? 'tracked' : 'hand'] += m;
	});
	out.total = out.tracked + out.hand;
	return out;
}

const pad = (n) => String(n).padStart(2, '0');

// `YYYY-MM-DD` plus days.
export function addDays(ymd, n) {
	const d = new Date(ymd + 'T12:00:00Z');
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

// A UTC datetime as local `HH:MM`, and its local date.
export const localTime = (dt) => {
	const d = new Date(utcMs(dt));
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const localDate = (dt) => {
	const d = new Date(utcMs(dt));
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A local date and `HH:MM` as a UTC `Y-m-d H:i:s`.
export function toUtc(ymd, hhmm) {
	const [y, m, d] = ymd.split('-').map(Number);
	const [h, i] = hhmm.split(':').map(Number);
	return new Date(y, m - 1, d, h, i, 0).toISOString().slice(0, 19).replace('T', ' ');
}

// Whether `me` may change `person`'s entry (SPEC.md 6.21, section 3; the server decides): the Super
// Admin anyone's, a Team Leader Team Members', everyone their own on the same day.
export function canEditTime(me, person, entry, today) {
	if (!me || !person || !entry) return false;
	if (me.id === person.id) return me.role !== 'admin' && entry.day === today;
	if (me.role === 'admin') return person.role !== 'admin';
	return me.role === 'lead' && person.role === 'member';
}

// Whether `me` sets when `person`'s day starts: the Super Admin anyone's, a Team Leader Team Members'.
export const canSetStart = (me, person) => !!me && !!person && (me.role === 'admin' || (me.role === 'lead' && person.role === 'member' && me.id !== person.id));

// Flags of an entry as short labels.
export function flagLabels(entry) {
	const f = (entry && entry.flags) || {};
	return [f.day_off && 'Day off', f.auto_stopped && 'Stopped after 12 h', f.late_sync && 'Sent late', f.clock_skew && 'Clock was off'].filter(Boolean);
}
