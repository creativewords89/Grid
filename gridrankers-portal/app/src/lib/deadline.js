import { addDays, daysBetween } from './cycles.js';
import { monthEnd, short } from './format.js';

// Meeting-task deadline (SPEC.md 6.3; reference itemDeadline + deadlineInfo).
// deadline JSON: {type: none|weekly|date|dates|monthly, weeks, date, from, to, month}.

export function itemDeadline(task) {
	const D = task.deadline || {};
	switch (D.type) {
		case 'weekly': {
			const weeks = [...(D.weeks || [])].sort();
			if (!weeks.length) return null;
			const ranges = weeks.map((w) => ({ start: w, end: addDays(w, 6) }));
			return { type: 'weekly', start: ranges[0].start, end: ranges[ranges.length - 1].end, ranges };
		}
		case 'monthly': {
			if (!D.month) return null;
			return { type: 'monthly', start: D.month + '-01', end: monthEnd(D.month) };
		}
		case 'date':
			return D.date ? { type: 'date', start: D.date, end: D.date } : null;
		case 'dates':
			return D.from && D.to ? { type: 'dates', start: D.from <= D.to ? D.from : D.to, end: D.from <= D.to ? D.to : D.from } : null;
		default:
			return null;
	}
}

export function deadlineInfo(task, today) {
	const D = itemDeadline(task);
	if (!D) return null;
	const open = task.status !== 'done';
	const next = D.ranges ? D.ranges.find((r) => r.end >= today) : null;
	const overdue = open && D.end < today;
	const soon = open && !overdue && daysBetween(today, next ? next.end : D.end) <= 2;
	const days = daysBetween(D.start, D.end) + 1;
	const label =
		D.type === 'weekly'
			? D.ranges.length === 1
				? `Due week of ${short(D.start)} – ${short(D.end)}`
				: `Due ${D.ranges.length} weeks${next ? ` · this one ${short(next.start)} – ${short(next.end)}` : ` · last ${short(D.end)}`}`
			: D.type === 'monthly'
				? `Due ${short(D.end)} · end of month`
				: D.type === 'date'
					? `Due ${short(D.end)}`
					: `Due ${short(D.start)} – ${short(D.end)} (${days} ${days === 1 ? 'day' : 'days'})`;
	return { ...D, overdue, soon, label, next };
}
