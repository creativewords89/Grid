import { describe, expect, it } from 'vitest';
import { cycleSetup, lastCycleCount, meetingOfCycle, setupReminders } from '../lib/cycleSetup.js';
import { strips } from '../lib/day.js';
import { bellItems } from '../lib/feed.js';
import { emptyData } from '../lib/store.js';

const MAX = { id: 'max', name: 'Max Member', role: 'member', active: 1 };
const LEAD = { id: 'lee', name: 'Lee Lead', role: 'lead', active: 1 };
const ADMIN = { id: 'ada', name: 'Ada Admin', role: 'admin', active: 1 };

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

	it('reviews the meeting tasks due or finished last cycle too', () => {
		const d = fixture();
		const mt = (id, extra) => ({ id, project_id: 'p1', title: id, status: 'todo', assignees: [{ id: 'max', n: 1 }], ...extra });
		d.meeting_tasks = {
			due: mt('due', { deadline: { type: 'date', date: '2026-09-20' } }),
			doneIn: mt('doneIn', { status: 'done', done_at: '2026-09-28 10:00:00', deadline: { type: 'date', date: '2026-10-10' } }),
			doneBefore: mt('doneBefore', { status: 'done', done_at: '2026-08-28 10:00:00', deadline: { type: 'date', date: '2026-09-05' } }),
			later: mt('later', { deadline: { type: 'date', date: '2026-10-08' } }),
			none: mt('none', {}),
			other: { ...mt('other', { deadline: { type: 'date', date: '2026-09-20' } }), project_id: 'p2' },
		};
		expect(meetingOfCycle(d, d.projects.p1, { start: '2026-09-01', end: '2026-09-30' }).map((t) => t.id)).toEqual(['due', 'doneIn']);
		const [c] = cycleSetup(d, '2026-10-02');
		expect(c).toMatchObject({ meetingReviewed: 0 });
		expect(c.meeting).toHaveLength(2);

		Object.values(d.monthly_tasks).forEach((t) => (t.assignees = [{ id: 'max', n: 1 }]));
		d.projects.p1.cycle_reviews = { '2026-09': { t1: { ok: true }, t2: { ok: true }, due: { ok: true, carry: '2026-10-10' } } };
		expect(cycleSetup(d, '2026-10-02')[0]).toMatchObject({ done: false, meetingReviewed: 1 });
		// Carried over into this cycle: still counted for last cycle.
		d.meeting_tasks.due.deadline = { type: 'date', date: '2026-10-10' };
		expect(cycleSetup(d, '2026-10-02')[0].meeting.map((t) => t.id)).toEqual(['due', 'doneIn']);
		d.projects.p1.cycle_reviews['2026-09'].doneIn = { ok: true };
		expect(cycleSetup(d, '2026-10-02')[0].done).toBe(true);
	});

	it('reminds Team Leaders and the Super Admin every day until it is done', () => {
		const d = fixture();
		const [day1] = setupReminders(d, LEAD, '2026-10-01');
		expect(day1).toMatchObject({ key: 'setup:p1:2026-10-01', kind: 'setup', tone: 'amber', title: 'New cycle for Acme — 2 unassigned, 2 to review · 3 days left' });
		// A new one each day: the key carries the date.
		expect(setupReminders(d, LEAD, '2026-10-03')[0]).toMatchObject({ key: 'setup:p1:2026-10-03', title: 'New cycle for Acme — 2 unassigned, 2 to review · 1 day left' });
		expect(setupReminders(d, ADMIN, '2026-10-05')[0]).toMatchObject({ key: 'setup:p1:2026-10-05', tone: 'red', title: 'Acme: new cycle setup is 2 days overdue — 2 unassigned, 2 to review' });
		expect(setupReminders(d, MAX, '2026-10-05')).toEqual([]);

		// Done → gone, with nothing to dismiss.
		Object.values(d.monthly_tasks).forEach((t) => (t.assignees = [{ id: 'max', n: 1 }]));
		d.projects.p1.cycle_reviews = { '2026-09': { t1: { ok: true }, t2: { ok: true } } };
		expect(setupReminders(d, LEAD, '2026-10-05')).toEqual([]);
	});

	it('reminds about unassigned monthly tasks on any day, and the Super Admin gets one summary', () => {
		const d = fixture();
		d.projects.p2 = { id: 'p2', name: 'Bright', state: 'active', cycle_day: 28, cycle_set: 1, created_at: '2026-08-01 09:00:00' };
		d.monthly_tasks.b1 = { id: 'b1', project_id: 'p2', title: 'GBP', freq: 'monthly', assignees: [], created_at: '2026-08-02 10:00:00' };
		const mid = setupReminders(d, LEAD, '2026-10-20');
		expect(mid.map((r) => r.title)).toEqual(['Acme: new cycle setup is 17 days overdue — 2 unassigned, 2 to review', 'Bright: 1 monthly task has nobody assigned']);
		expect(mid[1]).toMatchObject({ key: 'unassigned:p2:2026-10-20', kind: 'unassigned', ok: 'Assign people' });

		// Bright's cycle (Sep 28) counts once the rule started earlier: two late projects, and the
		// Super Admin gets one summary on top.
		d.settings.s.value = { date: '2026-09-01' };
		const admin = setupReminders(d, ADMIN, '2026-10-20');
		expect(admin[0]).toMatchObject({ key: 'setup:all:2026-10-20', tone: 'red', title: '2 projects late on new cycle setup: Bright (20 days), Acme (17 days)' });
		expect(setupReminders(d, LEAD, '2026-10-20').some((r) => r.key.startsWith('setup:all'))).toBe(false);
	});

	it('the bell always counts the reminders as new: reading does not clear them', () => {
		const d = fixture();
		d.dismissals = { x: { id: 'x', member_id: 'lee', notice_key: 'seen:setup:p1:2026-10-02' } };
		const bell = bellItems(d, LEAD, '2026-10-02');
		expect(bell[0]).toMatchObject({ key: 'setup:p1:2026-10-02', unread: true, sticky: true });
		// Not twice: the message band's copy stays off the bell.
		expect(bell.filter((i) => i.text.includes('Acme'))).toHaveLength(1);
		expect(bellItems(d, MAX, '2026-10-02').some((i) => i.sticky)).toBe(false);
	});
});
