import { activeWeek, cycleRange, daysBetween, dueAt, isWeekly, weekRange, weeksIn } from './cycles.js';
import { localYmd, short } from './format.js';

// Recurring-task state per period, ported from the reference (recId, mRec, mState,
// isWaived, resolved, bornAt, computeMissed).

// Weekly: `{cycle key}-wN` (cycle weeks, SPEC.md 6.2); otherwise the cycle key.
export const periodKeyOf = (task, project, w, off, today) =>
	isWeekly(task) ? `${cycleRange(project, off, today).key}-w${(w ?? activeWeek(project, off, today)) + 1}` : cycleRange(project, off, today).key;

export const recordOf = (records, task, project, w, off, today) => records[`${task.id}__${periodKeyOf(task, project, w, off, today)}`] || null;

export function stateOf(task, rec) {
	const n = Math.max(1, task.target || 1);
	const count = rec && rec.status !== 'skipped' ? rec.count || 0 : 0;
	if (count >= n) return 'done';
	if (rec && (rec.status === 'doing' || count > 0)) return 'doing';
	return 'todo';
}

export const isWaived = (task, project, off, today) => !isWeekly(task) && cycleRange(project, off, today).monthly === 'waived';

export function resolved(task, project, records, w, off, today) {
	if (isWaived(task, project, off, today)) return true;
	const rec = recordOf(records, task, project, w, off, today);
	return stateOf(task, rec) === 'done' || (rec && rec.status === 'skipped');
}

// Tasks count from the start of the period (weekly: the cycle week) they were added in.
export function bornAt(task, project, today) {
	const created = localYmd(task.created_at) || today;
	for (let off = 0; off >= -36; off--) {
		const r = cycleRange(project, off, today);
		if (r.start <= created) {
			if (!isWeekly(task)) return r.start;
			const week = weeksIn(r).filter((x) => x.start <= created).pop();
			return week ? week.start : r.start;
		}
	}
	return created;
}

// Every past period (up to 6 cycles back) that ended without the task being finished.
export function computeMissed(tasks, projects, records, today) {
	const out = [];
	for (const t of tasks) {
		const c = projects[t.project_id];
		if (!c) continue;
		const born = bornAt(t, c, today);
		for (let off = 0; off >= -6; off--) {
			const cr = cycleRange(c, off, today);
			if (cr.end < born) break;
			if (off < 0 && cr.key === cycleRange(c, off + 1, today).key) break;
			if (t.due_mode === 'none' && off === 0) continue;
			const weeks = isWeekly(t) ? weeksIn(cr).map((_, i) => i) : [undefined];
			for (const w of weeks) {
				const due = dueAt(t, c, w, off, today);
				if (due >= today || due < born || resolved(t, c, records, w, off, today)) continue;
				const wr = w !== undefined ? weekRange(c, w, off, today) : null;
				const label = wr ? `Week ${w + 1} · ${short(wr.start)}–${short(wr.end)}` : off === 0 ? `This cycle · was due ${short(due)}` : `${cr.transition ? 'Transition' : 'Cycle'} ${short(cr.start)}–${short(cr.end)}`;
				out.push({ task: t, project: c, off, w, due, label, days: Math.max(1, daysBetween(due, today)) });
			}
		}
	}
	return out.sort((a, b) => a.due.localeCompare(b.due));
}

export const DUE_MODE_TEXT = (t) =>
	({
		none: 'No deadline',
		weekly: 'Weekly — end of each week',
		date: `Day ${t.due_day} of each cycle`,
		dates: `Days ${t.due_from_day}–${t.due_day} of each cycle`,
		monthly: 'Monthly — end of each cycle',
	})[t.due_mode || 'monthly'];

export const M_STATUS_TXT = { todo: 'Not started', doing: 'In progress', done: 'Completed' };

// People on a breakdown row (legacy rows had a single `who`).
export const typePeople = (part, members) => (Array.isArray(part.people) && part.people.length ? part.people : part.who ? [{ id: part.who, n: part.n }] : []).filter((a) => members[a.id]);

export const isShared = (task) => !task.team && (task.assignees || []).length > 1;
