import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeWeek, cycleAt, cycleRange, dueAt, monthRange, periodsOf, weekRange } from '../lib/cycles.js';

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
	it('months and weeks match the reference', () => {
		Object.entries(c.months).forEach(([off, m]) => {
			expect(monthRange(+off, now)).toEqual(m);
			expect(activeWeek(+off, now)).toBe(c.activeWeek[off]);
			c.weeks[off].forEach((w, i) => expect(weekRange(i, +off, now)).toEqual(w));
		});
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
					if (typeof due === 'object') {
						expect(dueAt(task, project, undefined, +off, now)).toBe(due.active);
						due.weeks.forEach((wd, w) => expect(dueAt(task, project, w, +off, now)).toBe(wd));
					} else expect(dueAt(task, project, undefined, +off, now)).toBe(due);
				});
			});
		});
	});
});
