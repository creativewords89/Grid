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
});
