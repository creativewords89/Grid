import { describe, expect, it } from 'vitest';
import { dayChips, festivalCounts, holidaysAhead, holidaysOf, monthCells, monthCounts, runsOf, takenThisMonth, workingDays } from '../lib/holidays.js';
import { allowance, balance, festivalDays, firstYearSince, hasLeave, settlement } from '../lib/people.js';

// Fridays are the team's weekly day off; Durga Puja is Tue 20 – Wed 21 Oct 2026.
const TEAM = [5];
const PUJA = { id: 'p', kind: 'seasonal', name: 'Durga Puja', from_date: '2026-10-20', to_date: '2026-10-21' };
const leave = (id, member_id, from_date, to_date, status = 'approved', type = 'day') => ({ id, member_id, from_date, to_date, status, type });

describe('Yearly leave (SPEC.md 6.10)', () => {
	it('gives Full-Time and Part-Time employees 10 casual and 14 sick days, Interns and Contractual none', () => {
		expect(allowance({ employment: 'full_time' }, 'day')).toBe(10);
		expect(allowance({ employment: 'part_time' }, 'sick')).toBe(14);
		expect(allowance({}, 'day')).toBe(10);
		expect(hasLeave({ employment: 'intern' })).toBe(false);
		expect(allowance({ employment: 'contractual' }, 'sick')).toBe(0);
	});

	it('counts the calendar year only, without days off', () => {
		const me = { id: 'm', weekly_off: null };
		const leaves = [leave('a', 'm', '2026-12-28', '2027-01-04'), leave('b', 'm', '2026-10-19', '2026-10-21', 'approved', 'sick'), leave('c', 'm', '2026-11-02', '2026-11-02', 'pending')];
		const b = balance(me, 2026, leaves, TEAM, [PUJA]);
		expect(b.day).toEqual({ allowance: 10, taken: 4, left: 6, over: 0 });
		// Mon 19 Oct only: the Puja is a day off.
		expect(b.sick.taken).toBe(1);
		// Fri 1 Jan 2027 is off: Sat 2 – Mon 4.
		expect(balance(me, 2027, leaves, TEAM, []).day.taken).toBe(3);
	});

	it('deducts the days past the allowance in the month they fall and pays the unused days in December', () => {
		const me = { id: 'm', weekly_off: [] };
		const leaves = [leave('a', 'm', '2026-01-01', '2026-01-08'), leave('b', 'm', '2026-02-27', '2026-03-03'), leave('s', 'm', '2026-12-01', '2026-12-01', 'approved', 'sick')];
		expect(settlement(me, '2026-02', leaves, TEAM, [])).toEqual({ taken: 2, result: 'even', paid: 0, deducted: 0 });
		expect(settlement(me, '2026-03', leaves, TEAM, [])).toEqual({ taken: 3, result: 'deducted', paid: 0, deducted: 3 });
		// No casual days left; 13 sick days paid out.
		expect(settlement(me, '2026-12', leaves, TEAM, [])).toEqual({ taken: 1, result: 'paid', paid: 13, deducted: 0 });
		expect(settlement({ ...me, employment: 'intern' }, '2026-12', leaves, TEAM, [])).toEqual({ taken: 1, result: 'deducted', paid: 0, deducted: 1 });
	});
});

describe('Festival holidays (SPEC.md 6.10, 6.20)', () => {
	it('counts each date once, never the weekly day off, per year', () => {
		const offs = [{ from_date: '2026-10-20', to_date: '2026-10-24' }, { from_date: '2026-10-21', to_date: '2026-10-21' }, { from_date: '2025-12-31', to_date: '2026-01-01' }];
		expect(festivalDays(2026, offs, TEAM)).toBe(5);
		expect(festivalDays(2025, offs, TEAM)).toBe(1);
		expect(holidaysOf(2026, [PUJA, { id: 'v', name: 'Victory Day', from_date: '2026-12-16', to_date: '2026-12-16' }], TEAM).map((o) => [o.name, o.days])).toEqual([
			['Durga Puja', 2],
			['Victory Day', 1],
		]);
		expect(holidaysAhead(2026, [PUJA], TEAM, '2026-10-21')).toBe(1);
	});

	it('works out the month: Saturday first, working days, leave taken', () => {
		// 1 Oct 2026 is a Thursday: Sat, Sun, Mon, Tue, Wed blank.
		expect(monthCells('2026-10').slice(0, 6)).toEqual([null, null, null, null, null, '2026-10-01']);
		// 31 days − 5 Fridays − 2 Puja days.
		expect(workingDays('2026-10', TEAM, [PUJA])).toBe(24);
		const members = { m: { id: 'm', name: 'Max Member', weekly_off: null }, n: { id: 'n', name: 'Nia New', weekly_off: null } };
		const leaves = [leave('a', 'm', '2026-10-19', '2026-10-22'), leave('b', 'n', '2026-10-05', '2026-10-05', 'pending')];
		expect(takenThisMonth('2026-10', leaves, members, TEAM, [PUJA])).toEqual({ days: 2, people: 1 });
	});

	it('shows the type to managers and only "out" to Team Members', () => {
		const members = { m: { id: 'm', name: 'Max Member' }, r: { id: 'r', name: 'Rajon Roy' }, n: { id: 'n', name: 'Nia New' } };
		const leaves = [leave('a', 'r', '2026-10-13', '2026-10-14', 'approved', 'sick'), leave('b', 'n', '2026-10-13', '2026-10-13', 'pending'), leave('c', 'm', '2026-10-13', '2026-10-13')];
		expect(dayChips('2026-10-13', leaves, members, { id: 'lee' }, true).map((c) => c.label)).toEqual(['Rajon · sick', 'Nia · asked', 'Max · casual']);
		const mine = dayChips('2026-10-13', leaves, members, { id: 'm' }, false);
		expect(mine.map((c) => [c.tone, c.label])).toEqual([
			['out', 'Rajon out'],
			['you', 'You · casual'],
		]);
	});
});

describe('Interactive balances and the first year (SPEC.md 6.10, 6.20, HOL-4, HOL-5)', () => {
	const tania = { id: 't', weekly_off: null, employment: 'full_time', employment_since: '2026-10-05' };

	it('prorates the first year from the month leave started, half days up', () => {
		expect(allowance(tania, 'day', 2026)).toBe(3);
		expect(allowance(tania, 'sick', 2026)).toBe(4);
		expect(allowance(tania, 'day', 2027)).toBe(10);
		expect(allowance(tania, 'day', 2025)).toBe(0);
		expect(allowance({ ...tania, employment_since: '2026-12-01' }, 'day', 2026)).toBe(1);
		expect(firstYearSince(tania, 2026)).toBe('2026-10-05');
		expect(firstYearSince(tania, 2027)).toBe(null);
		expect(firstYearSince({ ...tania, employment: 'intern' }, 2026)).toBe(null);
		// 4 casual days in November: 1 over the prorated 3; December pays the 4 sick days.
		const leaves = [leave('a', 't', '2026-11-02', '2026-11-05')];
		expect(settlement(tania, '2026-11', leaves, [], []).deducted).toBe(1);
		expect(settlement(tania, '2026-12', leaves, [], []).paid).toBe(4);
		expect(balance(tania, 2026, leaves, [], []).day).toEqual({ allowance: 3, taken: 4, left: 0, over: 1 });
	});

	it('counts a person\'s days per month, approved and waiting, and groups them by request', () => {
		const me = { id: 'm', weekly_off: null };
		const leaves = [leave('a', 'm', '2026-05-11', '2026-05-11'), leave('b', 'm', '2026-10-06', '2026-10-07'), leave('c', 'm', '2026-10-27', '2026-10-27', 'pending'), leave('d', 'm', '2026-10-13', '2026-10-14', 'approved', 'sick'), leave('e', 'x', '2026-10-01', '2026-10-01')];
		const c = monthCounts(me, 2026, leaves, TEAM, [], ['day']);
		expect(c.taken[4]).toBe(1);
		expect(c.taken[9]).toBe(2);
		expect(c.waiting[9]).toBe(1);
		expect(runsOf(c.days).map((r) => [r.from, r.to, r.n, r.status])).toEqual([
			['2026-05-11', '2026-05-11', 1, 'approved'],
			['2026-10-06', '2026-10-07', 2, 'approved'],
			['2026-10-27', '2026-10-27', 1, 'pending'],
		]);
		expect(monthCounts(me, 2026, leaves, TEAM, [], ['day', 'sick']).taken[9]).toBe(4);
	});

	it('splits festival days into passed and to come, and leaves out the ones before someone joined', () => {
		const offs = [{ id: 'e', from_date: '2026-03-30', to_date: '2026-04-01' }, PUJA, { id: 'v', from_date: '2026-12-16', to_date: '2026-12-16' }];
		const all = festivalCounts(2026, offs, TEAM, '2026-10-22', null);
		expect(all.total).toBe(6);
		expect(all.taken[2] + all.taken[3] + all.taken[9]).toBe(5);
		expect(all.waiting[11]).toBe(1);
		// Joined Oct 5: Durga Puja (2) and Victory Day (1).
		expect(festivalCounts(2026, offs, TEAM, '2026-10-22', '2026-10-05').total).toBe(3);
	});
});
