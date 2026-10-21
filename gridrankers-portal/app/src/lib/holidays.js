// Daily reports → Holidays (SPEC.md 6.20, designs HOL-1 to HOL-3): the month calendar, the
// festival holidays of a year and the tiles. The rules are those of people.js (SPEC.md 6.10).
import { addMonths } from './pay.js';
import { dates, dayOffKind, festivalDays, weekday } from './people.js';

export const WEEK = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// Every date of a month, `YYYY-MM-DD`.
export function monthDates(month) {
	const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
	return dates(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`);
}

// The month as calendar cells from Saturday: blanks (null) before the 1st.
export function monthCells(month) {
	const days = monthDates(month);
	return [...Array((weekday(days[0]) + 1) % 7).fill(null), ...days];
}

// The twelve months of a year.
export const yearMonths = (year) => Array.from({ length: 12 }, (_, i) => addMonths(`${year}-01`, i));

// Festival holidays (event and seasonal days off) touching a year, in date order, each with its
// festival days counted in that year (the weekly day off left out).
export function holidaysOf(year, daysOff, team) {
	const first = `${year}-01-01`;
	const last = `${year}-12-31`;
	return daysOff
		.filter((o) => o.from_date <= last && o.to_date >= first)
		.sort((a, b) => a.from_date.localeCompare(b.from_date))
		.map((o) => ({ ...o, days: festivalDays(year, [o], team) }));
}

// Working days of a month for the team: not the weekly day off, not a festival holiday.
export const workingDays = (month, team, daysOff) => monthDates(month).filter((d) => !dayOffKind(d, { weekly_off: null }, team, daysOff)).length;

// The festival holiday on a date, or null.
export const holidayOn = (date, daysOff) => daysOff.find((o) => date >= o.from_date && date <= o.to_date) || null;

// What a calendar day shows, for the viewer: per person on leave or asking for it. Managers see
// the type ("Rajon · sick") and waiting requests ("Homayun · asked"); a Team Member sees their own
// leave ("You · sick") and teammates only as "{name} out" (SPEC.md 6.10: no reason shown).
export function dayChips(date, leaves, members, me, manager) {
	const out = [];
	leaves.forEach((l) => {
		if (date < l.from_date || date > l.to_date) return;
		const who = members[l.member_id];
		if (!who || (l.status !== 'approved' && l.status !== 'pending')) return;
		const own = l.member_id === me.id;
		if (l.status === 'pending' && !manager && !own) return;
		const first = own ? 'You' : who.name.split(' ')[0];
		const kind = l.status === 'pending' ? 'asked' : l.type === 'sick' ? 'sick' : 'casual';
		if (!manager && !own) out.push({ id: l.id, tone: 'out', label: `${first} out` });
		else out.push({ id: l.id, tone: own && !manager ? 'you' : kind, label: `${first} · ${kind}` });
	});
	return out;
}

// Approved leave days taken in a month (days off not counted) and by how many people.
export function takenThisMonth(month, leaves, members, team, daysOff) {
	const days = monthDates(month);
	const people = new Set();
	let total = 0;
	leaves.forEach((l) => {
		const who = members[l.member_id];
		if (l.status !== 'approved' || !who) return;
		const n = days.filter((d) => d >= l.from_date && d <= l.to_date && !dayOffKind(d, who, team, daysOff)).length;
		if (n) {
			total += n;
			people.add(l.member_id);
		}
	});
	return { days: total, people: people.size };
}

// Festival holiday days of a year still to come from today.
export const holidaysAhead = (year, daysOff, team, today) =>
	festivalDays(
		year,
		daysOff.map((o) => ({ ...o, from_date: o.from_date > today ? o.from_date : today })).filter((o) => o.from_date <= o.to_date),
		team,
	);
