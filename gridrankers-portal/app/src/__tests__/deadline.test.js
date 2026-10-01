import { describe, expect, it } from 'vitest';
import { deadlineInfo, itemDeadline } from '../lib/deadline.js';

describe('meeting-task deadlines', () => {
	it('bi-weekly: two weeks from a Monday', () => {
		const task = { status: 'todo', deadline: { type: 'biweekly', from: '2026-10-05', to: '2026-10-18' } };
		expect(itemDeadline(task)).toEqual({ type: 'biweekly', start: '2026-10-05', end: '2026-10-18' });
		expect(itemDeadline({ deadline: { type: 'biweekly', from: '2026-10-05' } }).end).toBe('2026-10-18');
		const info = deadlineInfo(task, '2026-10-17');
		expect(info.soon).toBe(true);
		expect(info.overdue).toBe(false);
		expect(info.label).toMatch(/· 2 weeks$/);
		expect(deadlineInfo(task, '2026-10-19').overdue).toBe(true);
		expect(deadlineInfo({ ...task, status: 'done' }, '2026-10-19').overdue).toBe(false);
	});
});
