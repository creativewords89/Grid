import { describe, expect, it } from 'vitest';
import { dataReducer, emptyData, rowsOf } from '../lib/store.js';

describe('dataReducer', () => {
	it('merges synced rows and applies deletions', () => {
		let s = emptyData();
		s = dataReducer(s, { type: 'sync', changes: { projects: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }] } });
		s = dataReducer(s, { type: 'sync', changes: { projects: [{ id: 'p1', name: 'A2' }] }, deletions: [{ table: 'projects', id: 'p2' }] });

		expect(rowsOf(s, 'projects')).toEqual([{ id: 'p1', name: 'A2' }]);
	});

	it('ignores unknown tables and rows without ids', () => {
		const s = dataReducer(emptyData(), { type: 'sync', changes: { nope: [{ id: 'x' }], projects: [{ name: 'no id' }] } });
		expect(s.nope).toBeUndefined();
		expect(rowsOf(s, 'projects')).toEqual([]);
	});

	it('upserts, removes and resets', () => {
		let s = dataReducer(emptyData(), { type: 'upsert', table: 'members', row: { id: 'm1', name: 'Max' } });
		expect(s.members.m1.name).toBe('Max');
		s = dataReducer(s, { type: 'remove', table: 'members', id: 'm1' });
		expect(s.members.m1).toBeUndefined();
		s = dataReducer(s, { type: 'upsert', table: 'members', row: { id: 'm2' } });
		expect(dataReducer(s, { type: 'reset' })).toEqual(emptyData());
	});

	it('an older sync response does not overwrite a newer local row', () => {
		let s = dataReducer(emptyData(), { type: 'upsert', table: 'meeting_tasks', row: { id: 't1', status: 'doing', updated_at: '2026-10-01 10:00:05' } });
		s = dataReducer(s, { type: 'sync', changes: { meeting_tasks: [{ id: 't1', status: 'todo', updated_at: '2026-10-01 10:00:00' }] } });
		expect(s.meeting_tasks.t1.status).toBe('doing');
		s = dataReducer(s, { type: 'sync', changes: { meeting_tasks: [{ id: 't1', status: 'done', updated_at: '2026-10-01 10:00:09' }] } });
		expect(s.meeting_tasks.t1.status).toBe('done');
	});

	it('an older sync response does not bring back a removed row; a restore does', () => {
		let s = dataReducer(emptyData(), { type: 'upsert', table: 'trash', row: { id: 'x', updated_at: '2026-10-01 10:00:00' } });
		s = dataReducer(s, { type: 'remove', table: 'trash', id: 'x' });
		s = dataReducer(s, { type: 'sync', changes: { trash: [{ id: 'x', updated_at: '2026-10-01 10:00:00' }] } });
		expect(s.trash.x).toBeUndefined();
		s = dataReducer(s, { type: 'sync', changes: { trash: [{ id: 'x', updated_at: '2026-10-01 10:05:00' }] } });
		expect(s.trash.x).toBeDefined();
	});
});
