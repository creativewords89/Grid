import { addDays } from './cycles.js';
import { rowsOf } from './store.js';

// Days off, leave and Who's out today (SPEC.md 6.10) — the same rules as GRP_People on the
// server, which stays the source of truth for anything saved. Dates are `YYYY-MM-DD`;
// weekdays 0 (Sunday) – 6 (Saturday).

export const DEFAULT_WEEKLY_OFF = [5];
// Leave days a Full-Time or Part-Time employee gets per calendar year, by type (`day` is casual
// leave), and the festival holidays a year, until the Super Admin changes them (GRP_People,
// design HOL-10); Interns and Contractual employees get no leave days.
export const DEFAULT_LEAVE_DAYS = { day: 10, sick: 14, festival: 13 };
export const MAX_LEAVE_DAYS = 60;
export const EMPLOYMENT = { intern: 'Intern', full_time: 'Full-Time', part_time: 'Part-Time', contractual: 'Contractual' };
export const WITH_LEAVE = ['full_time', 'part_time'];
export const LEAVE_TYPE = { day: 'Casual leave', sick: 'Sick leave' };

export const DEFAULT_MESSAGES = {
	birthday: 'Happy birthday, {name}! The whole GridRankers team wishes you a wonderful year ahead.',
	day_off: 'Today is your day off, {name} — but you’re here anyway. We really appreciate it. Don’t forget to rest too.',
	leave_approved: 'Your leave was approved. Enjoy your time off, {name}!',
};

// Session key: the member page tab to open next (the Leave box's My leave link).
export const MEMBER_TAB_KEY = 'grp:member-tab';

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

// The Super Admin's leave-days rules, `[{from_year, day, sick, festival}]` in year order.
export const leaveRules = (data) => [...((settingOf(data, 'leave_days') || {}).rules || [])].sort((a, b) => a.from_year - b.from_year);

// A year's leave days `{day, sick, festival}` (GRP_People::year_days): the rule with the latest
// `from_year` not after it, else the defaults.
export function yearDays(rules, year) {
	const rule = (rules || []).filter((r) => +r.from_year <= +year).sort((a, b) => b.from_year - a.from_year)[0];
	return rule ? { day: +rule.day, sick: +rule.sick, festival: +rule.festival } : DEFAULT_LEAVE_DAYS;
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

export const employmentOf = (member) => (member && member.employment) || 'full_time';
export const hasLeave = (member) => WITH_LEAVE.includes(employmentOf(member));
// A type's leave days in a year (GRP_People::allowance). The year someone started having leave
// (`employment_since`) is prorated: months from that one to December × allowance ÷ 12, half days up.
export function allowance(member, type, year, rules = []) {
	if (!hasLeave(member)) return 0;
	const full = yearDays(rules, year == null ? new Date().getFullYear() : year)[type === 'sick' ? 'sick' : 'day'];
	const since = (member && member.employment_since) || '';
	if (year == null || !/^\d{4}-\d{2}-\d{2}$/.test(since)) return full;
	const from = +since.slice(0, 4);
	if (from > +year) return 0;
	if (from < +year) return full;
	return Math.floor((full * (13 - +since.slice(5, 7))) / 12 + 0.5);
}

// The day a person's leave year started, when it is inside `year` (their prorated first year).
export const firstYearSince = (member, year) => {
	const since = (member && member.employment_since) || '';
	return hasLeave(member) && since.slice(0, 4) === String(year) ? since : null;
};

// A person's approved leave dates of each type in a calendar year, in date order (days off not counted).
export function leaveDates(member, year, leaves, team, daysOff) {
	const out = { day: [], sick: [] };
	const first = `${year}-01-01`;
	const last = `${year}-12-31`;
	approvedOf(leaves, member.id).forEach((l) => {
		const from = l.from_date > first ? l.from_date : first;
		const to = l.to_date < last ? l.to_date : last;
		if (from > to) return;
		dates(from, to).forEach((d) => {
			if (!dayOffKind(d, member, team, daysOff)) out[l.type === 'sick' ? 'sick' : 'day'].push(d);
		});
	});
	out.day.sort();
	out.sick.sort();
	return out;
}

// The year's leave per type: {allowance, taken, left, over} (GRP_People::balance).
export function balance(member, year, leaves, team, daysOff, rules = []) {
	const dated = leaveDates(member, year, leaves, team, daysOff);
	const of = (type) => {
		const a = allowance(member, type, year, rules);
		const taken = dated[type].length;
		return { allowance: a, taken, left: Math.max(0, a - taken), over: Math.max(0, taken - a) };
	};
	return { day: of('day'), sick: of('sick') };
}

// A month's settlement (GRP_People::settlement): days past the year's allowance are deducted in
// the month they fall; December pays out the days left of both allowances.
export function settlement(member, month, leaves, team, daysOff, rules = []) {
	const dated = leaveDates(member, +month.slice(0, 4), leaves, team, daysOff);
	let taken = 0;
	let deducted = 0;
	let paid = 0;
	['day', 'sick'].forEach((type) => {
		const a = allowance(member, type, +month.slice(0, 4), rules);
		dated[type].forEach((d, i) => {
			if (d.slice(0, 7) === month) {
				taken += 1;
				if (i >= a) deducted += 1;
			}
		});
		if (month.slice(5) === '12') paid += Math.max(0, a - dated[type].length);
	});
	return { taken, result: deducted ? 'deducted' : paid ? 'paid' : 'even', paid, deducted };
}

// Days a leave request would go past the year's allowance of its type (others' rows aside).
export function overBy(member, leave, leaves, team, daysOff, rules = []) {
	const others = leaves.filter((l) => l.id !== leave.id);
	const years = [...new Set([leave.from_date.slice(0, 4), leave.to_date.slice(0, 4)])];
	const type = leave.type === 'sick' ? 'sick' : 'day';
	return years.reduce((sum, y) => {
		const a = allowance(member, type, +y, rules);
		const before = leaveDates(member, +y, others, team, daysOff)[type].length;
		const first = `${y}-01-01`;
		const last = `${y}-12-31`;
		const days = Object.values(leaveDays(leave.from_date > first ? leave.from_date : first, leave.to_date < last ? leave.to_date : last, member, team, daysOff)).reduce((x, n) => x + n, 0);
		return sum + Math.max(0, before + days - a) - Math.max(0, before - a);
	}, 0);
}

// Festival holiday days set for a year: dates of days off in it that are not the team's weekly day off.
export function festivalDays(year, daysOff, team) {
	const first = `${year}-01-01`;
	const last = `${year}-12-31`;
	const set = new Set();
	daysOff.forEach((o) => {
		const from = o.from_date > first ? o.from_date : first;
		const to = o.to_date < last ? o.to_date : last;
		if (from <= to) dates(from, to).forEach((d) => !team.includes(weekday(d)) && set.add(d));
	});
	return set.size;
}

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


// Messages greet people by their full name.
export const fill = (text, person) => String(text || '').replace(/\{name\}/g, String((person && person.name) || '').trim());

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

// Required profile (SPEC.md 6.10): labels of what a member has not filled in. While anything is
// missing, Team Leaders and Members can't work on tasks (the server refuses; the Super Admin is
// only reminded).
export const REQUIRED_PROFILE = [
	['name', 'Full name'],
	['location', 'Location'],
	['birthday', 'Date of birth'],
	['phone', 'Phone number'],
	['photo', 'Photo'],
];

export function missingProfile(member) {
	const m = member || {};
	return REQUIRED_PROFILE.filter(([k]) => !String(m[k] || '').trim() || (k === 'birthday' && !m.birth_year)).map(([, label]) => label);
}

export const profileLocked = (member, me) => me.role !== 'admin' && missingProfile(member).length > 0;
