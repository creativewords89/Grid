// Notifications on My day (SPEC.md 6.10, designs NF-A / NF-C): one feed of everything that matters to a
// person, newest first — new tasks for them, reviews of their work, comments, leave answers,
// events and birthdays, notices and shout-outs. Each title reads on its own (the box shows no
// descriptions); `sub` is kept for the bell. What waits for a leader's answer (approvals) is
// shown above it, not in it (design NF-C). Keys are shared with
// the bell, so reading an item in one place marks it read in the other.
import { commentBell } from './comments.js';
import { notices, recipientsOf } from './day.js';
import { short } from './format.js';
import { reviewsOf } from './reviews.js';
import { isManager } from './roles.js';
import { rowsOf } from './store.js';

export const DAY_MS = 86400000;
// How far back the feed goes.
export const FEED_DAYS = 30;
export const PAGE_SIZE = 6;

export const FILTERS = [
	['all', 'All'],
	['task', 'Tasks'],
	['leave', 'Leave'],
	['message', 'Messages'],
	['event', 'Events'],
];

const time = (iso) => (iso ? new Date(String(iso).replace(' ', 'T') + (String(iso).length === 19 ? 'Z' : '')).getTime() : 0);
const isoOf = (iso) => new Date(time(iso)).toISOString();
const range = (a, b) => (a === b ? short(a) : `${short(a)} – ${short(b)}`);
const name = (data, id, fallback = 'Someone') => (data.members[id] ? data.members[id].name : fallback);

export function feedOf(data, me, today, now = Date.now()) {
	const since = now - FEED_DAYS * DAY_MS;
	const recent = (iso) => !!iso && time(iso) > since;
	const out = [];
	const push = (item) => item.at && out.push({ ...item, at: isoOf(item.at) });

	// New tasks assigned to me by someone else (meeting tasks and recurring tasks).
	const mineNew = (t) => (t.assignees || []).some((a) => a.id === me.id) && t.created_by && t.created_by !== me.id && recent(t.created_at) && data.projects[t.project_id];
	rowsOf(data, 'meeting_tasks')
		.filter((t) => t.status !== 'done' && mineNew(t))
		.forEach((t) =>
			push({ key: `new:${t.id}`, cat: 'task', tone: 'blue', icon: '+', title: `New task: “${t.title}”`, sub: `${name(data, t.created_by)} assigned you “${t.title}” · ${data.projects[t.project_id].name}`, at: t.created_at, open: { project_id: t.project_id, tab: 'board', title: t.title } })
		);
	rowsOf(data, 'monthly_tasks')
		.filter(mineNew)
		.forEach((t) =>
			push({ key: `newm:${t.id}`, cat: 'task', tone: 'blue', icon: '+', title: `New recurring task: “${t.title}”`, sub: `${name(data, t.created_by)} made you responsible for “${t.title}” · ${data.projects[t.project_id].name}`, at: t.created_at, open: { project_id: t.project_id, tab: 'monthly', title: t.title } })
		);

	// Reviews of my work: sent back or rejected (same keys as the bell), and approved by someone else.
	reviewsOf(data, me.id, now).forEach((r) => {
		const rejected = r.review.state === 'rejected';
		const by = name(data, r.review.by, 'A reviewer');
		push({
			key: `rv:${r.title}:${r.review.at}`,
			cat: 'task',
			tone: rejected ? 'red' : 'amber',
			icon: rejected ? '✕' : '↺',
			title: `${rejected ? 'Rejected' : 'Sent back'}: “${r.title}”`,
			sub: `${by}: “${r.title}”${r.review.note ? ` — “${r.review.note}”` : ''}`,
			at: r.review.at || r.review.submittedAt,
			open: { project_id: r.project_id, tab: r.tab, title: r.title },
		});
	});
	const approved = (rv) => rv && rv.state === 'accepted' && !rv.auto && rv.submittedBy === me.id && rv.by && rv.by !== me.id && recent(rv.at);
	rowsOf(data, 'meeting_tasks')
		.filter((t) => approved(t.review) && data.projects[t.project_id])
		.forEach((t) => push({ key: `ok:${t.id}:${t.review.at}`, cat: 'task', tone: 'green', icon: '✓', title: `Approved: “${t.title}”`, sub: `by ${name(data, t.review.by)}`, at: t.review.at, open: { project_id: t.project_id, tab: 'board', title: t.title } }));
	rowsOf(data, 'records').forEach((r) => {
		const t = data.monthly_tasks[r.task_id];
		if (t && approved(r.review) && data.projects[t.project_id]) push({ key: `ok:${r.id}:${r.review.at}`, cat: 'task', tone: 'green', icon: '✓', title: `Approved: “${t.title}”`, sub: `by ${name(data, r.review.by)}`, at: r.review.at, open: { project_id: t.project_id, tab: 'monthly', title: t.title } });
	});

	// Someone asked me to review their work (Team Members; leaders answer it under Waiting for you).
	const askedMe = (rv) => !isManager(me) && rv && rv.state === 'pending' && rv.reviewer === me.id && recent(rv.submittedAt);
	rowsOf(data, 'meeting_tasks')
		.filter((t) => askedMe(t.review) && data.projects[t.project_id])
		.forEach((t) => push({ key: `ask:${t.id}:${t.review.submittedAt}`, cat: 'task', tone: 'blue', icon: '?', title: `${name(data, t.review.submittedBy)} asked you to review “${t.title}”`, sub: '', at: t.review.submittedAt, open: { project_id: t.project_id, tab: 'board', title: t.title } }));
	rowsOf(data, 'records').forEach((r) => {
		const t = data.monthly_tasks[r.task_id];
		if (t && askedMe(r.review) && data.projects[t.project_id]) push({ key: `ask:${r.id}:${r.review.submittedAt}`, cat: 'task', tone: 'blue', icon: '?', title: `${name(data, r.review.submittedBy)} asked you to review “${t.title}”`, sub: '', at: r.review.submittedAt, open: { project_id: t.project_id, tab: 'monthly', title: t.title } });
	});

	// Comments on submissions I'm part of.
	commentBell(data, me, now).forEach((c) => push({ key: c.key, cat: 'task', tone: 'blue', icon: '💬', title: c.text, sub: c.sub, at: c.at, open: { project_id: c.project_id, tab: c.tab, title: c.title } }));

	// Answers to my leave (same keys as the message band).
	rowsOf(data, 'leave')
		.filter((l) => l.member_id === me.id && (l.status === 'approved' || l.status === 'rejected') && l.decided_by && l.decided_by !== me.id && recent(l.decided_at))
		.forEach((l) => {
			const ok = l.status === 'approved';
			const issued = ok && l.created_by && l.created_by !== l.member_id;
			const type = l.type === 'sick' ? 'Sick leave' : 'Day leave';
			push({
				key: issued ? `leave:${l.id}:issued` : `leave:${l.id}:${l.status}`,
				cat: 'leave',
				tone: ok ? 'green' : 'red',
				icon: ok ? '✚' : '✕',
				title: `${issued ? 'Day off given to you' : `${type} ${ok ? 'approved' : 'not approved'}`} · ${range(l.from_date, l.to_date)}`,
				sub: `${range(l.from_date, l.to_date)} · ${l.days} day${l.days === 1 ? '' : 's'}${l.message ? ` — “${l.message}”` : ''} — ${name(data, l.decided_by)}`,
				at: l.decided_at,
			});
		});

	// Events and office days off from today to two weeks ahead; birthdays today.
	const horizon = new Date(Date.parse(today + 'T00:00:00Z') + 14 * DAY_MS).toISOString().slice(0, 10);
	rowsOf(data, 'days_off')
		.filter((d) => d.to_date >= today && d.from_date <= horizon)
		.forEach((d) => push({ key: `ev:${d.id}`, cat: 'event', tone: 'purple', icon: '◆', title: `${d.name} · ${range(d.from_date, d.to_date)}`, sub: `${range(d.from_date, d.to_date)} · everyone is off`, at: d.created_at }));
	const mmdd = today.slice(5);
	rowsOf(data, 'members')
		.filter((m) => m.active && m.id !== me.id && m.birthday === mmdd)
		.forEach((m) => push({ key: `bday:${m.id}:${today.slice(0, 4)}`, cat: 'event', tone: 'pink', icon: '🎂', title: `Today is ${m.name}’s birthday`, sub: 'Wish them a happy birthday!', at: today + 'T00:00:00Z' }));

	// Notices and shout-outs (same keys as the bell).
	notices(data, me, today, now)
		.filter((n) => recent(n.post.created_at))
		.forEach((n) => {
			const shout = n.tag === 'shout';
			const from = n.from ? n.from.name : 'A Team Leader';
			push({
				key: `${shout ? 'shout' : 'notice'}:${n.post.id}`,
				cat: 'message',
				tone: shout ? 'pink' : 'grey',
				icon: shout ? '★' : '📣',
				title: shout ? `Shout-out from ${from}${(recipientsOf(n.post) || []).includes(me.id) ? '' : ` → ${n.to}`}: ${n.post.body}` : `${from} → ${n.to}: ${n.post.title || n.post.body}`,
				sub: n.post.body,
				at: n.post.created_at,
			});
		});

	return out.sort((a, b) => b.at.localeCompare(a.at));
}

// Counts per filter.
export const countsOf = (items) => Object.fromEntries(FILTERS.map(([k]) => [k, k === 'all' ? items.length : items.filter((i) => i.cat === k).length]));

// "5 min ago", "2 h ago", "Today 9:10", "Yesterday", "Mon, Oct 6".
export function ago(iso, now = Date.now()) {
	const t = time(iso);
	const min = Math.floor((now - t) / 60000);
	if (min < 1) return 'Just now';
	if (min < 60) return `${min} min ago`;
	if (min < 6 * 60) return `${Math.floor(min / 60)} h ago`;
	const d = new Date(t);
	const n = new Date(now);
	if (d.toDateString() === n.toDateString()) return `Today ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
	if (new Date(now - DAY_MS).toDateString() === d.toDateString()) return 'Yesterday';
	return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

