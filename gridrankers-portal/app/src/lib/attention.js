// Projects tab (SPEC.md 7.0, design PJ-A4): what needs attention in each project, most urgent
// first — the new cycle setup, overdue work, monthly tasks with nobody, urgent tasks and work
// waiting for review — and the project's health from it (red / amber / green).
import { cycleSetup, hasPeople } from './cycleSetup.js';
import { daysBetween } from './cycles.js';
import { deadlineInfo } from './deadline.js';
import { computeMissed } from './monthly.js';
import { pendingReviews } from './reviews.js';
import { rowsOf } from './store.js';

const RANK = { red: 0, amber: 1, purple: 2 };
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

// `setup`: this project's entry from cycleSetup(), if any; `reviews`: pendingReviews(data).
export function attentionOf(project, data, reviews, today, setup) {
	const out = [];
	if (setup && !setup.done) {
		const when = new Date(setup.due + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
		out.push({ key: 'setup', title: 'New cycle setup', why: setup.late ? `${days(setup.late)} overdue` : `due ${when}`, tone: setup.late ? 'red' : 'amber', setup: true, rank: setup.late ? -1 : 0.5 });
	}
	const meeting = rowsOf(data, 'meeting_tasks').filter((t) => t.project_id === project.id && t.status !== 'done');
	const monthly = rowsOf(data, 'monthly_tasks').filter((t) => t.project_id === project.id && !t.deleted_at);
	meeting.forEach((t) => {
		const d = deadlineInfo(t, today);
		if (d && d.overdue) out.push({ key: 'o:' + t.id, title: t.title, why: `overdue ${days(Math.max(1, daysBetween(d.end, today)))}`, tone: 'red', open: { tab: 'board', title: t.title }, late: daysBetween(d.end, today) });
	});
	computeMissed(monthly, data.projects, data.records, today).forEach((m) => {
		const slot = m.w !== undefined ? ` · ${m.label.split(' · ')[0]}` : '';
		out.push({ key: `m:${m.task.id}:${m.off}:${m.w}`, title: m.task.title + slot, why: `overdue ${days(m.days)}`, tone: 'red', open: { tab: 'monthly', title: m.task.title }, late: m.days });
	});
	if (project.state === 'active') {
		monthly.filter((t) => !hasPeople(t)).forEach((t) => out.push({ key: 'u:' + t.id, title: t.title, why: 'nobody assigned', tone: 'amber', open: { tab: 'monthly', title: t.title } }));
	}
	meeting
		.filter((t) => t.priority === 'urgent' && !(deadlineInfo(t, today) || {}).overdue)
		.forEach((t) => out.push({ key: 'g:' + t.id, title: t.title, why: 'urgent', tone: 'amber', open: { tab: 'board', title: t.title } }));
	reviews
		.filter((r) => r.project_id === project.id)
		.forEach((r) => out.push({ key: 'r:' + r.id, title: r.title, why: 'to review', tone: 'purple', open: { tab: r.tab, title: r.title } }));
	return out.sort((a, b) => (a.rank ?? RANK[a.tone]) - (b.rank ?? RANK[b.tone]) || (b.late || 0) - (a.late || 0));
}

// Red: something overdue (or the setup is late); amber: anything else to look at; green: nothing.
export const healthOf = (items) => (items.some((i) => i.tone === 'red') ? 'red' : items.length ? 'amber' : 'green');

// The people on a project's work: Responsible people of its monthly tasks and open meeting tasks.
export function teamOf(project, data) {
	const ids = new Set();
	rowsOf(data, 'monthly_tasks')
		.filter((t) => t.project_id === project.id && !t.deleted_at)
		.forEach((t) => (t.assignees || []).forEach((a) => ids.add(a.id)));
	rowsOf(data, 'meeting_tasks')
		.filter((t) => t.project_id === project.id && t.status !== 'done')
		.forEach((t) => (t.assignees || []).forEach((a) => ids.add(a.id)));
	return [...ids].map((id) => data.members[id]).filter((m) => m && m.active);
}

// Every project's items at once: `{projectId: items}`.
export function attentionByProject(data, today) {
	const reviews = pendingReviews(data);
	const setups = Object.fromEntries(cycleSetup(data, today).map((c) => [c.project.id, c]));
	return Object.fromEntries(rowsOf(data, 'projects').map((p) => [p.id, attentionOf(p, data, reviews, today, setups[p.id])]));
}

// The number on the Projects tab: active projects with something that needs attention.
export const attentionCount = (data, byProject) => rowsOf(data, 'projects').filter((p) => p.state === 'active' && (byProject[p.id] || []).length).length;
