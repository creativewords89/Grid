// Task steps (SPEC.md 6.16, designs DEP-A..C): Write → Edit → Proofread, each with its own person.
// Same rules as GRP_Steps on the server: a step counts only what the step before has finished, the
// task's count is its last step's; forward is the step's person (or a leader), back is leaders only.
import { addDays, cycleRange, daysBetween } from './cycles.js';
import { isManager } from './roles.js';

export const MIN_STEPS = 2;
export const MAX_STEPS = 10;
export const PRESETS = [
	['Write', 'Edit'],
	['Write', 'Edit', 'Proofread'],
	['Design', 'Review'],
];

// Hand-ins (design SH-2B): a step's checklist `handin` [{id, label, kind, required}] — kind file,
// link or image — and what was handed in, `handins` {stepId: {itemId: {files, links, by, at}}}.
// Same rules as GRP_Steps::missing on the server: a step is Completed only with its required items.
export const MAX_HANDIN = 10;
export const HANDIN_KINDS = { file: 'File', link: 'Link', image: 'Image' };
export const newHandinId = () => 'h' + Math.random().toString(36).slice(2, 10);
export const handinOf = (step) => (step && Array.isArray(step.handin) ? step.handin : []);
// What a step can hand in: its checklist, or on a step without one a single optional "Files or
// links" (same as GRP_Steps::handin), so whoever completes a step can hand in their work.
export const DEFAULT_HANDIN = { id: 'work', label: 'Files or links', kind: 'file', required: false };
export const handinItems = (step) => (handinOf(step).length ? handinOf(step) : [DEFAULT_HANDIN]);
export const hasChecklist = (step) => handinOf(step).length > 0;
export const handinGot = (handins, stepId, itemId) => ((handins || {})[stepId] || {})[itemId] || null;
export const handedIn = (handins, stepId, itemId) => {
	const got = handinGot(handins, stepId, itemId);
	return !!got && ((got.files || []).length > 0 || (got.links || []).length > 0);
};
export const missingHandins = (step, handins) => handinItems(step).filter((it) => it.required && !handedIn(handins, step.id, it.id));

// "2 of 3 · 1 required left" for the Hand in window and the step.
export function handinCount(step, handins) {
	const items = handinItems(step);
	const got = items.filter((it) => handedIn(handins, step.id, it.id)).length;
	const left = missingHandins(step, handins).length;
	return { got, total: items.length, left, text: `${got} of ${items.length}${left ? ` · ${left} required left` : ''}` };
}

// A pasted link's name: Figma, Google Doc / Sheet / Slides / Drive, or the site.
export function linkName(url) {
	let host = '';
	let path = '';
	try {
		const u = new URL(url);
		host = u.hostname.replace(/^www\./, '');
		path = u.pathname;
	} catch {
		return '';
	}
	if (/(^|\.)figma\.com$/.test(host)) return 'Figma';
	if (host === 'docs.google.com') return /^\/spreadsheets/.test(path) ? 'Google Sheet' : /^\/presentation/.test(path) ? 'Google Slides' : 'Google Doc';
	if (host === 'drive.google.com') return 'Google Drive';
	return host;
}

// An http(s) link, or '' (same check as the server).
export const cleanLink = (raw) => {
	const url = String(raw || '').trim();
	if (!url) return '';
	const full = /^[a-z][\w+.-]*:/i.test(url) ? url : 'https://' + url;
	try {
		const u = new URL(full);
		return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? full : '';
	} catch {
		return '';
	}
};

// Whether moving a step asks for its hand-ins first: Completed, or the +1 that completes it —
// on every step (one without a checklist gets the optional Files or links).
export const asksHandin = (row, change) => change === 'done' || (change === 1 && row.n + 1 >= row.target);

// Whether a step's hand-ins hold anything at all (a step without a checklist may finish with none).
export const anyHandedIn = (value) => Object.values(value || {}).some((got) => !!got && ((got.files || []).length > 0 || (got.links || []).length > 0));

// The dialog's check of a step's checklist (same as GRP_Steps::clean_handin).
export function checkHandin(items) {
	if ((items || []).length > MAX_HANDIN) return `A step can ask for at most ${MAX_HANDIN} things to hand in.`;
	if ((items || []).some((it) => !String(it.label || '').trim())) return 'Say what to hand in, e.g. Article draft.';
	return '';
}

// The request body's `handins` for one step: {itemId: {files: [id], links: [{url, name}]}}.
export const handinBody = (value) => Object.fromEntries(Object.entries(value || {}).map(([k, v]) => [k, { files: (v.files || []).map((f) => f.id), links: v.links || [] }]));

export const hasSteps = (t) => !!t && Array.isArray(t.steps) && t.steps.length >= MIN_STEPS;

export const stepN = (done, id) => +((done || {})[id] || {}).n || 0;

// A step's status (same as GRP_Steps::state): done (Completed), doing (In progress: started or part
// of its quantity done) or todo (Not started).
export function stepStatus(done, id, target) {
	const n = stepN(done, id);
	if (n >= Math.max(1, +target || 1)) return 'done';
	return n > 0 || ((done || {})[id] || {}).started ? 'doing' : 'todo';
}

// A step's due date: the date on meeting tasks; on monthly tasks its day of the current cycle
// (a day past the end of a short cycle falls on its last day).
export function stepDue(task, step, project, today) {
	if (!step || step.due == null || step.due === '') return null;
	if (typeof step.due === 'string') return step.due;
	if (!project) return null;
	const range = cycleRange(project, 0, today);
	const day = addDays(range.start, +step.due - 1);
	return day > range.end ? range.end : day;
}

// "Due Oct 7" / "Due today" / "Oct 7 · 2 days late" and its tone for the badge.
export function dueBadge(date, today, done) {
	if (!date) return null;
	const left = daysBetween(today, date);
	const day = new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	if (done) return { text: `Due ${day}`, tone: 'ok' };
	if (left < 0) return { text: `${day} · ${-left} day${left === -1 ? '' : 's'} late`, tone: 'late' };
	if (left === 0) return { text: 'Due today', tone: 'soon' };
	return { text: `Due ${day}`, tone: left <= 2 ? 'soon' : 'plain', left };
}

// One row per step: what it finished, the most it may have finished, and its state —
// done (all of it), go (something is ready for it) or wait (nothing ready yet).
export function stepRows(task, done) {
	const target = Math.max(1, +task.target || 1);
	return (task.steps || []).map((s, i) => {
		const n = stepN(done, s.id);
		const ready = i === 0 ? target : Math.min(target, stepN(done, task.steps[i - 1].id));
		const state = n >= target ? 'done' : ready > n ? 'go' : 'wait';
		return { ...s, i, n, ready, waiting: ready - n, target, state, status: stepStatus(done, s.id, target), prev: i > 0 ? task.steps[i - 1] : null, next: task.steps[i + 1] || null };
	});
}

// The task's count: what its last step finished.
export const stepCount = (task, done) => {
	const last = (task.steps || [])[task.steps.length - 1];
	return last ? stepN(done, last.id) : 0;
};

// Same as GRP_Permissions::TICK_STEP plus the order rule.
export function canTickStep(me, row, delta, status) {
	if (!me || status === 'done') return false;
	if (delta < 0) return isManager(me) && row.n > 0;
	return (isManager(me) || row.member === me.id) && row.n < row.ready;
}

// Who may hand in on a step (same as GRP_Permissions::HAND_IN_STEP): its person or a leader,
// never on completed work.
export const canHandIn = (me, row, status) => !!me && status !== 'done' && (isManager(me) || row.member === me.id);

// The step the task is on: the first one not completed (null when all are).
export const currentStep = (task, done) => stepRows(task, done).find((r) => r.status !== 'done') || null;

// Who may move a step to a status (same rules as the server): forward is the step's person or a
// leader — In progress once something is ready, Completed once the step before is completed in full;
// back is leaders only, never below what the next step already used.
export function canSetStep(me, row, to, status, done) {
	if (!me || status === 'done' || to === row.status) return false;
	const order = { todo: 0, doing: 1, done: 2 };
	if (order[to] < order[row.status]) {
		const keep = to === 'doing' ? Math.min(row.n, row.target - 1) : 0;
		return isManager(me) && (!row.next || stepN(done, row.next.id) <= keep);
	}
	if (!isManager(me) && row.member !== me.id) return false;
	if (to === 'done') return row.ready >= row.target;
	return row.status !== 'todo' || row.ready > 0;
}

// This person's step that comes next (their first one not finished), or null when their part is done.
export function myStep(task, done, meId) {
	return stepRows(task, done).find((r) => r.member === meId && r.state !== 'done') || null;
}

const first = (members, id) => (members[id] ? members[id].name.split(' ')[0] : 'someone');

// The line on My day: "Your step 2 of 3 · 1 ready from Max · 2 of 4 edited", or "Waiting for Write (Max)".
export function stepLine(task, done, meId, members) {
	const r = myStep(task, done, meId);
	if (!r) return '';
	const of = `${r.i + 1} of ${task.steps.length}`;
	if (r.state === 'wait') return `Waiting for ${r.prev.name} (${first(members, r.prev.member)}) · you’re next`;
	const qty = r.target > 1 ? ` · ${r.n} of ${r.target} done` : '';
	const from = r.prev ? ` · ${r.waiting} ready from ${first(members, r.prev.member)}` : '';
	return `Your step ${of}${from}${qty}`;
}

const time = (iso) => (iso ? Date.parse(String(iso).replace(' ', 'T') + (String(iso).length === 19 ? 'Z' : '')) : 0);

// "Ready for you" (Notifications and the bell, 30 days): the step before yours finished something
// you haven't picked up yet. One item per unit handed over (the key carries the count).
export function readyItems(task, done, me, members, now = Date.now()) {
	if (!hasSteps(task) || !me) return [];
	return stepRows(task, done)
		.filter((r) => r.prev && r.member === me.id && r.state === 'go')
		.map((r) => {
			const before = (done || {})[r.prev.id] || {};
			const by = before.by && before.by !== me.id ? before.by : r.prev.member;
			if (r.prev.member === me.id || !before.at || now - time(before.at) > 30 * 86400000) return null;
			const qty = r.target > 1 ? ` · ${r.waiting} ready (${stepN(done, r.prev.id)} of ${r.target})` : '';
			return {
				key: `ready:${task.id}:${r.id}:${stepN(done, r.prev.id)}`,
				title: `Ready for you: ${r.name} “${task.title}”`,
				sub: `${members[by] ? members[by].name : 'Someone'} finished ${r.prev.name}${qty}`,
				at: before.at,
			};
		})
		.filter(Boolean);
}

// Steps from the dialog's rows, as the server takes them: names trimmed, empty rows dropped; a
// hand-in checklist keeps its named items.
export const cleanSteps = (rows) =>
	rows
		.filter((r) => r.name.trim() || r.member)
		.map((r) => {
			const handin = handinOf(r)
				.filter((it) => String(it.label || '').trim())
				.map((it) => ({ id: it.id, label: it.label.trim(), kind: HANDIN_KINDS[it.kind] ? it.kind : 'file', required: !!it.required }));
			return { id: r.id, name: r.name.trim(), member: r.member, due: r.due === '' || r.due == null ? null : typeof r.due === 'string' && !/^\d{4}-/.test(r.due) ? +r.due : r.due, ...(handin.length ? { handin } : {}) };
		});

// What's wrong with the dialog's steps, or ''.
export function stepsError(rows) {
	const list = cleanSteps(rows);
	if (list.length < MIN_STEPS) return `Add at least ${MIN_STEPS} steps, or switch to One step.`;
	if (list.length > MAX_STEPS) return `Up to ${MAX_STEPS} steps.`;
	const bad = list.find((s) => !s.name);
	if (bad) return 'Name every step, e.g. Write, Edit, Proofread.';
	const nobody = list.find((s) => !s.member);
	if (nobody) return `Pick who does “${nobody.name}”.`;
	const many = list.find((s) => checkHandin(s.handin));
	if (many) return `“${many.name}”: ${checkHandin(many.handin)}`;
	let last = null;
	for (const s of list) {
		if (s.due == null) continue;
		if (typeof s.due === 'number' && (s.due < 1 || s.due > 31)) return `“${s.name}”: pick a day of the cycle, 1 to 31.`;
		if (last && s.due < last.due) return `“${s.name}” is due before “${last.name}” — each step’s date must be on or after the one before.`;
		last = s;
	}
	return '';
}

export const newStepId = () => 's' + Math.random().toString(36).slice(2, 9);
