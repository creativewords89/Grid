import { describe, expect, it } from 'vitest';
import { bornAt, computeMissed, periodKeyOf, stateOf } from '../lib/monthly.js';

const today = '2026-10-15';
const project = { id: 'p1', cycle_day: 1, cycle_set: 1 };
const projects = { p1: project };

describe('monthly state', () => {
	it('stateOf follows counts and status', () => {
		const t = { target: 3 };
		expect(stateOf(t, null)).toBe('todo');
		expect(stateOf(t, { count: 0, status: 'doing' })).toBe('doing');
		expect(stateOf(t, { count: 2, status: 'doing' })).toBe('doing');
		expect(stateOf(t, { count: 3, status: 'done' })).toBe('done');
		expect(stateOf(t, { count: 3, status: 'skipped' })).toBe('todo');
	});

	it('period keys: cycle key or YYYY-MM-wN', () => {
		expect(periodKeyOf({ freq: 'monthly' }, project, undefined, 0, today)).toBe('2026-10');
		expect(periodKeyOf({ freq: 'weekly' }, project, undefined, 0, today)).toBe('2026-10-w3');
		expect(periodKeyOf({ freq: 'weekly' }, project, 0, -1, today)).toBe('2026-09-w1');
	});

	it('bornAt is the start of the cycle the task was added in', () => {
		expect(bornAt({ freq: 'monthly', created_at: '2026-08-20 10:00:00' }, project, today)).toBe('2026-08-01');
		expect(bornAt({ freq: 'weekly', created_at: '2026-08-20 10:00:00' }, project, today)).toBe('2026-08-01');
	});
});

describe('computeMissed', () => {
	const monthly = { id: 'm1', project_id: 'p1', freq: 'monthly', due_mode: 'monthly', target: 1, created_at: '2026-08-05 09:00:00' };

	it('lists past cycles that ended unfinished, newest last', () => {
		const missed = computeMissed([monthly], projects, {}, today);
		expect(missed.map((m) => [m.off, m.due])).toEqual([
			[-2, '2026-08-31'],
			[-1, '2026-09-30'],
		]);
		expect(missed[1].label).toBe(`Cycle ${new Date(2026, 8, 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}–${new Date(2026, 8, 30).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`);
	});

	it('done and skipped periods are resolved', () => {
		const records = {
			'm1__2026-08': { count: 1, status: 'done' },
			'm1__2026-09': { count: 0, status: 'skipped' },
		};
		expect(computeMissed([monthly], projects, records, today)).toEqual([]);
	});

	it('a due day already passed in the current cycle is missed; no-deadline tasks never are this cycle', () => {
		const dated = { ...monthly, id: 'm2', due_mode: 'date', due_day: 10, created_at: '2026-10-01 09:00:00' };
		const none = { ...monthly, id: 'm3', due_mode: 'none', created_at: '2026-10-01 09:00:00' };
		const missed = computeMissed([dated, none], projects, {}, today);
		expect(missed.map((m) => [m.task.id, m.off, m.due])).toEqual([['m2', 0, '2026-10-10']]);
	});

	it('weekly tasks miss each finished week', () => {
		const weekly = { id: 'w1', project_id: 'p1', freq: 'weekly', due_mode: 'weekly', target: 1, created_at: '2026-10-01 09:00:00' };
		const missed = computeMissed([weekly], projects, { 'w1__2026-10-w1': { count: 1, status: 'done' } }, today);
		expect(missed.map((m) => [m.w, m.due])).toEqual([[1, '2026-10-14']]);
	});
});
