import { rowsOf } from './store.js';
import { boardOf, isGeneral, liveTask } from './tasks.js';

// Work waiting for a reviewer (reference pendingReviews), oldest first.
export function pendingReviews(data) {
	const out = [];
	rowsOf(data, 'meeting_tasks').forEach((t) => {
		if (t.review && t.review.state === 'pending' && liveTask(data, t)) {
			out.push({ kind: 'item', id: t.id, title: t.title, project_id: t.project_id, review: t.review, completion: t.completion, where: t.target > 1 ? `${t.target}/${t.target}` : isGeneral(t) ? 'General task' : 'Meeting task', tab: boardOf(t) });
		}
	});
	rowsOf(data, 'records').forEach((r) => {
		const t = data.monthly_tasks[r.task_id];
		if (r.review && r.review.state === 'pending' && t && data.projects[t.project_id]) {
			out.push({ kind: 'record', id: r.id, title: t.title, project_id: t.project_id, review: r.review, completion: r.completion, where: `${r.week ? `Week ${r.week}` : 'Monthly'}${t.target > 1 ? ` · ${r.count}/${t.target}` : ''}`, tab: 'monthly' });
		}
	});
	return out.sort((a, b) => String(a.review.submittedAt).localeCompare(String(b.review.submittedAt)));
}

// Whether `me` may decide a pending review: work someone asked a particular person to review
// belongs to that person (and the Super Admin); other pending work to reviewers.
export const mayDecide = (r, me) => (r.review.reviewer ? r.review.reviewer === me.id || me.role === 'admin' : me.role === 'admin' || me.role === 'lead');

// A member's reviewed work that wasn't simply accepted, in the last 30 days, newest first.
export function reviewsOf(data, memberId, now = Date.now()) {
	const since = now - 30 * 86400000;
	const recent = (rv) => rv && rv.submittedBy === memberId && rv.state !== 'accepted' && new Date(rv.at || rv.submittedAt).getTime() > since;
	const out = [];
	rowsOf(data, 'meeting_tasks').forEach((t) => recent(t.review) && liveTask(data, t) && out.push({ title: t.title, project_id: t.project_id, review: t.review, tab: boardOf(t) }));
	rowsOf(data, 'records').forEach((r) => {
		const t = data.monthly_tasks[r.task_id];
		if (recent(r.review) && t && data.projects[t.project_id]) out.push({ title: t.title, project_id: t.project_id, review: r.review, tab: 'monthly', where: r.week ? `Week ${r.week}` : 'This cycle' });
	});
	return out.sort((a, b) => String(b.review.at || b.review.submittedAt).localeCompare(String(a.review.at || a.review.submittedAt)));
}
