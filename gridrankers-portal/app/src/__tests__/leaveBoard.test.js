import { describe, expect, it } from 'vitest';
import { strips } from '../lib/day.js';
import { isIssued, leaveSummary, mayDecideLeave, mayIssueLeave, overBy, sortLeave } from '../lib/leaveBoard.js';
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

	it('Team Leaders and the Super Admin issue a day off to Team Members and Team Leaders, not themselves', () => {
		const SECOND = { id: 'lia', name: 'Lia Lead', role: 'lead', active: 1 };
		expect(mayIssueLeave(LEAD, MAX)).toBe(true);
		expect(mayIssueLeave(LEAD, SECOND)).toBe(true);
		expect(mayIssueLeave(LEAD, LEAD)).toBe(false);
		expect(mayIssueLeave(LEAD, OWNER)).toBe(false);
		expect(mayIssueLeave(OWNER, LEAD)).toBe(true);
		expect(mayIssueLeave(OWNER, OWNER)).toBe(false);
		expect(mayIssueLeave(MAX, NIA)).toBe(false);
		expect(mayIssueLeave(LEAD, { ...NIA, active: 0 })).toBe(false);
	});

	it('an issued day off is marked and tells the person who gave it', () => {
		const d = fixture();
		const issued = { ...leave('i', 'max', '2026-10-19', '2026-10-20', 'approved', 2), created_by: 'lee', decided_by: 'lee', decided_at: '2026-10-14 08:00:00', message: 'Thanks for the launch' };
		d.leave.i = issued;
		expect(isIssued(issued)).toBe(true);
		expect(isIssued({ ...d.leave.a, created_by: 'max' })).toBe(false);
		const band = strips(d, MAX, TODAY, { now: Date.parse('2026-10-14T09:00:00Z'), all: true }).find((x) => x.key === 'leave:i:issued');
		expect(band.title).toMatch(/^Lee Lead gave you a day off · .+ \(2 days, day leave\)\.$/);
		expect(band.text).toBe('“Thanks for the launch”');
	});
});
