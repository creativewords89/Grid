// Daily reports (SPEC.md 6.18): pure helpers for the report screens.
import { addDays, parts } from './cycles.js';

// Quick time buttons in Add work (design DR-A2), in minutes; "Other" types hours and minutes.
export const TIME_CHIPS = [15, 30, 60, 120];

// Entry projects that are not a project.
export const OTHER_PROJECTS = { office: 'Office', other: 'Other' };

// Who writes reports: Team Leaders and Team Members; the Super Admin only reads them.
export const writesReports = (me) => !!me && (me.role === 'lead' || me.role === 'member');

// Who sees the Team tab: the Super Admin and Team Leaders.
export const seesTeamReports = (me) => !!me && (me.role === 'admin' || me.role === 'lead');

// 90 → "1h 30m", 45 → "45m", 120 → "2h".
export function fmtMinutes(min) {
	const m = Math.max(0, Math.round(+min || 0));
	const h = Math.floor(m / 60);
	const r = m % 60;
	if (!h) return `${r}m`;
	return r ? `${h}h ${r}m` : `${h}h`;
}

// Hours and minutes typed under "Other" → minutes (0 when nothing valid).
export function toMinutes(hours, minutes) {
	const h = Math.max(0, Math.floor(+hours || 0));
	const m = Math.max(0, Math.floor(+minutes || 0));
	return Math.min(24 * 60, h * 60 + m);
}

export const totalMinutes = (entries) => (entries || []).reduce((sum, e) => sum + (+e.minutes || 0), 0);

// "5 entries · 5h 30m".
export function summary(entries) {
	const n = (entries || []).length;
	return `${n} ${n === 1 ? 'entry' : 'entries'} · ${fmtMinutes(totalMinutes(entries))}`;
}

// The name shown for an entry's project ('' = none).
export function projectName(project, projects) {
	if (!project) return '';
	if (OTHER_PROJECTS[project]) return OTHER_PROJECTS[project];
	return projects && projects[project] ? projects[project].name : 'Deleted project';
}

// What blocks Add work (design DR-A2), or '' when it can be added.
export function entryError(entry) {
	if (!String(entry.title || '').trim()) return 'Write what you did.';
	if (!(+entry.minutes > 0)) return 'Add the time spent.';
	if (+entry.minutes > 24 * 60) return 'That’s more than 24 hours.';
	return '';
}

// A link typed in Add work: http(s) only. Returns {url, name} or null.
export function cleanLink(url, name) {
	const u = String(url || '').trim();
	if (!/^https?:\/\/[^/\s]+/i.test(u)) return null;
	let host = '';
	try {
		host = new URL(u).host;
	} catch (e) {
		return null;
	}
	return { url: u, name: String(name || '').trim() || host };
}

// The time of day `HH:MM` has come (local clock).
export function after(now, hhmm) {
	const [h, m] = String(hhmm || '00:00').split(':').map(Number);
	return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

// Whether Sign out first asks for today's report (design DR-D): someone who writes reports, on a
// working day, while today's report isn't sent.
export function asksBeforeSignOut(state) {
	return !!state && state.writes && !state.out_today && !(state.report && state.report.sent_at);
}

// Every day of a month for the day bar (design DR-C): {day: 'YYYY-MM-DD', n, letter}.
const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export function monthDays(month) {
	const [y, m] = month.split('-').map(Number);
	const last = new Date(y, m, 0).getDate();
	const out = [];
	for (let n = 1; n <= last; n++) {
		const day = `${month}-${String(n).padStart(2, '0')}`;
		out.push({ day, n, letter: LETTERS[new Date(y, m - 1, n).getDay()] });
	}
	return out;
}

// The month before / after `YYYY-MM`.
export function shiftMonth(month, by) {
	const [y, m] = month.split('-').map(Number);
	const d = new Date(y, m - 1 + by, 1);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// "Tuesday, Oct 13".
export function dayTitle(day) {
	const [y, m, d] = parts(day);
	return new Date(y, m, d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

// Team tab states (design DR-B) → badge text and tone.
export const STATE = {
	sent: { text: 'Sent', tone: 'ok' },
	late: { text: 'Late', tone: 'warn' },
	not_sent: { text: 'Not sent', tone: 'bad' },
	leave: { text: 'On leave', tone: 'mute' },
	day_off: { text: 'Day off', tone: 'mute' },
	none: { text: '', tone: 'mute' },
};

// "3 of 4 sent": people who owed a report that day, and how many sent it.
export function teamCounts(people) {
	const owed = people.filter((p) => ['sent', 'late', 'not_sent'].includes(p.state));
	return { owed: owed.length, sent: owed.filter((p) => p.state !== 'not_sent').length, late: owed.filter((p) => p.state === 'late').length, missing: owed.filter((p) => p.state === 'not_sent').length };
}

export const nextDay = (day, by) => addDays(day, by);
