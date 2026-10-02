import { describe, expect, it } from 'vitest';
import { leaveSummary, mayDecideLeave, overBy, sortLeave } from '../lib/leaveBoard.js';
import { emptyData } from '../lib/store.js';

const OWNER = { id: 'own', name: 'Grid Owner', role: 'admin', active: 1 };
const LEAD = { id: 'lee', name: 'Lee Lead', role: 'lead', active: 1 };
const MAX = { id: 'max', name: 'Max Member', role: 'member', active: 1 };
const NIA = { id: 'nia', name: 'Nia New', role: 'member', active: 1 };
const leave = (id, member_id, from_date, to_date, status, days = 1) => ({ id, member_id, type: 'day', from_date, to_date, status, days });

// Wednesday 14 Oct 2026; Fridays are the team's weekly day off.
const TODAY = '2026-10-14';
function fixture() {
	const d = emptyData();
	d.members = { own: OWNER, lee: LEAD, max: MAX, nia: NIA };
	d.leave = {
		a: leave('a', 'max', '2026-10-05', '2026-10-05', 'approved'),
		b: leave('b', 'max', '2026-10-20', '2026-10-21', 'pending', 2),
		c: leave('c', 'nia', '2026-10-14', '2026-10-14', 'approved'),
		d: leave('d', 'lee', '2026-10-13', '2026-10-15', 'approved', 3),
		e: leave('e', 'nia', '2026-10-27', '2026-10-27', 'pending'),
		f: leave('f', 'lee', '2026-09-01', '2026-09-01', 'cancelled'),
	};
	return d;
}

describe('Leave tab numbers (SPEC.md 7.5, LV-A)', () => {
	it('counts waiting requests the viewer may decide, people out today, days taken and who is over', () => {
		const s = leaveSummary(fixture(), OWNER, TODAY);
		expect(s.waiting.map((l) => l.id)).toEqual(['e', 'b']);
		expect(s.outToday.map((l) => l.member_id)).toEqual(['lee', 'nia']);
		// Max 1 + Nia 1 + Lee 3 approved days in October.
		expect(s.takenDays).toBe(5);
		expect(s.takenPeople).toBe(3);
		expect(s.over.map((o) => [o.member.id, o.taken])).toEqual([['lee', 3]]);
	});

	it('a Team Member decides nothing; a Team Leader decides Team Members only', () => {
		const d = fixture();
		expect(leaveSummary(d, MAX, TODAY).waiting).toEqual([]);
		expect(mayDecideLeave(d.leave.b, LEAD, d)).toBe(true);
		d.leave.g = leave('g', 'lee', '2026-10-28', '2026-10-28', 'pending');
		expect(mayDecideLeave(d.leave.g, OWNER, d)).toBe(false);
	});

	it('a waiting request says how many days it would go over', () => {
		const d = fixture();
		// Max already took 1 day in October: both days of the request are over.
		expect(overBy(d, d.leave.b)).toBe(2);
		// Nia took 1 day too: the 1-day request is over by 1.
		expect(overBy(d, d.leave.e)).toBe(1);
		// Nobody else this month: within the allowance.
		d.leave.c.status = 'rejected';
		expect(overBy(d, d.leave.e)).toBe(0);
		// A day off (Friday 6 Nov) is not counted.
		d.leave.h = leave('h', 'nia', '2026-11-05', '2026-11-06', 'pending', 1);
		expect(overBy(d, d.leave.h)).toBe(0);
	});

	it('lists waiting requests first, then newest first', () => {
		expect(sortLeave(Object.values(fixture().leave)).map((l) => l.id)).toEqual(['e', 'b', 'c', 'd', 'a', 'f']);
	});
});
