// Notifications on My day (SPEC.md 6.10, design NF-A).
import { describe, expect, it } from 'vitest';
import { PAGE_SIZE, ago, bellItems, countsOf, feedOf } from '../lib/feed.js';
import { emptyData } from '../lib/store.js';

const TODAY = '2026-10-12';
const NOW = Date.parse('2026-10-12T12:00:00Z');
const max = { id: 'max', name: 'Max', role: 'member', active: 1, birthday: '' };
const sam = { id: 'sam', name: 'Sam', role: 'member', active: 1, birthday: '10-12' };
const lee = { id: 'lee', name: 'Lee', role: 'lead', active: 1, birthday: '' };

function data() {
	const d = emptyData();
	d.members = { max, sam, lee };
	d.projects = { p: { id: 'p', name: 'Acme', state: 'active' } };
	d.meeting_tasks = {
		n: { id: 'n', project_id: 'p', title: 'Add city to titles', status: 'todo', assignees: [{ id: 'max' }], created_by: 'lee', created_at: '2026-10-12 11:00:00' },
		own: { id: 'own', project_id: 'p', title: 'My own', status: 'todo', assignees: [{ id: 'max' }], created_by: 'max', created_at: '2026-10-12 11:00:00' },
		old: { id: 'old', project_id: 'p', title: 'Old', status: 'todo', assignees: [{ id: 'max' }], created_by: 'lee', created_at: '2026-08-01 11:00:00' },
		rj: { id: 'rj', project_id: 'p', title: 'Fix H1', status: 'done', review: { state: 'rejected', by: 'lee', at: '2026-10-12T10:00:00Z', note: 'Keep the city', submittedBy: 'max' } },
		ok: { id: 'ok', project_id: 'p', title: 'Meta titles', status: 'done', review: { state: 'accepted', by: 'lee', at: '2026-10-12T09:00:00Z', submittedBy: 'max' } },
		auto: { id: 'auto', project_id: 'p', title: 'Leader work', status: 'done', review: { state: 'accepted', auto: 1, by: 'lee', at: '2026-10-12T09:00:00Z', submittedBy: 'lee' } },
	};
	d.leave = { l1: { id: 'l1', member_id: 'max', type: 'sick', from_date: '2026-10-02', to_date: '2026-10-02', days: 1, status: 'approved', decided_by: 'lee', decided_at: '2026-10-11 08:00:00', message: 'Get well soon', created_by: 'max' } };
	d.days_off = { e: { id: 'e', kind: 'event', name: 'Founders Day', from_date: '2026-10-19', to_date: '2026-10-19', created_at: '2026-10-10 08:00:00' }, past: { id: 'past', kind: 'event', name: 'Past', from_date: '2026-09-01', to_date: '2026-09-01', created_at: '2026-08-10 08:00:00' } };
	d.posts = {
		a: { id: 'a', kind: 'notice', title: '', body: 'Welcome to the portal', created_by: 'lee', created_at: '2026-10-11 08:00:00' },
		s: { id: 's', kind: 'shoutout', body: 'Great work', created_by: 'lee', to_member: 'max', to_members: ['max'], created_at: '2026-10-11 09:00:00' },
	};
	return d;
}

describe('notifications feed', () => {
	it('gathers everything for a Team Member, newest first', () => {
		const items = feedOf(data(), max, TODAY, NOW);
		expect(items.map((i) => i.key)).toEqual([
			'new:n',
			'rv:Fix H1:2026-10-12T10:00:00Z',
			'ok:ok:2026-10-12T09:00:00Z',
			'bday:sam:2026',
			'shout:s',
			'leave:l1:approved',
			'notice:a',
			'ev:e',
		]);
		const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
		expect(byKey['new:n']).toMatchObject({ cat: 'task', title: 'New task: “Add city to titles”', open: { project_id: 'p', tab: 'board', title: 'Add city to titles' } });
		expect(byKey['rv:Fix H1:2026-10-12T10:00:00Z']).toMatchObject({ title: 'Rejected: “Fix H1”', tone: 'red' });
		expect(byKey['leave:l1:approved']).toMatchObject({ cat: 'leave', title: 'Sick leave approved · Oct 2' });
		expect(byKey['ev:e']).toMatchObject({ cat: 'event', title: 'Founders Day · Oct 19' });
		expect(byKey['shout:s'].title).toBe('Shout-out from Lee: Great work');
	});

	it('leaves out my own tasks, old news, auto-accepted work and past events', () => {
		const keys = feedOf(data(), max, TODAY, NOW).map((i) => i.key);
		expect(keys).not.toContain('new:own');
		expect(keys).not.toContain('new:old');
		expect(keys).not.toContain('ev:past');
		expect(feedOf(data(), lee, TODAY, NOW).map((i) => i.key)).not.toContain('ok:auto:2026-10-12T09:00:00Z');
	});

	it('counts per filter, page size and times', () => {
		expect(countsOf(feedOf(data(), max, TODAY, NOW))).toEqual({ all: 8, task: 3, leave: 1, message: 2, event: 2 });
		expect(PAGE_SIZE).toBe(6);
		expect(ago('2026-10-12T11:55:00Z', NOW)).toBe('5 min ago');
		expect(ago('2026-10-12T10:00:00Z', NOW)).toBe('2 h ago');
	});

	it('leaders answer reviews asked of them and undo requests under Waiting for you, not in the feed', () => {
		const d = data();
		d.meeting_tasks.ask = { id: 'ask', project_id: 'p', title: 'Content plan', status: 'done', review: { state: 'pending', reviewer: 'lee', submittedBy: 'sam', submittedAt: '2026-10-12T08:00:00Z' } };
		d.meeting_tasks.und = { id: 'und', project_id: 'p', title: 'H1', status: 'doing', undo_request: { by: 'max', at: '2026-10-12 08:00:00', reason: 'Wrong card' } };
		const lead = feedOf(d, lee, TODAY, NOW).map((i) => i.key);
		expect(lead.some((k) => k.startsWith('ask:') || k.startsWith('undo:'))).toBe(false);
		d.meeting_tasks.ask.review.reviewer = 'max';
		expect(feedOf(d, max, TODAY, NOW).map((i) => i.key)).toContain('ask:ask:2026-10-12T08:00:00Z');
	});

	it('the bell lists what the box lists, with the same read state', () => {
		const d = data();
		const box = feedOf(d, max, TODAY, NOW).map((i) => i.key);
		const bell = bellItems(d, max, TODAY, NOW);
		expect(box.every((k) => bell.some((b) => b.key === k))).toBe(true);
		expect(new Set(bell.map((b) => b.key)).size).toBe(bell.length);
		expect(bell.find((b) => b.key === 'new:n')).toMatchObject({ text: 'New task: “Add city to titles”', unread: true });
		d.dismissals = { s: { id: 's', member_id: 'max', notice_key: 'seen:new:n' } };
		expect(bellItems(d, max, TODAY, NOW).find((b) => b.key === 'new:n').unread).toBe(false);
		// Leaders: what waits for them rings the bell too.
		d.leave.l2 = { id: 'l2', member_id: 'sam', type: 'sick', from_date: '2026-10-20', to_date: '2026-10-20', days: 1, status: 'pending', created_at: '2026-10-12 11:30:00' };
		expect(bellItems(d, lee, TODAY, NOW).find((b) => b.key === 'wait:leave:l2')).toMatchObject({ text: 'Sam asks for sick leave · Oct 20', unread: true });
	});
});
