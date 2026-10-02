import { activeSlot, addDays, cycleRange, daysBetween, dueAt, isSplit, parts, slotLabel, slotRange, slotsOf, ymd } from './cycles.js';
import { deadlineInfo, itemDeadline } from './deadline.js';
import { localYmd, mondayOf, short, toDate } from './format.js';
import { bornAt, isShared, recordOf, stateOf, typePeople } from './monthly.js';
import { rowsOf } from './store.js';
import { PRI } from './tasks.js';

// Team / member page helpers, ported from the reference (perfRange, perfStats, assignedFor,
// missedWork, calEvents, personEvents). Dates are 'YYYY-MM-DD'.

export function perfRange(mode, anchor) {
	const [y, m, d] = parts(anchor);
	const D = toDate(anchor);
	if (mode === 'day') return { start: anchor, end: anchor, label: D.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }) };
	if (mode === 'week') {
		const w = Math.min(3, Math.floor((d - 1) / 7));
		const s = ymd(y, m, 1 + 7 * w);
		const e = w < 3 ? ymd(y, m, 7 + 7 * w) : ymd(y, m + 1, 0);
		return { start: s, end: e, w, label: `Week ${w + 1} · ${short(s)} – ${short(e)}` };
	}
	return { start: ymd(y, m, 1), end: ymd(y, m + 1, 0), label: D.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
}

export function perfShift(mode, anchor, dir) {
	const [y, m, d] = parts(anchor);
	if (mode === 'day') return ymd(y, m, d + dir);
	if (mode === 'month') return ymd(y, m + dir, 1);
	const w = Math.min(3, Math.floor((d - 1) / 7));
	if (dir > 0) return w < 3 ? ymd(y, m, 1 + 7 * (w + 1)) : ymd(y, m + 1, 1);
	return w > 0 ? ymd(y, m, 1 + 7 * (w - 1)) : ymd(y, m - 1, 22);
}

export const daysIn = (r) => {
	const out = [];
	for (let d = r.start; d <= r.end; d = addDays(d, 1)) out.push(d);
	return out;
};
export const inRange = (x, r) => x.date >= r.start && x.date <= r.end;

export function perfStats(list) {
	const auto = list.filter((x) => x.kind !== 'manual');
	const man = list.filter((x) => x.kind === 'manual');
	const done = auto.reduce((a, x) => a + (x.qty || 1), 0);
	return { done, manual: man.length, minutes: list.reduce((a, x) => a + (+x.minutes || 0), 0), days: new Set(list.map((x) => x.date)).size, total: done + man.length };
}

export const fmtDur = (m) => (!m ? '' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}`);

export const periodWord = (mode) => (mode === 'day' ? 'today' : mode === 'week' ? 'this week' : 'this month');

const shareOf = (t, pid) => ((t.assignees || []).find((a) => a.id === pid) || {}).n || 0;
const isOn = (t, pid) => (t.assignees || []).some((a) => a.id === pid);

// Open work assigned to someone: meeting tasks not done, recurring tasks not done this period.
export function assignedFor(data, pid, today) {
	const out = [];
	rowsOf(data, 'meeting_tasks').forEach((i) => {
		if (!isOn(i, pid) || i.status === 'done' || !data.projects[i.project_id]) return;
		const dl = deadlineInfo(i, today);
		const target = Math.max(1, i.target || 1);
		out.push({
			kind: 'board',
			id: i.id,
			project_id: i.project_id,
			title: i.title,
			priority: i.priority || 'normal',
			group: i.status === 'doing' ? 'doing' : 'todo',
			sub:
				(target > 1 ? `${(i.progress || {})[pid] || 0}/${shareOf(i, pid) || target} done${(i.assignees || []).length > 1 ? ' (your share)' : ''} · ` : '') +
				(i.status === 'doing' ? 'In progress' : 'To fix'),
			when: dl ? (dl.overdue ? 'Overdue · ' : '') + dl.label : i.meeting_date ? `From meeting ${short(i.meeting_date)}` : '',
			sort: dl && dl.overdue ? -1 : PRI[i.priority] ?? 2,
			due: itemDeadline(i)?.end || null,
		});
	});
	rowsOf(data, 'monthly_tasks').forEach((t) => {
		const c = data.projects[t.project_id];
		if (!isOn(t, pid) || !c) return;
		// Monthly tasks reach people only while their project is active (SPEC.md 6.8).
		if ((c.state || 'active') !== 'active') return;
		const w = isSplit(t) ? activeSlot(t, c, 0, today) : undefined;
		const rec = recordOf(data.records, t, c, w, 0, today);
		const st = stateOf(t, rec);
		const shared = isShared(t);
		const mineDone = ((rec && rec.by_person) || {})[pid] || 0;
		if (st === 'done' || (shared && mineDone >= shareOf(t, pid))) return;
		const n = shared ? shareOf(t, pid) : Math.max(1, t.target || 1);
		const cnt = shared ? mineDone : rec && rec.status !== 'skipped' ? rec.count || 0 : 0;
		const due = dueAt(t, c, w, 0, today);
		const late = due < today;
		out.push({
			kind: 'monthly',
			id: t.id,
			project_id: t.project_id,
			title: t.title,
			priority: late ? 'urgent' : 'normal',
			group: st === 'doing' || cnt > 0 ? 'doing' : 'todo',
			sub: `${isSplit(t) ? slotLabel(t, slotRange(t, c, w, 0, today), w) : 'This cycle'}${n > 1 ? ` · ${cnt}/${n} done${shared ? ' (your share)' : ''}` : shared ? ' · shared' : ''}`,
			when: late ? `Overdue since ${short(due)}` : `Due ${short(due)}`,
			due,
			sort: late ? 0 : 1.5,
		});
	});
	return out.sort((a, b) => a.sort - b.sort || String(a.title).localeCompare(String(b.title)));
}

// Recurring periods that ended inside r without this person's share done (skipped excluded).
export function missedWork(data, pid, r, today) {
	const out = [];
	const to = r.end < today ? r.end : addDays(today, -1);
	rowsOf(data, 'monthly_tasks').forEach((t) => {
		const c = data.projects[t.project_id];
		if (!isOn(t, pid) || !c) return;
		// Monthly tasks reach people only while their project is active (SPEC.md 6.8).
		if ((c.state || 'active') !== 'active') return;
		const need = isShared(t) ? shareOf(t, pid) : Math.max(1, t.target || 1);
		const born = bornAt(t, c, today);
		const check = (w, off, label, end) => {
			if (end > to || end < r.start) return;
			const rec = recordOf(data.records, t, c, w, off, today);
			if (rec && rec.status === 'skipped') return;
			const got = isShared(t) ? ((rec && rec.by_person) || {})[pid] || 0 : rec ? rec.count || 0 : 0;
			if (got < need) out.push({ title: t.title, project_id: t.project_id, label, got, need, end });
		};
		for (let off = -3; off <= 0; off++) {
			const cr = cycleRange(c, off, today);
			if (cr.end < born) continue;
			if (isSplit(t)) {
				slotsOf(t, c, off, today).forEach((wr, w) => {
					if (wr.start >= born) check(w, off, `${slotLabel(t, wr, w)} · from ${short(wr.start)}`, wr.end);
				});
			} else check(undefined, off, `Cycle ${short(cr.start)} – ${short(cr.end)}`, cr.end);
		}
	});
	const seen = new Set();
	return out.filter((x) => !seen.has(x.title + x.label) && seen.add(x.title + x.label)).sort((a, b) => a.end.localeCompare(b.end));
}

// One person's calendar: spans (monthly over the cycle, weekly over the week, meeting deadlines)
// and dated chips (meeting tasks on their date, day-N monthly tasks, logged work).
export function calEvents(data, pid, from, to, today) {
	const spans = [];
	const dated = [];
	const seen = new Set();
	const cname = (id) => (data.projects[id] ? data.projects[id].name : 'Other work');
	rowsOf(data, 'monthly_tasks').forEach((t) => {
		const c = data.projects[t.project_id];
		if (!c || !isOn(t, pid)) return;
		// Monthly tasks reach people only while their project is active (SPEC.md 6.8).
		if ((c.state || 'active') !== 'active') return;
		const need = isShared(t) ? shareOf(t, pid) : Math.max(1, t.target || 1);
		const born = bornAt(t, c, today);
		const add = (w, off) => {
			let R = isSplit(t) ? slotRange(t, c, w, off, today) : cycleRange(c, off, today);
			if (!isSplit(t) && t.due_mode === 'dates' && t.due_from_day) {
				const [y, m, d] = parts(R.start);
				R = { ...R, start: ymd(y, m, d + t.due_from_day - 1), end: dueAt(t, c, undefined, off, today) };
			}
			const key = t.id + '|' + R.start;
			if (R.end < from || R.start > to || seen.has(key) || R.end < born) return;
			seen.add(key);
			const rec = recordOf(data.records, t, c, w, off, today);
			const got = isShared(t) ? ((rec && rec.by_person) || {})[pid] || 0 : rec && rec.status !== 'skipped' ? rec.count || 0 : 0;
			const due = dueAt(t, c, w, off, today);
			const status = rec && rec.status === 'skipped' ? 'skipped' : got >= need ? 'done' : R.end < today ? 'missed' : got > 0 ? 'doing' : 'open';
			if (!isSplit(t) && t.due_mode === 'date') {
				if (due >= from && due <= to) {
					dated.push({ date: due, kind: 'monthly', title: t.title, client: cname(t.project_id), project_id: t.project_id, status: status !== 'done' && status !== 'skipped' && due < today ? 'missed' : status, detail: `Due day ${t.due_day}${need > 1 ? ` · ${got}/${need}` : ''}`, tab: 'monthly' });
				}
				return;
			}
			spans.push({ start: R.start, end: R.end, kind: isSplit(t) ? 'weekly' : 'monthly', title: t.title, client: cname(t.project_id), project_id: t.project_id, status, detail: `${isSplit(t) ? slotLabel(t, R, w) : 'This cycle'}${need > 1 ? ` · ${got}/${need}` : ''}${!isSplit(t) && t.due_day ? ` · due ${short(due)}` : ''}`, tab: 'monthly' });
		};
		for (let off = -4; off <= 3; off++) {
			if (isSplit(t)) slotsOf(t, c, off, today).forEach((_, w) => add(w, off));
			else add(undefined, off);
		}
	});
	rowsOf(data, 'meeting_tasks').forEach((i) => {
		if (!data.projects[i.project_id] || !isOn(i, pid)) return;
		const dl = deadlineInfo(i, today);
		const stI = i.status === 'done' ? 'done' : dl && dl.overdue ? 'missed' : i.status === 'doing' ? 'doing' : i.priority === 'urgent' ? 'urgent' : 'open';
		const bar = (a, b, kind, detail) => {
			if (b >= from && a <= to) spans.push({ start: a, end: b, kind, meeting: true, title: i.title, client: cname(i.project_id), project_id: i.project_id, status: i.status === 'done' ? 'done' : b < today ? 'missed' : stI === 'missed' ? 'open' : stI, detail: `Meeting task · ${detail}`, tab: 'board' });
		};
		if (dl && dl.type === 'weekly') return dl.ranges.forEach((r, k) => bar(r.start, r.end, 'weekly', dl.ranges.length > 1 ? `week ${k + 1} of ${dl.ranges.length}` : 'due this week'));
		if (dl && dl.type === 'monthly') return bar(dl.start, dl.end, 'monthly', `due ${short(dl.end)}`);
		if (dl && dl.type === 'dates') return bar(dl.start, dl.end, 'range', `due ${short(dl.start)} – ${short(dl.end)}`);
		if (dl && dl.type === 'biweekly') return bar(dl.start, dl.end, 'weekly', `due ${short(dl.end)} · 2 weeks`);
		if (dl && dl.type === 'date') {
			if (dl.end >= from && dl.end <= to) dated.push({ date: dl.end, kind: 'meeting', title: i.title, client: cname(i.project_id), project_id: i.project_id, status: i.status === 'done' ? 'done' : dl.overdue ? 'missed' : stI, detail: 'Due', tab: 'board' });
			return;
		}
		const d = i.meeting_date || localYmd(i.created_at);
		if (d < from || d > to) return;
		dated.push({ date: d, kind: 'meeting', title: i.title, client: cname(i.project_id), project_id: i.project_id, status: i.status === 'done' ? 'done' : i.status === 'doing' ? 'doing' : i.priority === 'urgent' ? 'urgent' : 'open', detail: i.meeting_date ? 'From meeting' : 'Added', tab: 'board' });
	});
	rowsOf(data, 'activity').forEach((a) => {
		if (a.kind !== 'manual' || a.member_id !== pid || a.date < from || a.date > to) return;
		dated.push({ date: a.date, kind: 'logged', title: a.title, client: cname(a.project_id), status: 'done', detail: a.minutes ? fmtDur(a.minutes) : 'Logged work' });
	});
	const rank = { missed: 0, urgent: 1, doing: 2, open: 3, done: 4, skipped: 5 };
	spans.sort((a, b) => daysBetween(b.start, b.end) - daysBetween(a.start, a.end) || rank[a.status] - rank[b.status] || a.title.localeCompare(b.title));
	dated.sort((a, b) => a.date.localeCompare(b.date) || rank[a.status] - rank[b.status]);
	return { spans, dated };
}

// Everything that happened for one person: their completed and logged work, audit entries
// they made, and tasks assigned to them.
export function personEvents(data, pid, audit) {
	const out = [];
	const cname = (id) => (data.projects[id] ? data.projects[id].name : '');
	rowsOf(data, 'activity').forEach((a) => {
		if (a.member_id !== pid) return;
		out.push({ date: a.date, at: a.at, kind: a.kind === 'manual' ? 'logged' : 'completed', title: a.title, qty: a.qty > 1 ? a.qty : 0, detail: [a.detail, a.minutes ? fmtDur(a.minutes) : ''].filter(Boolean).join(' · '), client: cname(a.project_id) || 'Other work', src: a.kind === 'manual' ? 'Logged work' : a.source === 'board' ? 'Meeting task' : 'Recurring task' });
	});
	(audit || []).forEach((e) => {
		if (e.by_member !== pid || e.kind === 'assign') return;
		const kind = { add: 'added', delete: 'deleted', restore: 'restored', status: 'status', progress: 'progress', done: 'completed', project: 'project' }[e.kind] || 'changed';
		out.push({ date: localYmd(e.at), at: e.at, kind, title: e.title, detail: e.detail || (e.changes || []).map((c) => `${c.label}: ${c.from} → ${c.to}`).join(' · '), client: cname(e.project_id), src: e.type === 'monthly' ? 'Recurring task' : e.type === 'client' ? 'Project' : e.type === 'team' ? 'Team' : 'Meeting task' });
	});
	[...rowsOf(data, 'meeting_tasks').map((x) => ({ ...x, _t: 'items' })), ...rowsOf(data, 'monthly_tasks').map((x) => ({ ...x, _t: 'monthly' }))].forEach((x) => {
		if (!isOn(x, pid) || !x.created_at) return;
		out.push({ date: localYmd(x.created_at), at: x.created_at, kind: 'assigned', title: x.title, detail: x.target > 1 ? `Share: ${shareOf(x, pid) || x.target} of ${x.target}` : '', client: cname(x.project_id), src: x._t === 'monthly' ? (x.freq === 'weekly' ? 'Weekly task' : x.freq === 'biweekly' ? 'Bi-weekly task' : 'Monthly task') : 'Meeting task' });
	});
	const seen = new Set();
	return out
		.filter((x) => {
			const k = x.kind + '|' + x.title + '|' + x.date;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		})
		.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Work by project for a list of activity rows (reference projMix): [[projectId|'', qty]].
export function projectMix(list) {
	const m = new Map();
	list.forEach((x) => {
		const k = x.project_id || '';
		m.set(k, (m.get(k) || 0) + (x.kind === 'manual' ? 1 : x.qty || 1));
	});
	return [...m].sort((a, b) => b[1] - a[1]);
}

export { mondayOf, typePeople };
