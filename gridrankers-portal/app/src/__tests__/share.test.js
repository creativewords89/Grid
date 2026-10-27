// Share a task (SPEC.md 7.7, design SHR-1B).
import { describe, expect, it } from 'vitest';
import { sharedId, sharedTarget, taskLink } from '../lib/share.js';
import { emptyData } from '../lib/store.js';

describe('share a task', () => {
	it('makes a link to the task and reads it back', () => {
		const link = taskLink('mt_8f2c', { origin: 'https://portal.gridrankers.com', pathname: '/' });
		expect(link).toBe('https://portal.gridrankers.com/?task=mt_8f2c');
		expect(sharedId(new URL(link).search)).toBe('mt_8f2c');
		expect(sharedId('?other=1')).toBe('');
		expect(sharedId('')).toBe('');
	});

	it('finds the board of a meeting, general or monthly task, and nothing for a deleted one', () => {
		const d = emptyData();
		d.meeting_tasks = { m1: { id: 'm1', project_id: 'p1', title: 'Fix H1', status: 'todo' }, g1: { id: 'g1', project_id: '', title: 'Order laptops', status: 'todo' }, gone: { id: 'gone', project_id: 'p1', deleted_at: '2026-10-01' } };
		d.monthly_tasks = { t1: { id: 't1', project_id: 'p1', title: 'Blogs' } };
		expect(sharedTarget(d, 'm1')).toMatchObject({ project_id: 'p1', tab: 'board' });
		expect(sharedTarget(d, 'g1')).toMatchObject({ project_id: '', tab: 'general' });
		expect(sharedTarget(d, 't1')).toMatchObject({ project_id: 'p1', tab: 'monthly' });
		expect(sharedTarget(d, 'gone')).toBeNull();
		expect(sharedTarget(d, 'nope')).toBeNull();
	});
});
