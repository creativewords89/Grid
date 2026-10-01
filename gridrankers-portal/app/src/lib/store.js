// Client-side copy of the portal data, keyed by table then id. The server is the source
// of truth; this is filled by /sync and by the rows returned from writes.

export const TABLES = ['projects', 'meeting_tasks', 'monthly_tasks', 'records', 'members', 'activity', 'trash', 'dismissals', 'settings'];

export function emptyData() {
	return Object.fromEntries(TABLES.map((t) => [t, {}]));
}

function upsertRows(tableMap, rows) {
	if (!rows || !rows.length) return tableMap;
	const next = { ...tableMap };
	rows.forEach((row) => {
		if (row && row.id) next[row.id] = row;
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
				if (next[table]) next[table] = upsertRows(next[table], rows);
			});
			(action.deletions || []).forEach(({ table, id }) => {
				if (next[table] && next[table][id]) {
					next[table] = { ...next[table] };
					delete next[table][id];
				}
			});
			return next;
		}
		case 'upsert':
			if (!state[action.table]) return state;
			return { ...state, [action.table]: upsertRows(state[action.table], [action.row]) };
		case 'remove': {
			if (!state[action.table] || !state[action.table][action.id]) return state;
			const table = { ...state[action.table] };
			delete table[action.id];
			return { ...state, [action.table]: table };
		}
		default:
			return state;
	}
}

export const rowsOf = (data, table) => Object.values(data[table] || {});
