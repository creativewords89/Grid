import { describe, expect, it } from 'vitest';
import { approvals, attention, bellItems, myProjects, PROJECT_FILTERS, shoutouts, strips } from '../lib/day.js';
import { dayOffKind, daysLeft, fill, leaveDays, messages, takenInMonth, teamWeekly, weekday, whosOut } from '../lib/people.js';
import { emptyData } from '../lib/store.js';

const TODAY = '2026-10-01'; // a Thursday
const NOW = Date.parse('2026-10-01T09:00:00Z');

function team() {
	const d = emptyData();
	d.members = {
		max: { id: 'max', name: 'Max Member', role: 'member', active: 1, weekly_off: null, birthday: '10-01' },
		rafi: { id: 'rafi', name: 'Rafi Khan', role: 'member', active: 1, weekly_off: [4] },
		sara: { id: 'sara', name: 'Sara Ahmed', role: 'member', active: 1, weekly_off: null, birthday: '10-01' },
		lee: { id: 'lee', name: 'Lee Lead', role: 'lead', active: 1, weekly_off: null },
		grid: { id: 'grid', name: 'Grid Owner', role: 'admin', active: 1, weekly_off: null },
	};
	d.days_off = { o1: { id: 'o1', kind: 'event', name: 'Durga Puja', from_date: '2026-10-06', to_date: '2026-10-06' } };
	return d;
}

describe('people helpers', () => {
	it('weekly days off, events and leave days', () => {
		const d = team();
		const off = Object.values(d.days_off);
		expect(weekday('2026-10-02')).toBe(5);
		expect(teamWeekly(d)).toEqual([5]);
		d.settings = { s: { id: 's', setting_key: 'weekly_off', value: { days: [6, 5] } } };
		expect(teamWeekly(d)).toEqual([5, 6]);
		expect(dayOffKind('2026-10-01', d.members.rafi, [5], off)).toBe('weekly');
		expect(dayOffKind('2026-10-06', d.members.max, [5], off)).toBe('event');
		expect(leaveDays('2026-10-01', '2026-10-07', d.members.max, [5], off)).toEqual({ '2026-10': 5 });
		expect(leaveDays('2026-10-28', '2026-11-03', d.members.max, [5], off)).toEqual({ '2026-10': 3, '2026-11': 3 });
	});

	it('taken this month, days left and who is out', () => {
		const d = team();
		const leaves = [
			{ id: 'l1', member_id: 'sara', status: 'approved', from_date: '2026-09-30', to_date: '2026-10-04' },
			{ id: 'l2', member_id: 'max', status: 'pending', from_date: '2026-10-01', to_date: '2026-10-01' },
		];
		expect(takenInMonth(d.members.sara, '2026-10', leaves, [5], [])).toBe(3);
		expect(daysLeft(2)).toBe(0);
		expect(daysLeft(0)).toBe(1);
		const out = whosOut(TODAY, Object.values(d.members), leaves, [5], Object.values(d.days_off), 'max');
		expect(out.map((o) => [o.member.id, o.why, o.back])).toEqual([
			['rafi', 'day_off', '2026-10-02'],
			['sara', 'leave', '2026-10-05'],
		]);
	});

	it('automatic messages fill in the first name', () => {
		const d = team();
		d.settings = { s: { id: 's', setting_key: 'messages', value: { birthday: 'Hi {name}!', day_off: '' } } };
		expect(fill(messages(d).birthday, d.members.max)).toBe('Hi Max!');
		expect(messages(d).day_off).toContain('{name}');
	});
});

describe('my day', () => {
	function work() {
		const d = team();
		d.projects = {
			a: { id: 'a', name: 'Acme Plumbing', state: 'active', cycle_day: 1, cycle_set: 1 },
			b: { id: 'b', name: 'Bright Dental', state: 'active', cycle_day: 1, cycle_set: 1 },
			c: { id: 'c', name: 'Coastal Roofing', state: 'active', cycle_day: 1, cycle_set: 1 },
		};
		const mine = [{ id: 'max', n: 1 }];
		d.meeting_tasks = {
			t1: { id: 't1', project_id: 'b', title: 'Due Saturday', status: 'todo', priority: 'normal', target: 1, assignees: mine, deadline: { type: 'date', date: '2026-10-03' } },
			t2: { id: 't2', project_id: 'a', title: 'Fix H1', status: 'todo', priority: 'normal', target: 1, assignees: mine, deadline: { type: 'date', date: '2026-09-30' } },
			t3: { id: 't3', project_id: 'c', title: 'Later', status: 'doing', priority: 'normal', target: 1, assignees: mine, deadline: { type: 'date', date: '2026-10-20' } },
			t4: { id: 't4', project_id: 'c', title: 'Not mine', status: 'todo', priority: 'urgent', target: 1, assignees: [], deadline: { type: 'none' } },
		};
		return d;
	}

	it('groups my open work by project, most urgent first', () => {
		const groups = myProjects(work(), { id: 'max' }, TODAY);
		expect(groups.map((g) => [g.project.name, g.flag.text, g.flag.tone])).toEqual([
			['Acme Plumbing', 'Overdue', 'red'],
			['Bright Dental', 'Due in 2 days', 'amber'],
			['Coastal Roofing', 'Due Oct 20', 'plain'].map((x, i) => (i === 1 ? expect.stringMatching(/^Due /) : x)),
		]);
		expect(groups.filter((g) => PROJECT_FILTERS.overdue(g, TODAY))).toHaveLength(1);
		expect(groups.filter((g) => PROJECT_FILTERS.week(g, TODAY))).toHaveLength(2);
		expect(myProjects(work(), { id: 'nobody' }, TODAY)).toEqual([]);
	});

	it('message strips: day off, birthdays, announcements, dismissals', () => {
		const d = work();
		d.posts = {
			p1: { id: 'p1', kind: 'announcement', title: 'Office closed', body: 'Enjoy', pinned: 1, created_by: 'grid', created_at: '2026-09-29 10:00:00' },
			p2: { id: 'p2', kind: 'announcement', title: 'Old', body: 'x', show_until: '2026-09-30', created_at: '2026-09-20 10:00:00' },
			p3: { id: 'p3', kind: 'shoutout', body: 'Great work', to_member: 'max', created_by: 'lee', created_at: '2026-09-30 10:00:00' },
			p4: { id: 'p4', kind: 'shoutout', body: 'Too old', to_member: 'max', created_by: 'lee', created_at: '2026-08-01 10:00:00' },
		};
		const max = d.members.max;
		const keys = strips(d, max, TODAY, { now: NOW }).map((s) => s.key);
		expect(keys).toEqual(['bday:2026', 'bday:sara:2026', 'post:p1']);
		expect(strips(d, d.members.rafi, TODAY, { now: NOW })[0]).toMatchObject({ kind: 'dayoff', ok: 'Thanks', title: expect.stringContaining('Today is your day off, Rafi') });

		d.dismissals = { x: { id: 'x', member_id: 'max', notice_key: 'post:p1' } };
		expect(strips(d, max, TODAY, { now: NOW }).map((s) => s.key)).not.toContain('post:p1');
		expect(shoutouts(d, NOW).map((p) => p.id)).toEqual(['p3']);

		const bell = bellItems(d, max, TODAY, NOW);
		expect(bell.map((b) => b.key)).toEqual(['bday:2026', 'bday:sara:2026', 'post:p1', 'shout:p3']);
		expect(bell.every((b) => b.unread)).toBe(true);
	});

	it('leave decisions show to the person who asked', () => {
		const d = work();
		d.leave = { l1: { id: 'l1', member_id: 'max', status: 'approved', from_date: '2026-10-19', to_date: '2026-10-21', decided_by: 'lee', decided_at: '2026-09-30 15:00:00', message: '' } };
		const s = strips(d, d.members.max, TODAY, { now: NOW }).find((x) => x.kind === 'leave');
		expect(s.title).toMatch(/approved/);
		expect(s.text).toContain('Enjoy your time off, Max!');
	});

	it('needs your approval: members’ leave and reviews, requested reviews only for their reviewer', () => {
		const d = work();
		d.leave = {
			l1: { id: 'l1', member_id: 'max', status: 'pending', from_date: '2026-10-19', to_date: '2026-10-21', created_at: '2026-09-30 10:00:00' },
			l2: { id: 'l2', member_id: 'lee', status: 'approved', from_date: '2026-10-19', to_date: '2026-10-19' },
		};
		d.meeting_tasks.t2 = { ...d.meeting_tasks.t2, status: 'done', review: { state: 'pending', submittedBy: 'max', submittedAt: '2026-09-30T11:00:00Z' } };
		d.meeting_tasks.t3 = { ...d.meeting_tasks.t3, status: 'done', review: { state: 'pending', submittedBy: 'lee', submittedAt: '2026-09-30T12:00:00Z', reviewer: 'max' } };

		expect(approvals(d, d.members.lee).map((a) => a.id)).toEqual(['item:t2', 'l1']);
		expect(approvals(d, d.members.grid).map((a) => a.id)).toEqual(['item:t3', 'item:t2', 'l1']);
		expect(approvals(d, d.members.max).map((a) => a.id)).toEqual(['item:t3']);
		expect(strips(d, d.members.max, TODAY, { now: NOW }).find((s) => s.kind === 'review')).toMatchObject({ title: 'Lee Lead asked you to review “Later”.' });
	});

	it('projects tab: what needs attention', () => {
		const items = attention(work(), TODAY);
		expect(items.map((i) => [i.type, i.task.id])).toEqual([
			['overdue', 't2'],
			['soon', 't1'],
			['unassigned', 't4'],
		]);
		expect(items[2].reason).toBe('Urgent · unassigned');
	});
});
