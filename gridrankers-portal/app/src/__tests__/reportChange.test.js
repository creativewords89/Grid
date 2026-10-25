import { describe, expect, it } from 'vitest';
import { approvals } from '../lib/day.js';
import { feedOf, waitTitle } from '../lib/feed.js';
import { changeOf, changeRequest, mayAskChange } from '../lib/reports.js';
import { emptyData } from '../lib/store.js';

// Asking to change a past report (SPEC.md 6.18, design RC-1).
const MAX = { id: 'max', name: 'Max Member', role: 'member', active: 1 };
const LEE = { id: 'lee', name: 'Lee Lead', role: 'lead', active: 1 };
const LIA = { id: 'lia', name: 'Lia Lead', role: 'lead', active: 1 };
const OWNER = { id: 'own', name: 'Grid Owner', role: 'admin', active: 1 };
const entries = [
	{ id: 'e1', title: 'BMW content', minutes: 360 },
	{ id: 'e2', title: 'Images Sorting', minutes: 600 },
];
const change = (id, member, role, status = 'pending', at = '2026-10-24 09:00:00') => ({ id, member_id: member, member_role: role, day: '2026-10-22', entries: [{ id: 'e2', title: 'Images Sorting', from: 600, to: 60 }], from_minutes: 960, to_minutes: 420, reason: 'Typo', status, created_at: at, decided_by: status === 'pending' ? null : 'lee', decided_at: status === 'pending' ? null : at });

function fixture() {
	const d = emptyData();
	d.members = { max: MAX, lee: LEE, lia: LIA, own: OWNER };
	d.report_changes = { c1: change('c1', 'max', 'member'), c2: change('c2', 'lia', 'lead') };
	return d;
}

describe('Ask to change a past report', () => {
	it('builds the request from the changed times and checks it', () => {
		expect(changeRequest(entries, { e1: 360, e2: 60 }, 'Typed 10h')).toEqual({ entries: { e2: 60 }, total: 420 });
		expect(changeRequest(entries, { e1: 360, e2: 600 }, 'x').error).toBe('Change at least one time.');
		expect(changeRequest(entries, { e1: 360, e2: 0 }, 'x').error).toBe('Add the time spent on “Images Sorting”.');
		expect(changeRequest(entries, { e1: 360, e2: 60 }, ' ').error).toBe('Say why the time was wrong.');
		expect(changeRequest(entries, { e1: 1000, e2: 600 }, 'x').error).toBe('A day has at most 24 hours.');
	});

	it('is for one’s own sent report from an earlier day, not the Super Admin', () => {
		const report = { member_id: 'max', day: '2026-10-22', sent_at: '2026-10-22 20:34:00' };
		expect(mayAskChange(report, MAX, '2026-10-25')).toBe(true);
		expect(mayAskChange(report, MAX, '2026-10-22')).toBe(false);
		expect(mayAskChange({ ...report, sent_at: null }, MAX, '2026-10-25')).toBe(false);
		expect(mayAskChange(report, LEE, '2026-10-25')).toBe(false);
	});

	it('waits for Team Leaders (Team Members’ changes) and the Super Admin (everyone’s)', () => {
		const d = fixture();
		expect(approvals(d, LEE).filter((a) => a.kind === 'report_change').map((a) => a.id)).toEqual(['c1']);
		expect(approvals(d, LIA).filter((a) => a.kind === 'report_change').map((a) => a.id)).toEqual(['c1']);
		expect(approvals(d, OWNER).filter((a) => a.kind === 'report_change').map((a) => a.id).sort()).toEqual(['c1', 'c2']);
		expect(approvals(d, MAX).filter((a) => a.kind === 'report_change')).toEqual([]);
		const item = approvals(d, LEE).find((a) => a.kind === 'report_change');
		expect(waitTitle(item)).toMatch(/^Max Member asks to change .+ · 16h → 7h$/);
	});

	it('shows the latest request of the day and tells the person the answer', () => {
		const d = fixture();
		d.report_changes.c0 = change('c0', 'max', 'member', 'rejected', '2026-10-23 09:00:00');
		expect(changeOf(d, 'max', '2026-10-22').id).toBe('c1');
		d.report_changes.c1 = change('c1', 'max', 'member', 'approved', '2026-10-24 09:00:00');
		const items = feedOf(d, MAX, '2026-10-24', Date.parse('2026-10-24T12:00:00Z'));
		expect(items.find((i) => i.key === 'change:c1:approved').title).toMatch(/^Change to your report of .+ approved$/);
	});
});
