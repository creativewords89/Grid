// New cycle setup (SPEC.md 6.11): within 3 days of an active project's new cycle, a Team Leader or
// the Super Admin gives every monthly task someone responsible and reviews every monthly task of
// the cycle that just ended. Reminders on days 1–3, then overdue. Nothing is blocked.
import { addDays, cycleRange, daysBetween, isSplit, slotsOf } from './cycles.js';
import { recordOf } from './monthly.js';
import { rowsOf } from './store.js';

export const SETUP_DAYS = 3;
export const SINCE_KEY = 'cycle_setup_since';

const dateOf = (at) => String(at || '').slice(0, 10);

// Someone is responsible: Responsible people, or people on a breakdown row.
export const hasPeople = (t) => (t.assignees || []).length > 0 || (t.parts || []).some((p) => (p.people || []).length > 0 || p.who);

// Last cycle's progress on a task: done / target (weekly and bi-weekly: summed over the periods).
export function lastCycleCount(data, task, project, today) {
	const target = Math.max(1, task.target || 1);
	const slots = isSplit(task) ? slotsOf(task, project, -1, today) : [undefined];
	let got = 0;
	slots.forEach((_, w) => {
		const rec = recordOf(data.records, task, project, isSplit(task) ? w : undefined, -1, today);
		if (rec && rec.status !== 'skipped') got += Math.min(target, rec.count || 0);
	});
	return { got, need: target * slots.length };
}

// The setup of each active project whose current cycle started on or after the rule began; done
// ones stay listed until the end of day 3. Most overdue first.
export function cycleSetup(data, today) {
	const row = rowsOf(data, 'settings').find((s) => s.setting_key === SINCE_KEY);
	const since = row && row.value && row.value.date;
	if (!since) return [];
	const out = [];
	rowsOf(data, 'projects')
		.filter((p) => p.state === 'active')
		.forEach((project) => {
			const cycle = cycleRange(project, 0, today);
			if (!cycle || cycle.start < since || cycle.start > today) return;
			const due = addDays(cycle.start, SETUP_DAYS - 1);
			const tasks = rowsOf(data, 'monthly_tasks').filter((t) => t.project_id === project.id && !t.deleted_at);
			const assigned = tasks.filter(hasPeople).length;
			const prev = cycleRange(project, -1, today);
			// A project that did not exist last cycle has nothing to review.
			const hadPrev = prev && prev.key !== cycle.key && dateOf(project.created_at) <= prev.end;
			const last = hadPrev ? tasks.filter((t) => dateOf(t.created_at) <= prev.end) : [];
			const reviews = (hadPrev && (project.cycle_reviews || {})[prev.key]) || {};
			const reviewed = last.filter((t) => reviews[t.id]).length;
			const done = assigned === tasks.length && reviewed === last.length;
			if (done && today > due) return;
			out.push({ project, cycle, prev: hadPrev ? prev : null, due, tasks, assigned, last, reviews, reviewed, done, late: today > due ? daysBetween(due, today) : 0 });
		});
	return out.sort((a, b) => a.done - b.done || b.late - a.late || a.due.localeCompare(b.due) || a.project.name.localeCompare(b.project.name));
}
