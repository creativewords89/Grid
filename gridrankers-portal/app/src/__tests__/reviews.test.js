import { describe, expect, it } from 'vitest';
import { pendingReviews, reviewsOf } from '../lib/reviews.js';
import { emptyData } from '../lib/store.js';

const data = () => {
	const d = emptyData();
	d.projects = { p1: { id: 'p1', name: 'Acme' } };
	d.members = { m1: { id: 'm1', name: 'Max' }, l1: { id: 'l1', name: 'Lee' } };
	d.meeting_tasks = {
		t1: { id: 't1', project_id: 'p1', title: 'Fix H1', target: 1, review: { state: 'pending', submittedBy: 'm1', submittedAt: '2026-10-02T10:00:00Z' } },
		t2: { id: 't2', project_id: 'p1', title: 'Old', target: 1, review: { state: 'accepted', submittedBy: 'm1', submittedAt: '2026-10-01T10:00:00Z' } },
		t3: { id: 't3', project_id: 'gone', title: 'Orphan', review: { state: 'pending', submittedBy: 'm1', submittedAt: '2026-10-01T09:00:00Z' } },
		t4: { id: 't4', project_id: 'p1', title: 'Redo', review: { state: 'revision', submittedBy: 'm1', by: 'l1', note: 'Add city', at: '2026-10-03T10:00:00Z' } },
	};
	d.monthly_tasks = { m1t: { id: 'm1t', project_id: 'p1', title: 'GBP Posts', target: 4 } };
	d.records = { r1: { id: 'r1', task_id: 'm1t', week: null, count: 4, review: { state: 'pending', submittedBy: 'm1', submittedAt: '2026-10-01T08:00:00Z' } } };
	return d;
};

describe('reviews', () => {
	it('lists pending work oldest first, skipping removed projects', () => {
		const list = pendingReviews(data());
		expect(list.map((x) => [x.kind, x.id])).toEqual([
			['record', 'r1'],
			['item', 't1'],
		]);
		expect(list[0].where).toBe('Monthly · 4/4');
	});

	it("lists a member's revisions and rejections from the last 30 days", () => {
		const list = reviewsOf(data(), 'm1', Date.parse('2026-10-05T00:00:00Z'));
		expect(list.map((x) => x.title)).toEqual(['Redo', 'Fix H1', 'GBP Posts']);
		expect(reviewsOf(data(), 'm1', Date.parse('2026-12-31T00:00:00Z'))).toEqual([]);
	});
});
