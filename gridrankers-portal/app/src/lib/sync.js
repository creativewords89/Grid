// GET /sync paging: fetches every page for one cursor and returns the merged result.
// The next poll uses the cursor from the first page.

export async function fetchSync(api, since) {
	const changes = {};
	let deletions = [];
	let cursor = null;

	for (let page = 0; page < 50; page++) {
		const res = await api.get('sync', { since: since || '', page });
		if (page === 0) {
			cursor = res.cursor;
			deletions = res.deletions || [];
		}
		Object.entries(res.changes || {}).forEach(([table, rows]) => {
			changes[table] = (changes[table] || []).concat(rows || []);
		});
		if (!res.more) break;
	}

	return { cursor, changes, deletions };
}

export const POLL_MS = 10000;
