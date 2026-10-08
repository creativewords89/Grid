// Task steps (SPEC.md 6.16, designs DEP-A..C).
import { describe, expect, it } from 'vitest';
import { feedOf } from '../lib/feed.js';
import { assignedFor } from '../lib/perf.js';
import { canSetStep, canTickStep, cleanSteps, currentStep, dueBadge, hasSteps, myStep, readyItems, stepCount, stepDue, stepLine, stepRows, stepStatus, stepsError } from '../lib/steps.js';
import { emptyData } from '../lib/store.js';

const TODAY = '2026-10-10';
const NOW = Date.parse('2026-10-10T12:00:00Z');
const MAX = { id: 'max', name: 'Max Member', role: 'member', active: 1 };
const NIA = { id: 'nia', name: 'Nia Member', role: 'member', active: 1 };
const LEE = { id: 'lee', name: 'Lee Lead', role: 'lead', active: 1 };
const STEPS = [
	{ id: 'w', name: 'Write', member: 'max' },
	{ id: 'e', name: 'Edit', member: 'nia' },
	{ id: 'p', name: 'Proofread', member: 'lee' },
];
const at = (n, by, iso = '2026-10-10T09:00:00Z') => ({ n, by, at: iso });
const task = (extra = {}) => ({ id: 't1', project_id: 'a', title: 'Blog posts', target: 4, status: 'doing', priority: 'normal', steps: STEPS, assignees: [{ id: 'max' }, { id: 'nia' }, { id: 'lee' }], team: 1, created_at: '2026-10-01 09:00:00', ...extra });

describe('rows and turns', () => {
	it('counts each step up to what the step before finished', () => {
		const done = { w: at(3, 'max'), e: at(2, 'nia'), p: at(1, 'lee') };
		const rows = stepRows(task(), done);
		expect(rows.map((r) => [r.name, r.n, r.ready, r.waiting, r.state])).toEqual([
			['Write', 3, 4, 1, 'go'],
			['Edit', 2, 3, 1, 'go'],
			['Proofread', 1, 2, 1, 'go'],
		]);
		expect(stepCount(task(), done)).toBe(1);
		expect(hasSteps(task())).toBe(true);
		expect(hasSteps(task({ steps: [STEPS[0]] }))).toBe(false);
		expect(hasSteps({ steps: null })).toBe(false);
	});

	it('waits until something is ready, and is done at the quantity', () => {
		const rows = stepRows(task({ target: 1 }), { w: at(1, 'max') });
		expect(rows.map((r) => r.state)).toEqual(['done', 'go', 'wait']);
		expect(myStep(task({ target: 1 }), { w: at(1, 'max') }, 'max')).toBe(null);
		expect(myStep(task({ target: 1 }), { w: at(1, 'max') }, 'lee').state).toBe('wait');
	});

	it('lets the step’s person go forward and leaders go back', () => {
		const [w, e] = stepRows(task(), { w: at(1, 'max') });
		expect(canTickStep(MAX, w, 1, 'doing')).toBe(true);
		expect(canTickStep(NIA, w, 1, 'doing')).toBe(false);
		expect(canTickStep(NIA, e, 1, 'doing')).toBe(true);
		expect(canTickStep(MAX, w, -1, 'doing')).toBe(false);
		expect(canTickStep(LEE, w, -1, 'doing')).toBe(true);
		expect(canTickStep(LEE, w, 1, 'done')).toBe(false);
		const [, edit] = stepRows(task(), {});
		expect(canTickStep(NIA, edit, 1, 'todo')).toBe(false);
	});

	it('says whose turn it is', () => {
		const members = { max: MAX, nia: NIA, lee: LEE };
		const done = { w: at(3, 'max'), e: at(2, 'nia') };
		expect(stepLine(task(), done, 'nia', members)).toBe('Your step 2 of 3 · 1 ready from Max · 2 of 4 done');
		expect(stepLine(task(), {}, 'lee', members)).toBe('Waiting for Edit (Nia) · you’re next');
		expect(stepLine(task({ target: 1 }), {}, 'max', members)).toBe('Your step 1 of 3');
	});
});

describe('the dialog', () => {
	it('checks the steps before saving', () => {
		const rows = [
			{ id: 'a', name: ' Write ', member: 'max' },
			{ id: 'b', name: '', member: '' },
		];
		expect(cleanSteps(rows)).toEqual([{ id: 'a', name: 'Write', member: 'max', due: null }]);
		expect(cleanSteps([{ id: 'a', name: 'Write', member: 'max', due: '7' }])[0].due).toBe(7);
		expect(stepsError([{ id: 'a', name: 'Write', member: 'max', due: '2026-10-07' }, { id: 'b', name: 'Edit', member: 'nia', due: '2026-10-03' }])).toBe('“Edit” is due before “Write” — each step’s date must be on or after the one before.');
		expect(stepsError([{ id: 'a', name: 'Write', member: 'max', due: 3 }, { id: 'b', name: 'Edit', member: 'nia', due: 40 }])).toBe('“Edit”: pick a day of the cycle, 1 to 31.');
		expect(stepsError(rows)).toBe('Add at least 2 steps, or switch to One step.');
		expect(stepsError([...rows.slice(0, 1), { id: 'b', name: 'Edit', member: '' }])).toBe('Pick who does “Edit”.');
		expect(stepsError([...rows.slice(0, 1), { id: 'b', name: '', member: 'nia' }])).toBe('Name every step, e.g. Write, Edit, Proofread.');
		expect(stepsError([...rows.slice(0, 1), { id: 'b', name: 'Edit', member: 'nia' }])).toBe('');
	});
});

describe('My day and notifications', () => {
	const data = () => {
		const d = emptyData();
		d.members = { max: MAX, nia: NIA, lee: LEE };
		d.projects = { a: { id: 'a', name: 'Acme', state: 'active', cycle_day: 1, cycle_set: 1 } };
		d.meeting_tasks = { t1: task({ step_done: { w: at(3, 'max'), e: at(2, 'nia') } }) };
		return d;
	};

	it('lists each person’s own step, until their part is done', () => {
		const d = data();
		const nia = assignedFor(d, 'nia', TODAY).find((x) => x.id === 't1');
		expect(nia).toMatchObject({ step: 'Edit', turn: 'go', group: 'doing' });
		const lee = assignedFor(d, 'lee', TODAY).find((x) => x.id === 't1');
		expect(lee).toMatchObject({ step: 'Proofread', turn: 'go' });
		d.meeting_tasks.t1.step_done = { w: at(4, 'max') };
		expect(assignedFor(d, 'max', TODAY).some((x) => x.id === 't1')).toBe(false);
		expect(assignedFor(d, 'lee', TODAY).find((x) => x.id === 't1')).toMatchObject({ turn: 'wait', group: 'todo' });
	});

	it('tells the next person when work is ready for them', () => {
		const d = data();
		const items = readyItems(d.meeting_tasks.t1, d.meeting_tasks.t1.step_done, NIA, d.members, NOW);
		expect(items).toEqual([{ key: 'ready:t1:e:3', title: 'Ready for you: Edit “Blog posts”', sub: 'Max Member finished Write · 1 ready (3 of 4)', at: '2026-10-10T09:00:00Z' }]);
		// Lee's step: Nia edited 2, Lee proofread none → ready.
		expect(readyItems(d.meeting_tasks.t1, d.meeting_tasks.t1.step_done, LEE, d.members, NOW).map((x) => x.key)).toEqual(['ready:t1:p:2']);
		// Nothing for the first step, nor once it's picked up, nor after 30 days.
		expect(readyItems(d.meeting_tasks.t1, d.meeting_tasks.t1.step_done, MAX, d.members, NOW)).toEqual([]);
		expect(readyItems(d.meeting_tasks.t1, { w: at(2, 'max'), e: at(2, 'nia') }, NIA, d.members, NOW)).toEqual([]);
		expect(readyItems(d.meeting_tasks.t1, d.meeting_tasks.t1.step_done, NIA, d.members, NOW + 31 * 86400000)).toEqual([]);
		// In the Notifications feed, opening the task.
		const feed = feedOf(d, NIA, TODAY, NOW).find((x) => x.key === 'ready:t1:e:3');
		expect(feed).toMatchObject({ cat: 'task', icon: '→', open: { project_id: 'a', tab: 'board', title: 'Blog posts' } });
	});
});

describe('status and deadline of each step', () => {
	it('is Not started, In progress or Completed, and moves by the server’s rules', () => {
		const one = task({ target: 1 });
		expect(stepStatus({}, 'w', 1)).toBe('todo');
		expect(stepStatus({ w: { n: 0, started: true } }, 'w', 1)).toBe('doing');
		expect(stepStatus({ w: at(1, 'max') }, 'w', 1)).toBe('done');
		const [w, e, p] = stepRows(one, {});
		expect(canSetStep(MAX, w, 'doing', 'todo', {})).toBe(true);
		expect(canSetStep(MAX, w, 'done', 'todo', {})).toBe(true);
		expect(canSetStep(NIA, w, 'doing', 'todo', {})).toBe(false);
		expect(canSetStep(NIA, e, 'doing', 'todo', {})).toBe(false);
		const doneW = { w: at(1, 'max') };
		const rows = stepRows(one, doneW);
		expect(canSetStep(NIA, rows[1], 'done', 'doing', doneW)).toBe(true);
		expect(canSetStep(MAX, rows[0], 'todo', 'doing', doneW)).toBe(false);
		expect(canSetStep(LEE, rows[0], 'todo', 'doing', doneW)).toBe(true);
		expect(canSetStep(LEE, stepRows(one, { w: at(1, 'max'), e: at(1, 'nia') })[0], 'todo', 'doing', { w: at(1, 'max'), e: at(1, 'nia') })).toBe(false);
		expect(canSetStep(LEE, p, 'done', 'done', {})).toBe(false);
		expect(currentStep(one, doneW).name).toBe('Edit');
		expect(currentStep(one, { w: at(1, 'max'), e: at(1, 'nia'), p: at(1, 'lee') })).toBe(null);
	});

	it('has its own due date (a day of the cycle on monthly tasks)', () => {
		const project = { id: 'a', cycle_day: 1, cycle_set: 1 };
		expect(stepDue(task(), { due: '2026-10-07' }, project, TODAY)).toBe('2026-10-07');
		expect(stepDue(task(), { due: 7 }, project, TODAY)).toBe('2026-10-07');
		expect(stepDue(task(), { due: 31 }, { ...project, cycle_day: 15 }, '2026-02-20')).toBe('2026-03-14');
		expect(stepDue(task(), { due: null }, project, TODAY)).toBe(null);
		expect(dueBadge('2026-10-07', TODAY)).toEqual({ text: 'Oct 7 · 3 days late', tone: 'late' });
		expect(dueBadge('2026-10-11', TODAY)).toMatchObject({ text: 'Due Oct 11', tone: 'soon', left: 1 });
		expect(dueBadge('2026-10-20', TODAY)).toMatchObject({ tone: 'plain' });
		expect(dueBadge('2026-10-10', TODAY)).toEqual({ text: 'Due today', tone: 'soon' });
		expect(dueBadge('2026-10-03', TODAY, true)).toEqual({ text: 'Due Oct 3', tone: 'ok' });
	});

	it('puts each person’s step date on My day', () => {
		const d = emptyData();
		d.members = { max: MAX, nia: NIA, lee: LEE };
		d.projects = { a: { id: 'a', name: 'Acme', state: 'active', cycle_day: 1, cycle_set: 1 } };
		d.meeting_tasks = { t1: task({ target: 1, steps: [{ ...STEPS[0], due: '2026-10-03' }, { ...STEPS[1], due: '2026-10-12' }, { ...STEPS[2], due: '2026-10-15' }], step_done: { w: at(1, 'max') } }) };
		expect(assignedFor(d, 'nia', TODAY).find((x) => x.id === 't1')).toMatchObject({ due: '2026-10-12', when: 'Due Oct 12' });
		expect(assignedFor(d, 'lee', TODAY).find((x) => x.id === 't1')).toMatchObject({ due: '2026-10-15', turn: 'wait' });
	});
});
