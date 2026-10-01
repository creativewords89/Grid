import { describe, expect, it } from 'vitest';
import { assignedFor, missedWork, perfRange, perfShift, perfStats } from '../lib/perf.js';
import { emptyData } from '../lib/store.js';

describe('perf helpers', () => {
	it('ranges follow calendar weeks and months', () => {
		expect(perfRange('week', '2026-10-15')).toMatchObject({ start: '2026-10-15', end: '2026-10-21', w: 2 });
		expect(perfRange('week', '2026-10-30')).toMatchObject({ start: '2026-10-22', end: '2026-10-31' });
		expect(perfRange('month', '2026-02-10')).toMatchObject({ start: '2026-02-01', end: '2026-02-28' });
		expect(perfShift('week', '2026-10-03', -1)).toBe('2026-09-22');
		expect(perfShift('week', '2026-10-25', 1)).toBe('2026-11-01');
		expect(perfShift('day', '2026-10-31', 1)).toBe('2026-11-01');
	});

	it('stats count units and logged work', () => {
		expect(perfStats([{ kind: 'auto', qty: 3, date: 'a' }, { kind: 'manual', minutes: 30, date: 'b' }])).toEqual({ done: 3, manual: 1, minutes: 30, days: 2, total: 4 });
	});

	it('assigned and missed work for a member', () => {
		const d = emptyData();
		d.projects = { p1: { id: 'p1', name: 'Acme', cycle_day: 1, cycle_set: 1 } };
		d.meeting_tasks = {
			t1: { id: 't1', project_id: 'p1', title: 'Fix H1', status: 'todo', priority: 'urgent', target: 1, assignees: [{ id: 'm1', n: 1 }], deadline: { type: 'none' } },
			t2: { id: 't2', project_id: 'p1', title: 'Done one', status: 'done', target: 1, assignees: [{ id: 'm1', n: 1 }] },
		};
		d.monthly_tasks = { m: { id: 'm', project_id: 'p1', title: 'GBP Posts', freq: 'monthly', due_mode: 'monthly', target: 2, team: 1, assignees: [{ id: 'm1', n: 2 }], created_at: '2026-08-02 10:00:00' } };
		d.records = { 'm__2026-09': { count: 1, status: 'doing' } };

		const open = assignedFor(d, 'm1', '2026-10-15');
		expect(open.map((x) => x.title)).toEqual(['Fix H1', 'GBP Posts']);
		expect(open[1].sub).toBe('This cycle · 0/2 done');

		const missed = missedWork(d, 'm1', perfRange('month', '2026-09-10'), '2026-10-15');
		expect(missed).toEqual([{ title: 'GBP Posts', project_id: 'p1', label: expect.stringContaining('Cycle'), got: 1, need: 2, end: '2026-09-30' }]);
	});
});
