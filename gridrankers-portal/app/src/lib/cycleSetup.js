// New cycle setup (SPEC.md 6.11): within 3 days of an active project's new cycle, a Team Leader or
// the Super Admin gives every monthly task someone responsible and reviews every monthly and
// meeting task of the cycle that just ended. A reminder every day until done; nothing is blocked.
import { addDays, cycleRange, daysBetween, isSplit, slotsOf } from './cycles.js';
import { itemDeadline } from './deadline.js';
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

// Meeting tasks of a cycle: due in it, or finished in it (and those already reviewed for it, such
// as one carried over into the next cycle).
export function meetingOfCycle(data, project, range, reviewed = {}) {
	const inside = (d) => !!d && d >= range.start && d <= range.end;
	return rowsOf(data, 'meeting_tasks').filter((t) => {
		if (t.project_id !== project.id || t.deleted_at) return false;
		if (reviewed[t.id]) return true;
		if (t.status === 'done' && inside(dateOf(t.done_at))) return true;
		const due = itemDeadline(t);
		return !!due && inside(due.end) && !(t.status === 'done' && dateOf(t.done_at) < range.start);
	});
}

// Monthly tasks of a project with nobody responsible.
export const unassignedOf = (data, project) => rowsOf(data, 'monthly_tasks').filter((t) => t.project_id === project.id && !t.deleted_at && !hasPeople(t));

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
			const meeting = hadPrev ? meetingOfCycle(data, project, prev, reviews) : [];
			const reviewed = last.filter((t) => reviews[t.id]).length;
			const meetingReviewed = meeting.filter((t) => reviews[t.id]).length;
			const done = assigned === tasks.length && reviewed === last.length && meetingReviewed === meeting.length;
			if (done && today > due) return;
			out.push({ project, cycle, prev: hadPrev ? prev : null, due, tasks, assigned, last, meeting, reviews, reviewed, meetingReviewed, done, left: done || today > due ? 0 : daysBetween(today, due) + 1, late: today > due ? daysBetween(due, today) : 0 });
		});
	return out.sort((a, b) => a.done - b.done || b.late - a.late || a.due.localeCompare(b.due) || a.project.name.localeCompare(b.project.name));
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// What a setup still needs: "2 unassigned, 4 to review".
export function setupTodo(c) {
	const unassigned = c.tasks.length - c.assigned;
	const review = c.last.length - c.reviewed + c.meeting.length - c.meetingReviewed;
	return [unassigned && `${unassigned} unassigned`, review && `${review} to review`].filter(Boolean).join(', ');
}

// Reminders for Team Leaders and the Super Admin (SPEC.md 6.11), shown in the Notifications box
// and on the bell: a new one each day (the key carries the date) while the setup is not done or a
// monthly task has nobody on it. Nobody dismisses them: they go away as soon as the work is done.
export function setupReminders(data, me, today) {
	if (!me || (me.role !== 'admin' && me.role !== 'lead')) return [];
	const out = [];
	const open = cycleSetup(data, today).filter((c) => !c.done);
	const late = open.filter((c) => c.late);
	if (me.role === 'admin' && late.length > 1) {
		out.push({
			key: `setup:all:${today}`,
			kind: 'setup',
			tone: 'red',
			title: `${plural(late.length, 'project')} late on new cycle setup: ${late.map((c) => `${c.project.name} (${plural(c.late, 'day')})`).join(', ')}`,
			ok: 'Open setup',
		});
	}
	open.forEach((c) => {
		const todo = setupTodo(c);
		out.push(
			c.late
				? { key: `setup:${c.project.id}:${today}`, kind: 'setup', tone: 'red', title: `${c.project.name}: new cycle setup is ${plural(c.late, 'day')} overdue — ${todo}`, ok: 'Open setup', project: c.project }
				: { key: `setup:${c.project.id}:${today}`, kind: 'setup', tone: 'amber', title: `New cycle for ${c.project.name} — ${todo} · ${plural(c.left, 'day')} left`, ok: 'Open setup', project: c.project },
		);
	});
	// Any day: a monthly task with nobody on it (projects in setup already say so).
	const inSetup = new Set(open.map((c) => c.project.id));
	rowsOf(data, 'projects')
		.filter((p) => p.state === 'active' && !inSetup.has(p.id))
		.sort((a, b) => a.name.localeCompare(b.name))
		.forEach((project) => {
			const n = unassignedOf(data, project).length;
			if (n) out.push({ key: `unassigned:${project.id}:${today}`, kind: 'unassigned', tone: 'amber', title: `${project.name}: ${plural(n, 'monthly task has', 'monthly tasks have')} nobody assigned`, ok: 'Assign people', project });
		});
	return out;
}
