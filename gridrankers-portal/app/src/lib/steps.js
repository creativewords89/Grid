// Task steps (SPEC.md 6.16, designs DEP-A..C): Write → Edit → Proofread, each with its own person.
// Same rules as GRP_Steps on the server: a step counts only what the step before has finished, the
// task's count is its last step's; forward is the step's person (or a leader), back is leaders only.
import { isManager } from './roles.js';

export const MIN_STEPS = 2;
export const MAX_STEPS = 4;
export const PRESETS = [
	['Write', 'Edit'],
	['Write', 'Edit', 'Proofread'],
	['Design', 'Review'],
];

export const hasSteps = (t) => !!t && Array.isArray(t.steps) && t.steps.length >= MIN_STEPS;

export const stepN = (done, id) => +((done || {})[id] || {}).n || 0;

// One row per step: what it finished, the most it may have finished, and its state —
// done (all of it), go (something is ready for it) or wait (nothing ready yet).
export function stepRows(task, done) {
	const target = Math.max(1, +task.target || 1);
	return (task.steps || []).map((s, i) => {
		const n = stepN(done, s.id);
		const ready = i === 0 ? target : Math.min(target, stepN(done, task.steps[i - 1].id));
		const state = n >= target ? 'done' : ready > n ? 'go' : 'wait';
		return { ...s, i, n, ready, waiting: ready - n, target, state, prev: i > 0 ? task.steps[i - 1] : null, next: task.steps[i + 1] || null };
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

// Steps from the dialog's rows, as the server takes them: names trimmed, empty rows dropped.
export const cleanSteps = (rows) => rows.filter((r) => r.name.trim() || r.member).map((r) => ({ id: r.id, name: r.name.trim(), member: r.member }));

// What's wrong with the dialog's steps, or ''.
export function stepsError(rows) {
	const list = cleanSteps(rows);
	if (list.length < MIN_STEPS) return `Add at least ${MIN_STEPS} steps, or switch to One step.`;
	if (list.length > MAX_STEPS) return `Up to ${MAX_STEPS} steps.`;
	const bad = list.find((s) => !s.name);
	if (bad) return 'Name every step, e.g. Write, Edit, Proofread.';
	const nobody = list.find((s) => !s.member);
	if (nobody) return `Pick who does “${nobody.name}”.`;
	return '';
}

export const newStepId = () => 's' + Math.random().toString(36).slice(2, 9);
