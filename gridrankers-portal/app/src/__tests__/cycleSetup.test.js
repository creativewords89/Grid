import { describe, expect, it } from 'vitest';
import { cycleSetup, lastCycleCount } from '../lib/cycleSetup.js';
import { strips } from '../lib/day.js';
import { emptyData } from '../lib/store.js';

const MAX = { id: 'max', name: 'Max Member', role: 'member', active: 1 };
const LEAD = { id: 'lee', name: 'Lee Lead', role: 'lead', active: 1 };

// Acme: cycle starts on day 1 (Oct 1 – 31; last cycle Sep 1 – 30); the rule began Oct 1.
function fixture() {
	const d = emptyData();
	d.settings = { s: { id: 's', setting_key: 'cycle_setup_since', value: { date: '2026-10-01' } } };
	d.members = { max: MAX, lee: LEAD };
	d.projects = { p1: { id: 'p1', name: 'Acme', state: 'active', cycle_day: 1, cycle_set: 1, created_at: '2026-08-01 09:00:00', cycle_reviews: null } };
	d.monthly_tasks = {
		t1: { id: 't1', project_id: 'p1', title: 'Blogs', freq: 'monthly', due_mode: 'monthly', target: 4, assignees: [{ id: 'max', n: 4 }], created_at: '2026-08-02 10:00:00' },
		t2: { id: 't2', project_id: 'p1', title: 'Pages', freq: 'monthly', due_mode: 'monthly', target: 2, assignees: [], created_at: '2026-08-02 10:00:00' },
		t3: { id: 't3', project_id: 'p1', title: 'New this cycle', freq: 'monthly', due_mode: 'monthly', target: 1, assignees: [], created_at: '2026-10-01 08:00:00' },
	};
	d.records = { 't1__2026-09': { count: 3, status: 'doing' } };
	return d;
}

describe('new cycle setup', () => {
	it('lists what is left to assign and review, due on day 3', () => {
		const [c] = cycleSetup(fixture(), '2026-10-02');
		expect(c).toMatchObject({ due: '2026-10-03', assigned: 1, reviewed: 0, done: false, late: 0 });
		expect(c.tasks).toHaveLength(3);
		expect(c.last.map((t) => t.id)).toEqual(['t1', 't2']);
		expect(c.prev.key).toBe('2026-09');
		expect(lastCycleCount(fixture(), fixture().monthly_tasks.t1, fixture().projects.p1, '2026-10-02')).toEqual({ got: 3, need: 4 });
	});

	it('is overdue after day 3, and done once everything is assigned and reviewed', () => {
		const d = fixture();
		expect(cycleSetup(d, '2026-10-05')[0].late).toBe(2);

		Object.values(d.monthly_tasks).forEach((t) => (t.assignees = [{ id: 'max', n: 1 }]));
		d.projects.p1.cycle_reviews = { '2026-09': { t1: { ok: true }, t2: { ok: false, note: 'More pages' } } };
		expect(cycleSetup(d, '2026-10-03')[0]).toMatchObject({ done: true, assigned: 3, reviewed: 2 });
		// Done: gone after day 3.
		expect(cycleSetup(d, '2026-10-04')).toEqual([]);
	});

	it('leaves out cycles before the rule began, paused projects and nothing to review for new projects', () => {
		const before = fixture();
		before.settings.s.value = { date: '2026-10-02' };
		expect(cycleSetup(before, '2026-10-02')).toEqual([]);

		const paused = fixture();
		paused.projects.p1.state = 'paused';
		expect(cycleSetup(paused, '2026-10-02')).toEqual([]);

		const fresh = fixture();
		fresh.projects.p1.created_at = '2026-10-01 07:00:00';
		const [c] = cycleSetup(fresh, '2026-10-02');
		expect(c.prev).toBeNull();
		expect(c.last).toEqual([]);

		const none = fixture();
		none.settings = {};
		expect(cycleSetup(none, '2026-10-02')).toEqual([]);
	});

	it('reminds leaders in the message band, never members', () => {
		const d = fixture();
		const amber = strips(d, LEAD, '2026-10-02').find((s) => s.kind === 'cycle');
		expect(amber).toMatchObject({ tone: 'amber', title: 'New cycle for Acme.', ok: 'Open setup', sticky: true });
		const red = strips(d, LEAD, '2026-10-05').find((s) => s.kind === 'cycle');
		expect(red).toMatchObject({ tone: 'red', title: 'Acme: new cycle setup is 2 days overdue.' });
		expect(strips(d, MAX, '2026-10-05').some((s) => s.kind === 'cycle')).toBe(false);
	});
});
