import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeSlot, activeWeek, cycleAt, cycleRange, dueAt, halvesIn, monthRange, periodsOf, slotLabel, slotsOf, weekRange, weeksIn, weeksOf } from '../lib/cycles.js';

// Same fixtures as the PHP port (tests/fixtures/cycles.json, generated from the reference).
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, '../../../tests/fixtures/cycles.json'), 'utf8'));

const compact = (p) => {
	const o = { key: p.key, start: p.start, end: p.end, day: p.day };
	['cut', 'merged', 'transition'].forEach((f) => p[f] && (o[f] = true));
	if (p.monthly) o.monthly = p.monthly;
	if (p.change) o.change_from = p.change.from;
	return o;
};

describe.each(fixture.cases.map((c) => [c.now, c]))('cycles at %s', (now, c) => {
	// The reference's calendar-month weeks are not used any more (weeks follow the cycle).
	it('months match the reference', () => {
		Object.entries(c.months).forEach(([off, m]) => expect(monthRange(+off, now)).toEqual(m));
	});

	it('project cycles and due dates match the reference', () => {
		Object.entries(c.projects).forEach(([name, exp]) => {
			const project = fixture.projects[name];
			if (exp.periods) expect(periodsOf(project, now).map(compact)).toEqual(exp.periods);
			Object.entries(exp.ranges).forEach(([off, r]) => expect(compact(cycleRange(project, +off, now))).toEqual(r));
			Object.entries(exp.at).forEach(([d, r]) => expect(compact(cycleAt(project, d, now))).toEqual(r));
			Object.entries(exp.due).forEach(([tn, byOff]) => {
				const task = fixture.tasks[tn];
				Object.entries(byOff).forEach(([off, due]) => {
					// Weekly (object) fixtures used calendar weeks; see the cycle-week tests below.
					if (typeof due !== 'object') expect(dueAt(task, project, undefined, +off, now)).toBe(due);
				});
			});
		});
	});
});

const spans = (weeks) => weeks.map((w) => `${w.start}..${w.end}`);

describe('cycle weeks (SPEC.md 6.2)', () => {
	const mid = { cycle_day: 15 };

	it('count from the cycle start; the last week takes the leftover days', () => {
		expect(spans(weeksOf(mid, 0, '2026-10-20'))).toEqual(['2026-10-15..2026-10-21', '2026-10-22..2026-10-28', '2026-10-29..2026-11-04', '2026-11-05..2026-11-14']);
		expect(activeWeek(mid, 0, '2026-11-04')).toBe(2);
		expect(activeWeek(mid, -1, '2026-10-20')).toBe(3);
		expect(activeWeek(mid, 1, '2026-10-20')).toBe(0);
		expect(dueAt({ freq: 'weekly' }, mid, undefined, 0, '2026-10-25')).toBe('2026-10-28');
		expect(weekRange(mid, 9, 0, '2026-10-25')).toEqual({ start: '2026-11-05', end: '2026-11-14' });
	});

	it('day-1 projects keep calendar weeks', () => {
		expect(spans(weeksOf({ cycle_day: 1 }, 0, '2026-10-10'))).toEqual(['2026-10-01..2026-10-07', '2026-10-08..2026-10-14', '2026-10-15..2026-10-21', '2026-10-22..2026-10-31']);
	});

	it('short and long periods', () => {
		expect(spans(weeksIn({ start: '2026-10-01', end: '2026-10-14' }))).toEqual(['2026-10-01..2026-10-07', '2026-10-08..2026-10-14']);
		expect(spans(weeksIn({ start: '2026-10-01', end: '2026-10-10' }))).toEqual(['2026-10-01..2026-10-10']);
		expect(weeksIn({ start: '2026-10-01', end: '2026-11-14' })).toHaveLength(6);
	});

	it('transition periods have their own weeks', () => {
		const p = { cycle_day: 15, cycle_changes: [{ from: '2026-10-01', day: 15, prevDay: 1, mode: 'due' }] };
		expect(spans(weeksOf(p, 0, '2026-10-05'))).toEqual(['2026-10-01..2026-10-07', '2026-10-08..2026-10-14']);
	});

	it('matches the PHP port', () => {
		// Same expectations as tests/test-cycles.php test_period_keys_and_record_ids.
		expect(activeWeek(mid, 0, '2026-10-01')).toBe(2);
		expect(cycleRange(mid, 0, '2026-10-01').key).toBe('2026-09');
	});
});

describe('two-week periods (bi-weekly tasks)', () => {
	const mid = { cycle_day: 15 };
	const bi = { freq: 'biweekly' };

	it('pair the cycle weeks; the last takes a leftover week', () => {
		expect(spans(halvesIn({ start: '2026-10-15', end: '2026-11-14' }))).toEqual(['2026-10-15..2026-10-28', '2026-10-29..2026-11-14']);
		const five = halvesIn({ start: '2026-10-01', end: '2026-11-04' });
		expect(five.map((h) => [h.fromWeek, h.toWeek])).toEqual([
			[1, 2],
			[3, 5],
		]);
		expect(halvesIn({ start: '2026-10-01', end: '2026-10-14' })).toHaveLength(1);
	});

	it('due dates, active period and labels', () => {
		expect(dueAt(bi, mid, undefined, 0, '2026-10-20')).toBe('2026-10-28');
		expect(dueAt(bi, mid, 1, 0, '2026-10-20')).toBe('2026-11-14');
		expect(activeSlot(bi, mid, 0, '2026-11-02')).toBe(1);
		const slots = slotsOf(bi, mid, 0, '2026-10-20');
		expect(slotLabel(bi, slots[1], 1)).toBe('Weeks 3–4');
		expect(slotLabel(bi, slots[0], 0, true)).toBe('W1–2');
		expect(slotLabel({ freq: 'weekly' }, slots[0], 0)).toBe('Week 1');
	});
});
