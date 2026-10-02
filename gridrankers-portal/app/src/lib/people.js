import { addDays } from './cycles.js';
import { rowsOf } from './store.js';

// Days off, leave and Who's out today (SPEC.md 6.10) — the same rules as GRP_People on the
// server, which stays the source of truth for anything saved. Dates are `YYYY-MM-DD`;
// weekdays 0 (Sunday) – 6 (Saturday).

export const DEFAULT_WEEKLY_OFF = [5];
export const LEAVE_PER_MONTH = 1;

export const DEFAULT_MESSAGES = {
	birthday: 'Happy birthday, {name}! The whole GridRankers team wishes you a wonderful year ahead.',
	day_off: 'Today is your day off, {name} — but you’re here anyway. We really appreciate it. Don’t forget to rest too.',
	leave_approved: 'Your leave was approved. Enjoy your time off, {name}!',
};

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const weekday = (date) => {
	const [y, m, d] = date.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

export function weekdays(value) {
	if (!Array.isArray(value)) return null;
	return [...new Set(value.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

export function settingOf(data, key) {
	const row = rowsOf(data, 'settings').find((s) => s.setting_key === key);
	return row ? row.value : null;
}

export function teamWeekly(data) {
	const days = weekdays((settingOf(data, 'weekly_off') || {}).days);
	return days === null ? DEFAULT_WEEKLY_OFF : days;
}

export function weeklyOff(member, team) {
	const own = weekdays(member && member.weekly_off);
	return own !== null ? own : team;
}

export function dayOffKind(date, member, team, daysOff) {
	for (const off of daysOff) {
		if (date >= off.from_date && date <= off.to_date) return off.kind === 'seasonal' ? 'seasonal' : 'event';
	}
	return weeklyOff(member, team).includes(weekday(date)) ? 'weekly' : null;
}

export function dayOffName(date, daysOff) {
	const off = daysOff.find((o) => date >= o.from_date && date <= o.to_date);
	return off ? off.name : '';
}

export function dates(from, to) {
	const out = [];
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
}

// Leave days per month (`YYYY-MM` → days); days off are not counted.
export function leaveDays(from, to, member, team, daysOff) {
	const months = {};
	if (!from || !to || to < from) return months;
	dates(from, to).forEach((d) => {
		if (!dayOffKind(d, member, team, daysOff)) months[d.slice(0, 7)] = (months[d.slice(0, 7)] || 0) + 1;
	});
	return months;
}

const approvedOf = (leaves, memberId) => leaves.filter((l) => l.status === 'approved' && l.member_id === memberId);

export function takenInMonth(member, month, leaves, team, daysOff) {
	return approvedOf(leaves, member.id)
		.filter((l) => l.from_date.slice(0, 7) <= month && l.to_date.slice(0, 7) >= month)
		.reduce((sum, l) => sum + (leaveDays(l.from_date, l.to_date, member, team, daysOff)[month] || 0), 0);
}

export const daysLeft = (taken) => Math.max(0, LEAVE_PER_MONTH - taken);

function whyOut(date, member, leaves, team, daysOff) {
	if (approvedOf(leaves, member.id).some((l) => date >= l.from_date && date <= l.to_date)) return 'leave';
	return dayOffKind(date, member, team, daysOff) ? 'day_off' : null;
}

// Everyone but `exceptId` out on `date`, with the next date they are back.
export function whosOut(date, members, leaves, team, daysOff, exceptId) {
	const out = [];
	members.forEach((m) => {
		if (m.id === exceptId) return;
		const why = whyOut(date, m, leaves, team, daysOff);
		if (!why) return;
		let back = addDays(date, 1);
		for (let i = 0; i < 366 && whyOut(back, m, leaves, team, daysOff); i++) back = addDays(back, 1);
		out.push({ member: m, why, back });
	});
	return out.sort((a, b) => a.member.name.localeCompare(b.member.name));
}

export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

export const fill = (text, person) => String(text || '').replace(/\{name\}/g, firstName(person && person.name));

export function messages(data) {
	const stored = settingOf(data, 'messages') || {};
	return Object.fromEntries(Object.entries(DEFAULT_MESSAGES).map(([k, v]) => [k, stored[k] && String(stored[k]).trim() ? stored[k] : v]));
}

export function greeting(now = new Date()) {
	const h = now.getHours();
	return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export const monthName = (month) => {
	const [y, m] = month.split('-').map(Number);
	return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long' });
};

// Everyone who can take leave (not the Super Admin), active.
export const leavePeople = (data) => rowsOf(data, 'members').filter((m) => m.active && m.role !== 'admin');
