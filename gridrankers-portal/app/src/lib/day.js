import { daysBetween, isSplit, activeSlot, dueAt } from './cycles.js';
import { deadlineInfo } from './deadline.js';
import { short } from './format.js';
import { computeMissed, recordOf, stateOf } from './monthly.js';
import { assignedFor } from './perf.js';
import { dayOffKind, dayOffName, fill, messages, missingProfile, teamWeekly } from './people.js';
import { mayDecide, pendingReviews, reviewsOf } from './reviews.js';
import { rowsOf } from './store.js';
import { cycleSetup } from './cycleSetup.js';
import { isManager } from './roles.js';
import { untickRequests } from './plan.js';

// My day (SPEC.md 7.0): what each box shows, as pure functions of the synced data.

export const PAGE_SIZE = 5;
export const SOON_DAYS = 3;
export const SHOUTOUT_DAYS = 30;

const RANK = { red: 0, amber: 1, plain: 2, none: 3 };

function flagOf(tasks, today) {
	const overdue = tasks.some((t) => t.overdue);
	const urgent = tasks.some((t) => t.urgent);
	const due = tasks.map((t) => t.due).filter(Boolean).sort()[0] || null;
	if (overdue) return { text: 'Overdue', tone: 'red', due };
	if (urgent) return { text: 'Urgent', tone: 'red', due };
	if (!due) return { text: 'No deadline', tone: 'none', due };
	const n = daysBetween(today, due);
	if (n === 0) return { text: 'Due today', tone: 'amber', due };
	if (n <= SOON_DAYS) return { text: `Due in ${n} day${n === 1 ? '' : 's'}`, tone: 'amber', due };
	return { text: `Due ${short(due)}`, tone: 'plain', due };
}

// The person's open work grouped by project, most urgent project first.
export function myProjects(data, me, today) {
	const groups = {};
	assignedFor(data, me.id, today).forEach((x) => {
		const task = {
			...x,
			overdue: !!x.due && x.due < today,
			urgent: x.priority === 'urgent',
			dueText: x.due ? (x.due < today ? `Overdue · ${short(x.due)}` : x.due === today ? 'Due today' : `Due ${short(x.due)}`) : 'No deadline',
		};
		(groups[x.project_id] = groups[x.project_id] || []).push(task);
	});
	return Object.entries(groups)
		.map(([pid, tasks]) => {
			tasks.sort((a, b) => b.overdue - a.overdue || b.urgent - a.urgent || String(a.due || '9999').localeCompare(String(b.due || '9999')) || a.title.localeCompare(b.title));
			const flag = flagOf(tasks, today);
			return { project: data.projects[pid], tasks, flag };
		})
		.sort((a, b) => RANK[a.flag.tone] - RANK[b.flag.tone] || String(a.flag.due || '9999').localeCompare(String(b.flag.due || '9999')) || a.project.name.localeCompare(b.project.name));
}

export const PROJECT_FILTERS = {
	all: () => true,
	urgent: (g) => g.tasks.some((t) => t.urgent),
	overdue: (g) => g.tasks.some((t) => t.overdue),
	week: (g, today) => !!g.flag.due && daysBetween(today, g.flag.due) <= 7,
};

export const dismissedKeys = (data, me) => new Set(rowsOf(data, 'dismissals').filter((d) => d.member_id === me.id).map((d) => d.notice_key));

const ago = (iso, days, now) => !!iso && now - new Date(String(iso).replace(' ', 'T') + (String(iso).length === 19 ? 'Z' : '')).getTime() < days * 86400000;

// Message strips at the top of My day, newest concerns first; dismissed ones left out
// unless `all` (the bell lists everything).
export function strips(data, me, today, { now = Date.now(), all = false } = {}) {
	const out = [];
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const text = messages(data);
	const year = today.slice(0, 4);
	const mmdd = today.slice(5);
	const self = data.members[me.id] || me;

	// Not dismissable: it stays until the profile is complete.
	const missing = missingProfile(self);
	if (missing.length) {
		const locked = me.role !== 'admin';
		out.push({ key: 'profile', kind: 'profile', tone: 'red', title: 'Finish your profile to keep working.', text: `Missing: ${missing.join(', ')}.${locked ? ' Your tasks are locked until it’s done.' : ''}`, ok: 'Complete profile', sticky: true });
	}

	// New cycle setup (SPEC.md 6.11), for Team Leaders and the Super Admin: not dismissable.
	if (isManager(me)) {
		cycleSetup(data, today)
			.filter((c) => !c.done)
			.forEach((c) => {
				const by = new Date(c.due + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
				const what = c.prev ? 'Assign the monthly tasks and review last cycle.' : 'Assign the monthly tasks.';
				out.push(
					c.late
						? { key: `cycle:${c.project.id}:${c.cycle.key}`, kind: 'cycle', tone: 'red', title: `${c.project.name}: new cycle setup is ${c.late} day${c.late === 1 ? '' : 's'} overdue.`, text: what, ok: 'Open setup', sticky: true }
						: { key: `cycle:${c.project.id}:${c.cycle.key}`, kind: 'cycle', tone: 'amber', title: `New cycle for ${c.project.name}.`, text: `${what.replace(/\.$/, '')} by ${by}.`, ok: 'Open setup', sticky: true },
				);
			});
	}

	const off = dayOffKind(today, self, team, daysOff);
	if (off) {
		out.push({ key: `dayoff:${today}`, kind: 'dayoff', tone: 'amber', title: fill(text.day_off, self), text: off === 'weekly' ? '' : dayOffName(today, daysOff), ok: 'Thanks' });
	}
	if (self.birthday === mmdd) out.push({ key: `bday:${year}`, kind: 'birthday', tone: 'pink', title: fill(text.birthday, self), text: '', ok: 'Thanks' });
	rowsOf(data, 'members')
		.filter((m) => m.active && m.id !== me.id && m.birthday === mmdd)
		.forEach((m) => out.push({ key: `bday:${m.id}:${year}`, kind: 'birthday', tone: 'pink', title: `Today is ${m.name}’s birthday.`, text: 'Wish them a happy birthday!' }));

	rowsOf(data, 'leave')
		.filter((l) => l.member_id === me.id && (l.status === 'approved' || l.status === 'rejected') && l.decided_by && l.decided_by !== me.id && ago(l.decided_at, 14, now))
		.forEach((l) => {
			const by = data.members[l.decided_by];
			const range = l.from_date === l.to_date ? short(l.from_date) : `${short(l.from_date)} – ${short(l.to_date)}`;
			const approved = l.status === 'approved';
			// A day off a Team Leader or the Super Admin issued (SPEC.md 6.10).
			if (approved && l.created_by && l.created_by !== l.member_id) {
				out.push({
					key: `leave:${l.id}:issued`,
					kind: 'leave',
					tone: 'green',
					title: `${by ? by.name : 'Your Team Leader'} gave you a day off · ${range} (${l.days} day${l.days === 1 ? '' : 's'}, day leave).`,
					text: l.message ? `“${l.message}”` : '',
					ok: 'Thanks',
				});
				return;
			}
			out.push({
				key: `leave:${l.id}:${l.status}`,
				kind: 'leave',
				tone: approved ? 'green' : 'red',
				title: `Your leave for ${range} was ${approved ? 'approved' : 'not approved'}.`,
				text: approved ? `${by ? by.name + ': ' : ''}“${l.message || fill(text.leave_approved, self)}”` : l.message ? `${by ? by.name + ': ' : ''}“${l.message}”` : '',
			});
		});

	pendingReviews(data)
		.filter((r) => r.review.reviewer === me.id)
		.forEach((r) => {
			const who = data.members[r.review.submittedBy];
			const p = data.projects[r.project_id];
			out.push({
				key: `ask:${r.kind}:${r.id}:${r.review.submittedAt}`,
				kind: 'review',
				tone: 'green',
				title: `${who ? who.name : 'Someone'} asked you to review “${r.title}”.`,
				text: [p && p.name, r.review.note && `“${r.review.note}”`].filter(Boolean).join(' · '),
				review: r,
				ok: 'Review now',
			});
		});

	if (all) return out;
	const gone = dismissedKeys(data, me);
	return out.filter((s) => s.sticky || !gone.has(s.key));
}

export const recipientsOf = (p) => (Array.isArray(p.to_members) ? p.to_members : p.to_member ? [p.to_member] : null);

// Notices box (SPEC.md 6.10): notices to everyone, notices to me, and shout-outs (seen by everyone
// for 30 days), newest first. `tag`: all | you | shout; `to`: "everyone", "you" or names.
export function notices(data, me, today, now = Date.now()) {
	return rowsOf(data, 'posts')
		.filter((p) => !p.deleted_at && (!p.show_until || p.show_until >= today))
		.filter((p) => (p.kind === 'shoutout' ? ago(p.created_at, SHOUTOUT_DAYS, now) : true))
		.map((p) => {
			const to = recipientsOf(p);
			const mine = !!to && to.includes(me.id);
			if (p.kind !== 'shoutout' && to && !mine) return null;
			const names = (to || []).filter((id) => id !== me.id).map((id) => (data.members[id] || {}).name).filter(Boolean);
			return {
				post: p,
				tag: p.kind === 'shoutout' ? 'shout' : to ? 'you' : 'all',
				to: !to ? 'everyone' : mine ? (names.length ? ['you', ...names].join(', ') : 'you') : names.join(', '),
				from: data.members[p.created_by],
			};
		})
		.filter(Boolean)
		.sort((a, b) => String(b.post.created_at).localeCompare(String(a.post.created_at)));
}

// Requests to undo In progress → Not started (SPEC.md 6.6) on meeting tasks and cycle records.
export function undoRequests(data) {
	const out = [];
	rowsOf(data, 'meeting_tasks').forEach((t) => {
		const u = t.undo_request;
		if (u && u.by && data.projects[t.project_id]) out.push({ kind: 'undo', id: 'item:' + t.id, at: u.at, who: data.members[u.by], undo: u, title: t.title, project: data.projects[t.project_id], tab: 'board', item: t });
	});
	rowsOf(data, 'records').forEach((r) => {
		const u = r.undo_request;
		const task = data.monthly_tasks[r.task_id];
		if (u && u.by && task && data.projects[r.project_id]) out.push({ kind: 'undo', id: 'rec:' + r.id, at: u.at, who: data.members[u.by], undo: u, title: task.title, project: data.projects[r.project_id], tab: 'monthly', record: r, task });
	});
	return out;
}

// Waiting for you (Notifications, design NF-C): Team Members' leave requests and work waiting for review. A review
// someone asked for shows only to that reviewer (and the Super Admin).
export function approvals(data, me) {
	const leave = rowsOf(data, 'leave')
		.filter((l) => l.status === 'pending' && data.members[l.member_id] && data.members[l.member_id].role === 'member' && l.member_id !== me.id)
		.map((l) => ({ kind: 'leave', id: l.id, at: l.created_at, who: data.members[l.member_id], leave: l }));
	const reviews = pendingReviews(data)
		.filter((r) => mayDecide(r, me) && (r.review.reviewer || r.review.submittedBy !== me.id))
		.map((r) => ({ kind: 'review', id: r.kind + ':' + r.id, at: r.review.submittedAt, who: data.members[r.review.submittedBy], review: r }));
	// Requests to untick a keyword box (SPEC.md 6.12) and to undo In progress (6.6): Team
	// Leaders and the Super Admin decide.
	const unticks = isManager(me) ? untickRequests(data) : [];
	const undos = isManager(me) ? undoRequests(data) : [];
	return [...leave, ...reviews, ...unticks, ...undos].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Projects tab: everything that needs attention across active projects.
export function attention(data, today) {
	const out = [];
	const active = (pid) => data.projects[pid] && data.projects[pid].state === 'active';
	const names = (t) => (t.assignees || []).map((a) => data.members[a.id] && data.members[a.id].name).filter(Boolean).join(', ');

	rowsOf(data, 'meeting_tasks').forEach((t) => {
		if (t.status === 'done' || !active(t.project_id)) return;
		const dl = deadlineInfo(t, today);
		const end = dl && (dl.next ? dl.next.end : dl.end);
		if (dl && dl.overdue) out.push({ type: 'overdue', tone: 'red', reason: `Overdue · ${short(dl.end)}`, task: t, tab: 'board', who: names(t), sort: dl.end });
		else if (end && daysBetween(today, end) <= SOON_DAYS) out.push({ type: 'soon', tone: 'amber', reason: end === today ? 'Due today' : `Due ${short(end)}`, task: t, tab: 'board', who: names(t), sort: end });
		if (!(t.assignees || []).length) out.push({ type: 'unassigned', tone: t.priority === 'urgent' ? 'red' : 'plain', reason: t.priority === 'urgent' ? 'Urgent · unassigned' : 'Unassigned', task: t, tab: 'board', who: '—', sort: '9' });
	});

	const monthly = rowsOf(data, 'monthly_tasks').filter((t) => active(t.project_id));
	computeMissed(monthly, data.projects, data.records, today).forEach((m) =>
		out.push({ type: 'overdue', tone: 'red', reason: 'Missed period', task: m.task, tab: 'monthly', who: names(m.task), sort: m.due, sub: m.label }),
	);
	monthly.forEach((t) => {
		const c = data.projects[t.project_id];
		const w = isSplit(t) ? activeSlot(t, c, 0, today) : undefined;
		const due = dueAt(t, c, w, 0, today);
		if (due < today || daysBetween(today, due) > SOON_DAYS || t.due_mode === 'none') return;
		if (stateOf(t, recordOf(data.records, t, c, w, 0, today)) === 'done') return;
		out.push({ type: 'soon', tone: 'amber', reason: due === today ? 'Due today' : `Due ${short(due)}`, task: t, tab: 'monthly', who: names(t), sort: due });
	});

	pendingReviews(data)
		.filter((r) => active(r.project_id))
		.forEach((r) => {
			const task = r.kind === 'item' ? data.meeting_tasks[r.id] : data.monthly_tasks[(data.records[r.id] || {}).task_id];
			const who = data.members[r.review.submittedBy];
			if (task) out.push({ type: 'review', tone: 'purple', reason: 'Waiting for review', task, tab: r.tab, who: who ? who.name : '', sort: String(r.review.submittedAt) });
		});

	const order = { overdue: 0, soon: 1, review: 2, unassigned: 3 };
	return out.sort((a, b) => order[a.type] - order[b.type] || String(a.sort).localeCompare(String(b.sort)));
}
