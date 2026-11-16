import { describe, expect, it } from 'vitest';
import { cycleLabel, cycleSetup, lastCycleCount, lastCycleWork, linkName, leftLastCycle, meetingOfCycle, setupReminders, unfinishedOf } from '../lib/cycleSetup.js';
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

	it('is overdue after day 3, and done once everything is assigned, reviewed and every unfinished task decided', () => {
		const d = fixture();
		expect(cycleSetup(d, '2026-10-05')[0].late).toBe(2);

		Object.values(d.monthly_tasks).forEach((t) => (t.assignees = [{ id: 'max', n: 1 }]));
		d.projects.p1.cycle_reviews = { '2026-09': { t1: { ok: true }, t2: { ok: false, note: 'More pages' } } };
		// Blogs (3 of 4) and Pages (0 of 2) are unfinished: not done until each is left or moved.
		expect(cycleSetup(d, '2026-10-03')[0]).toMatchObject({ done: false, unfinished: 2, unfinishedAll: 2 });
		d.projects.p1.cycle_reviews['2026-09']._left = { t1: { by: 'lee' } };
		expect(cycleSetup(d, '2026-10-03')[0]).toMatchObject({ done: false, unfinished: 1 });
		d.projects.p1.cycle_reviews['2026-09']._left.t2 = { by: 'lee' };
		expect(cycleSetup(d, '2026-10-03')[0]).toMatchObject({ done: true, assigned: 3, reviewed: 2, unfinished: 0, unfinishedAll: 2, unfinishedMoved: 0 });
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
		d.projects.p1.cycle_reviews['2026-09']._left = { t1: {}, t2: {}, none: {} };
		expect(cycleSetup(d, '2026-10-02')[0].done).toBe(true);
	});

	it('reminds Team Leaders and the Super Admin every day until it is done', () => {
		const d = fixture();
		const [day1] = setupReminders(d, LEAD, '2026-10-01');
		expect(day1).toMatchObject({ key: 'setup:p1:2026-10-01', kind: 'setup', tone: 'amber', title: 'New cycle for Acme — 2 unassigned, 2 to review, 2 unfinished to decide · 3 days left' });
		// A new one each day: the key carries the date.
		expect(setupReminders(d, LEAD, '2026-10-03')[0]).toMatchObject({ key: 'setup:p1:2026-10-03', title: 'New cycle for Acme — 2 unassigned, 2 to review, 2 unfinished to decide · 1 day left' });
		expect(setupReminders(d, ADMIN, '2026-10-05')[0]).toMatchObject({ key: 'setup:p1:2026-10-05', tone: 'red', title: 'Acme: new cycle setup is 2 days overdue — 2 unassigned, 2 to review, 2 unfinished to decide' });
		expect(setupReminders(d, MAX, '2026-10-05')).toEqual([]);

		// Done → gone, with nothing to dismiss.
		Object.values(d.monthly_tasks).forEach((t) => (t.assignees = [{ id: 'max', n: 1 }]));
		d.projects.p1.cycle_reviews = { '2026-09': { t1: { ok: true }, t2: { ok: true }, _left: { t1: {}, t2: {} } } };
		expect(setupReminders(d, LEAD, '2026-10-05')).toEqual([]);
	});

	it('reminds about unassigned monthly tasks on any day, and the Super Admin gets one summary', () => {
		const d = fixture();
		d.projects.p2 = { id: 'p2', name: 'Bright', state: 'active', cycle_day: 28, cycle_set: 1, created_at: '2026-08-01 09:00:00' };
		d.monthly_tasks.b1 = { id: 'b1', project_id: 'p2', title: 'GBP', freq: 'monthly', assignees: [], created_at: '2026-08-02 10:00:00' };
		const mid = setupReminders(d, LEAD, '2026-10-20');
		expect(mid.map((r) => r.title)).toEqual(['Acme: new cycle setup is 17 days overdue — 2 unassigned, 2 to review, 2 unfinished to decide', 'Bright: 1 monthly task has nobody assigned']);
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
		expect(bell.filter((i) => i.text.includes('New cycle for Acme'))).toHaveLength(1);
		// What wasn't finished last cycle (Blogs 3 of 4, Pages 0 of 2) is part of the setup.
		expect(bell[0].text).toContain('2 unfinished to decide');
		expect(bell.some((i) => i.key.startsWith('unfinished:'))).toBe(false);
		expect(bellItems(d, MAX, '2026-10-02').some((i) => i.sticky)).toBe(false);
	});
});

// Unfinished work of last cycle (SPEC.md 6.11, design CO-1A).
describe('unfinished from last cycle', () => {
	it('lists monthly tasks with something left and open meeting tasks; nothing moves by itself', () => {
		const d = fixture();
		d.records['t2__2026-09'] = { count: 0, status: 'skipped' };
		d.meeting_tasks = {
			m1: { id: 'm1', project_id: 'p1', title: 'Fix form', status: 'doing', deadline: { type: 'date', date: '2026-09-20' }, created_at: '2026-09-01 09:00:00' },
			m2: { id: 'm2', project_id: 'p1', title: 'Done one', status: 'done', done_at: '2026-09-10 09:00:00', deadline: { type: 'date', date: '2026-09-12' }, created_at: '2026-09-01 09:00:00' },
		};
		const [c] = cycleSetup(d, '2026-10-02');
		const list = unfinishedOf(d, c, '2026-10-02');
		// Blogs 3 of 4 (1 left); Pages was skipped, so nothing is left.
		expect(list.map((u) => [u.task.id, u.kind, u.left, u.moved])).toEqual([
			['t1', 'monthly', 1, null],
			['m1', 'meeting', undefined, null],
		]);
		expect(leftLastCycle(d, d.monthly_tasks.t1, d.projects.p1, '2026-10-02')).toBe(1);
		expect([cycleLabel(c.prev), cycleLabel(c.cycle)]).toEqual(['Sep', 'Oct']);
	});

	it('shows what was moved: the catch-up task, and the meeting task with its new deadline', () => {
		const d = fixture();
		d.meeting_tasks = {
			m1: { id: 'm1', project_id: 'p1', title: 'Fix form', status: 'doing', deadline: { type: 'date', date: '2026-10-06' }, carried: { from: 'meeting', task_id: 'm1', cycle: '2026-09', label: 'Sep' }, created_at: '2026-09-01 09:00:00' },
			c1: { id: 'c1', project_id: 'p1', title: 'Blogs — 1 left from Sep', status: 'todo', deadline: { type: 'date', date: '2026-10-10' }, carried: { from: 'monthly', task_id: 't1', cycle: '2026-09', label: 'Sep', left: 1 }, created_at: '2026-10-02 09:00:00' },
		};
		d.projects.p1.cycle_reviews = { '2026-09': { m1: { ok: true, carry: '2026-10-06' } } };
		const [c] = cycleSetup(d, '2026-10-02');
		const list = unfinishedOf(d, c, '2026-10-02');
		// Pages (0 of 2) wasn't moved: it stays in September.
		expect(list.map((u) => [u.task.id, u.moved && u.moved.id])).toEqual([
			['t1', 'c1'],
			['t2', null],
			['m1', 'm1'],
		]);
	});
});

describe('unfinished reminders and every open meeting task', () => {
	it('lists open meeting tasks with a past deadline or none, not ones still due', () => {
		const d = fixture();
		d.meeting_tasks = {
			old: { id: 'old', project_id: 'p1', title: 'Old fix', status: 'todo', deadline: { type: 'date', date: '2026-08-20' }, created_at: '2026-08-10 09:00:00' },
			none: { id: 'none', project_id: 'p1', title: 'No deadline', status: 'doing', deadline: { type: 'none' }, created_at: '2026-09-05 09:00:00' },
			later: { id: 'later', project_id: 'p1', title: 'Due later', status: 'todo', deadline: { type: 'date', date: '2026-10-20' }, created_at: '2026-09-05 09:00:00' },
			fresh: { id: 'fresh', project_id: 'p1', title: 'Added this cycle', status: 'todo', created_at: '2026-10-01 09:00:00' },
			gen: { id: 'gen', project_id: '', title: 'General', status: 'todo', created_at: '2026-09-05 09:00:00' },
		};
		const [c] = cycleSetup(d, '2026-10-02');
		expect(unfinishedOf(d, c, '2026-10-02').filter((u) => u.kind === 'meeting').map((u) => u.task.id)).toEqual(['none', 'old']);
		expect(c.unfinished).toBe(4);
	});

	it('reminds leaders every day, with Decide unfinished, until each is left or moved', () => {
		const d = fixture();
		Object.values(d.monthly_tasks).forEach((t) => (t.assignees = [{ id: 'max', n: 1 }]));
		d.projects.p1.cycle_reviews = { '2026-09': { t1: { ok: true }, t2: { ok: true } } };
		const keys = (day, who = LEAD) => setupReminders(d, who, day).map((r) => r.key);
		expect(setupReminders(d, LEAD, '2026-10-02')[0]).toMatchObject({ key: 'unfinished:p1:2026-10-02', kind: 'unfinished', tone: 'amber', ok: 'Decide unfinished', title: 'Acme: 2 tasks not finished in Sep — leave or move to Oct · 2 days left' });
		// Still undecided after day 3: overdue.
		expect(setupReminders(d, LEAD, '2026-10-04')[0]).toMatchObject({ key: 'unfinished:p1:2026-10-04', tone: 'red' });
		expect(keys('2026-10-02', MAX)).toEqual([]);
		// One left in Sep: one to go.
		d.projects.p1.cycle_reviews['2026-09']._left = { t2: { by: 'lee' } };
		expect(setupReminders(d, LEAD, '2026-10-02')[0].title).toContain('1 task not finished');
		// Both decided (Blogs moved, Pages left): the reminder goes.
		d.meeting_tasks = {
			c1: { id: 'c1', project_id: 'p1', title: 'Blogs — 1 left from Sep', status: 'todo', carried: { from: 'monthly', task_id: 't1', cycle: '2026-09' }, created_at: '2026-10-02 09:00:00' },
			c2: { id: 'c2', project_id: 'p1', title: 'Pages — 2 left from Sep', status: 'todo', carried: { from: 'monthly', task_id: 't2', cycle: '2026-09' }, created_at: '2026-10-02 09:00:00' },
		};
		expect(keys('2026-10-02')).toEqual([]);
	});
});

// Review last cycle shows what was handed in (SPEC.md 6.11).
describe('the work handed in last cycle', () => {
	const FILE = { id: 'f1', mime: 'application/pdf', name: 'report.pdf', size: 10 };
	const IMG = { id: 'f2', mime: 'image/png', name: 'hero.png', size: 10 };
	it('gathers a monthly task’s submission and hand-ins, files once each', () => {
		const d = fixture();
		d.records['t1__2026-09'] = {
			count: 4,
			status: 'done',
			completion: { note: '4 blogs live', links: ['https://acme.com/blog'], files: [FILE], by: 'max', at: '2026-09-29T10:00:00Z' },
			handins: { w: { draft: { files: [FILE, IMG], links: [{ url: 'https://figma.com/file/a', name: 'Figma' }] } } },
		};
		const work = lastCycleWork(d, d.monthly_tasks.t1, d.projects.p1, '2026-10-02', false);
		expect(work.notes).toEqual([{ text: '4 blogs live', by: 'max', at: '2026-09-29T10:00:00Z' }]);
		expect(work.files.map((f) => f.id)).toEqual(['f1', 'f2']);
		expect(work.links).toEqual([
			{ url: 'https://acme.com/blog', name: 'acme.com' },
			{ url: 'https://figma.com/file/a', name: 'Figma' },
		]);
		// This cycle's record is not last cycle's work.
		expect(lastCycleWork(d, d.monthly_tasks.t2, d.projects.p1, '2026-10-02', false)).toEqual({ notes: [], files: [], links: [] });
	});

	it('reads a meeting task’s own submission', () => {
		const d = fixture();
		const t = { id: 'm1', project_id: 'p1', status: 'done', completion: { note: 'Fixed', link: 'https://acme.com/contact', files: [IMG] } };
		const work = lastCycleWork(d, t, d.projects.p1, '2026-10-02', true);
		expect([work.notes, work.files.length, work.links[0].url]).toEqual([[{ text: 'Fixed', by: null, at: null }], 1, 'https://acme.com/contact']);
	});

	it('without a submission, says who handed in the steps and when (latest per person)', () => {
		const d = fixture();
		d.records['t1__2026-09'] = {
			count: 1,
			status: 'doing',
			handins: {
				write: { draft: { files: [FILE], by: 'max', at: '2026-09-10T09:00:00Z' } },
				check: { ok: { links: ['https://acme.com/a'], by: 'max', at: '2026-09-12T09:00:00Z' }, seo: { links: [], by: 'lee', at: '2026-09-11T09:00:00Z' } },
			},
		};
		const work = lastCycleWork(d, d.monthly_tasks.t1, d.projects.p1, '2026-10-02', false);
		expect(work.notes).toEqual([
			{ text: '', by: 'max', at: '2026-09-12T09:00:00Z' },
			{ text: '', by: 'lee', at: '2026-09-11T09:00:00Z' },
		]);
	});

	it('gives links a short name', () => {
		expect(linkName('https://docs.google.com/spreadsheets/d/1TSOF/edit?usp=sharing')).toBe('Sheet');
		expect(linkName('https://docs.google.com/document/d/x/edit')).toBe('Doc');
		expect(linkName('https://docs.google.com/presentation/d/x')).toBe('Slides');
		expect(linkName('https://drive.google.com/file/d/x')).toBe('Drive');
		expect(linkName('https://www.figma.com/file/abc')).toBe('figma.com');
		// A name that is only the address again is replaced by the short name.
		const d = fixture();
		const url = 'https://docs.google.com/spreadsheets/d/1aS4/edit?usp=sharing';
		const t = { id: 'm1', project_id: 'p1', status: 'done', completion: { links: [{ url, name: 'docs.google.com/spreadsheets/d/1aS4/edit?usp=sharing' }] } };
		expect(lastCycleWork(d, t, d.projects.p1, '2026-10-02', true).links).toEqual([{ url, name: 'Sheet' }]);
	});
});
