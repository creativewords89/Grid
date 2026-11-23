// New cycle setup (SPEC.md 6.11): within 3 days of an active project's new cycle, a Team Leader or
// the Super Admin gives every monthly task someone responsible and reviews every monthly and
// meeting task of the cycle that just ended. A reminder every day until done; nothing is blocked.
import { addDays, cycleRange, daysBetween, isSplit, slotsOf } from './cycles.js';
import { itemDeadline } from './deadline.js';
import { linksOf } from './files.js';
import { recordOf } from './monthly.js';
import { rowsOf } from './store.js';
import { chaseReminders } from './requests.js';

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

// What a monthly task left undone last cycle (skipped periods count as nothing to do).
export function leftLastCycle(data, task, project, today) {
	const target = Math.max(1, task.target || 1);
	const slots = isSplit(task) ? slotsOf(task, project, -1, today) : [undefined];
	let left = 0;
	slots.forEach((_, w) => {
		const rec = recordOf(data.records, task, project, isSplit(task) ? w : undefined, -1, today);
		if (!rec || rec.status !== 'skipped') left += target - Math.min(target, (rec && rec.count) || 0);
	});
	return left;
}

// Short name of a cycle for "1 left from Sep": the month it starts in (same as the server).
export const cycleLabel = (range) => new Date(range.start + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });

// Key in a cycle's reviews for the unfinished tasks left in it (same as the server).
export const LEFT_KEY = '_left';

// Unfinished work of last cycle (SPEC.md 6.11, design CO-1A): monthly tasks with something left and
// every open meeting task whose deadline passed before this cycle, or with none from before it. Nothing
// moves unless a leader moves it: a monthly task becomes a catch-up task in the new cycle, a meeting
// task keeps its card with a new deadline. `moved` is the catch-up task, or the meeting task once
// moved.
export function unfinishedOf(data, c, today) {
	if (!c.prev) return [];
	// "Leave in {month}" decisions (design UF-1A), kept with last cycle's reviews.
	const kept = (c.reviews && c.reviews[LEFT_KEY]) || {};
	const meetings = rowsOf(data, 'meeting_tasks').filter((t) => t.project_id === c.project.id && !t.deleted_at);
	const catchUp = (task) => meetings.find((m) => m.carried && m.carried.from === 'monthly' && m.carried.task_id === task.id && m.carried.cycle === c.prev.key) || null;
	const monthly = c.last
		.map((task) => ({ task, kind: 'monthly', left: leftLastCycle(data, task, c.project, today), ...lastCycleCount(data, task, c.project, today), moved: catchUp(task), kept: kept[task.id] || null }))
		.filter((u) => u.left > 0 || u.moved);
	// Its deadline passed before this cycle, or it has none and was added before this cycle.
	const behind = (t) => {
		const due = itemDeadline(t);
		return due ? due.end < c.cycle.start : dateOf(t.created_at) <= c.prev.end;
	};
	const meeting = meetings
		.filter((t) => (t.carried && t.carried.from === 'meeting' && t.carried.cycle === c.prev.key) || (t.status !== 'done' && !(t.carried && t.carried.from === 'monthly') && behind(t)))
		.sort((a, b) => a.title.localeCompare(b.title))
		.map((task) => ({ task, kind: 'meeting', moved: task.carried && task.carried.from === 'meeting' && task.carried.cycle === c.prev.key ? task : null, kept: kept[task.id] || null }));
	return [...monthly, ...meeting];
}

// The work handed in for a task last cycle, for Review last cycle: the submission's note, files and
// links (meeting task, or each period's record of a monthly task) and the files and links handed in
// on its steps. Files once each; links as {url, name}.
// A short name for a link: "Sheet", "Doc", "Slides", "Form", "Drive" (Google), or the site's name.
export function linkName(url) {
	const m = String(url).match(/^https?:\/\/(?:www\.)?([^/?#]+)([^?#]*)/i);
	if (!m) return String(url);
	const [, host, path] = m;
	if (host === 'docs.google.com') {
		const kind = { spreadsheets: 'Sheet', document: 'Doc', presentation: 'Slides', forms: 'Form' }[path.split('/')[1]];
		if (kind) return kind;
	}
	if (host === 'drive.google.com') return 'Drive';
	return host;
}

export function lastCycleWork(data, task, project, today, meeting) {
	const sources = meeting
		? [task]
		: (isSplit(task) ? slotsOf(task, project, -1, today) : [undefined]).map((_, w) => recordOf(data.records, task, project, isSplit(task) ? w : undefined, -1, today)).filter((r) => r && r.status !== 'skipped');
	const files = new Map();
	const links = new Map();
	const notes = [];
	const handedBy = new Map();
	const addLink = (l) => {
		const url = typeof l === 'string' ? l : l && l.url;
		const named = l && l.name && !/^(https?:\/\/|www\.)|\.[a-z]{2,}\//i.test(l.name) ? l.name : '';
		if (url && /^https?:\/\//.test(url) && !links.has(url)) links.set(url, { url, name: named || linkName(url) });
	};
	sources.forEach((src) => {
		const done = src.completion;
		if (done) {
			// Who finished it and when, with what they wrote (design RV-1B2).
			if (done.note || done.by) notes.push({ text: done.note || '', by: done.by || null, at: done.at || null });
			(done.files || []).forEach((f) => files.set(f.id, f));
			linksOf(done).forEach(addLink);
		}
		Object.values(src.handins || {}).forEach((items) =>
			Object.values(items || {}).forEach((got) => {
				(got.files || []).forEach((f) => files.set(f.id, f));
				(got.links || []).forEach(addLink);
				const was = got.by && handedBy.get(got.by);
				if (got.by && (!was || String(got.at || '') > String(was.at || ''))) handedBy.set(got.by, { text: '', by: got.by, at: got.at || null });
			}),
		);
	});
	// No submission yet: who handed in the steps, and when.
	if (!notes.length) notes.push(...handedBy.values());
	return { notes, files: [...files.values()], links: [...links.values()] };
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
			// Every unfinished task of last cycle needs a decision (design UF-1A): left or moved.
			const open = hadPrev ? unfinishedOf(data, { project, cycle, prev, last, reviews }, today) : [];
			const unfinished = open.filter((u) => !u.moved && !u.kept).length;
			const done = assigned === tasks.length && reviewed === last.length && meetingReviewed === meeting.length && unfinished === 0;
			if (done && today > due) return;
			const entry = { project, cycle, prev: hadPrev ? prev : null, due, tasks, assigned, last, meeting, reviews, reviewed, meetingReviewed, done, left: done || today > due ? 0 : daysBetween(today, due) + 1, late: today > due ? daysBetween(due, today) : 0 };
			entry.unfinished = unfinished;
			entry.unfinishedAll = open.length;
			entry.unfinishedMoved = open.filter((u) => u.moved).length;
			out.push(entry);
		});
	return out.sort((a, b) => a.done - b.done || b.late - a.late || a.due.localeCompare(b.due) || a.project.name.localeCompare(b.project.name));
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// What a setup still needs: "2 unassigned, 4 to review, 1 unfinished to decide".
export function setupTodo(c) {
	const unassigned = c.tasks.length - c.assigned;
	const review = c.last.length - c.reviewed + c.meeting.length - c.meetingReviewed;
	return [unassigned && `${unassigned} unassigned`, review && `${review} to review`, c.unfinished && `${c.unfinished} unfinished to decide`].filter(Boolean).join(', ');
}

// Reminders for Team Leaders and the Super Admin (SPEC.md 6.11), shown in the Notifications box
// and on the bell: a new one each day (the key carries the date) while the setup is not done or a
// monthly task has nobody on it. Nobody dismisses them: they go away as soon as the work is done.
// Every daily reminder that stays until its work is done: cycle setup (SPEC.md 6.11), then client
// requests to chase (SPEC.md 6.15). The Super Admin's invoices are not here (design IN-1C):
// Invoices in the sidebar counts them.
export const allReminders = (data, me, today) => [...setupReminders(data, me, today), ...chaseReminders(data, me, today)];

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
		// Only the unfinished tasks are left (design UF-1A): the reminder opens them straight away.
		const onlyUnfinished = c.unfinished > 0 && c.assigned === c.tasks.length && c.reviewed === c.last.length && c.meetingReviewed === c.meeting.length;
		const base = onlyUnfinished
			? { key: `unfinished:${c.project.id}:${today}`, kind: 'unfinished', ok: 'Decide unfinished', project: c.project }
			: { key: `setup:${c.project.id}:${today}`, kind: 'setup', ok: 'Open setup', project: c.project };
		const what = onlyUnfinished ? `${plural(c.unfinished, 'task')} not finished in ${cycleLabel(c.prev)} — leave or move to ${cycleLabel(c.cycle)}` : todo;
		out.push(
			c.late
				? { ...base, tone: 'red', title: `${c.project.name}: new cycle setup is ${plural(c.late, 'day')} overdue — ${what}` }
				: { ...base, tone: 'amber', title: onlyUnfinished ? `${c.project.name}: ${what} · ${plural(c.left, 'day')} left` : `New cycle for ${c.project.name} — ${todo} · ${plural(c.left, 'day')} left` },
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
