// Client-side copy of the portal data, keyed by table then id. The server is the source
// of truth; this is filled by /sync and by the rows returned from writes.

export const TABLES = ['projects', 'meeting_tasks', 'monthly_tasks', 'records', 'members', 'activity', 'trash', 'dismissals', 'settings', 'leave', 'days_off', 'posts', 'keywords'];

export function emptyData() {
	return { ...Object.fromEntries(TABLES.map((t) => [t, {}])), _removed: {} };
}

const newer = (a, b) => String(a || '') > String(b || '');

// Sync responses can be older than a write made while they were in flight: never let them
// replace a newer row, or bring back a row this client just removed.
function upsertRows(tableMap, rows, table, removed, fromSync) {
	if (!rows || !rows.length) return tableMap;
	const next = { ...tableMap };
	rows.forEach((row) => {
		if (!row || !row.id) return;
		if (fromSync) {
			const cur = next[row.id];
			if (cur && newer(cur.updated_at, row.updated_at)) return;
			const gone = removed[table + ':' + row.id];
			if (gone !== undefined && !newer(row.updated_at, gone)) return;
		}
		next[row.id] = row;
	});
	return next;
}

export function dataReducer(state, action) {
	switch (action.type) {
		case 'reset':
			return emptyData();
		case 'sync': {
			const next = { ...state };
			Object.entries(action.changes || {}).forEach(([table, rows]) => {
				if (next[table] && table !== '_removed') next[table] = upsertRows(next[table], rows, table, state._removed || {}, true);
			});
			(action.deletions || []).forEach(({ table, id }) => {
				if (next[table] && next[table][id]) {
					next[table] = { ...next[table] };
					delete next[table][id];
				}
			});
			return next;
		}
		case 'upsert': {
			if (!state[action.table]) return state;
			const removed = { ...(state._removed || {}) };
			delete removed[action.table + ':' + action.row.id];
			return { ...state, [action.table]: upsertRows(state[action.table], [action.row]), _removed: removed };
		}
		case 'remove': {
			if (!state[action.table] || !state[action.table][action.id]) return state;
			const table = { ...state[action.table] };
			const gone = table[action.id].updated_at || '';
			delete table[action.id];
			return { ...state, [action.table]: table, _removed: { ...(state._removed || {}), [action.table + ':' + action.id]: gone } };
		}
		default:
			return state;
	}
}

export const rowsOf = (data, table) => Object.values(data[table] || {});
