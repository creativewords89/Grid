import { describe, expect, it, vi } from 'vitest';
import { fetchSync } from '../lib/sync.js';

describe('fetchSync', () => {
	it('follows pages and keeps the first cursor and deletions', async () => {
		const pages = [
			{ cursor: 'C1', more: true, changes: { projects: [{ id: 'a' }] }, deletions: [{ table: 'projects', id: 'z' }] },
			{ cursor: 'C2', more: false, changes: { projects: [{ id: 'b' }], members: [{ id: 'm' }] }, deletions: [] },
		];
		const api = { get: vi.fn((path, q) => Promise.resolve(pages[q.page])) };

		const res = await fetchSync(api, 'S');

		expect(api.get).toHaveBeenCalledWith('sync', { since: 'S', page: 0 });
		expect(api.get).toHaveBeenCalledWith('sync', { since: 'S', page: 1 });
		expect(res.cursor).toBe('C1');
		expect(res.changes.projects.map((r) => r.id)).toEqual(['a', 'b']);
		expect(res.changes.members).toHaveLength(1);
		expect(res.deletions).toEqual([{ table: 'projects', id: 'z' }]);
	});
});
