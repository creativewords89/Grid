import { addDays } from './timer.js';

// The tracker portal's Hours (SPEC.md 6.22): who `me` sees — the Super Admin everyone who tracks,
// a Team Leader Team Members and themself, a Team Member themself.
export function hoursPeople(members, me) {
	const tracks = (m) => m && +m.active !== 0 && m.role !== 'admin';
	const list = Object.values(members || {}).filter(tracks);
	const seen = me.role === 'admin' ? list : me.role === 'lead' ? list.filter((m) => m.role === 'member' || m.id === me.id) : list.filter((m) => m.id === me.id);
	return seen.sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name)));
}

// A week (7 days ending `to`) of tracked minutes per person and day, with what isn't on the main
// portal yet (`waiting`) and what it refused (`refused`). Deleted entries don't count.
export function weekHours(entries, people, to) {
	const days = Array.from({ length: 7 }, (_, i) => addDays(to, i - 6));
	const rows = people.map((p) => ({ person: p, days: Object.fromEntries(days.map((d) => [d, 0])), total: 0, waiting: 0, refused: 0 }));
	const byId = Object.fromEntries(rows.map((r) => [r.person.id, r]));
	(entries || []).forEach((e) => {
		const row = byId[e.member_id];
		if (!row || e.deleted_at || !(e.day in row.days)) return;
		const minutes = Math.round((+e.seconds || 0) / 60);
		row.days[e.day] += minutes;
		row.total += minutes;
		if (e.main_error) row.refused += 1;
		else if (!e.main_synced_at || e.updated_at > e.main_synced_at) row.waiting += 1;
	});
	return { days, rows };
}
