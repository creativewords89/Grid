// Submission comments and who may edit or comment (SPEC.md 6.6, design SF-B). The server checks again.
import { isAssigned } from './tasks.js';
import { isManager } from './roles.js';
import { rowsOf } from './store.js';

export const commentsOf = (data, kind, id) =>
	rowsOf(data, 'comments')
		.filter((c) => c.ref_kind === kind && c.ref_id === id)
		.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

// Same as GRP_Permissions::EDIT_SUBMISSION: who submitted it, or a Team Leader / the Super Admin.
export const canEditSubmission = (me, completion) => !!me && !!completion && (isManager(me) || completion.by === me.id);

// Same as GRP_Permissions::COMMENT: managers, the task's people, who submitted it and the reviewer.
export function canComment(me, task, row) {
	if (!me) return false;
	if (isManager(me)) return true;
	const c = (row && row.completion) || {};
	const r = (row && row.review) || {};
	return (!!task && isAssigned(task, me.id)) || c.by === me.id || r.reviewer === me.id || r.submittedBy === me.id;
}

const DAY = 24 * 60 * 60 * 1000;

// Bell items (6.9): comments from others in the last 7 days on submissions I'm part of — mine,
// tasks assigned to me, reviews asked of me, or threads I commented in.
export function commentBell(data, me, now = Date.now()) {
	const all = rowsOf(data, 'comments').filter((c) => !c.deleted_at);
	const out = [];
	all.forEach((c) => {
		if (c.created_by === me.id || now - Date.parse(String(c.created_at).replace(' ', 'T') + 'Z') > 7 * DAY) return;
		let row = null;
		let task = null;
		if (c.ref_kind === 'item') {
			row = data.meeting_tasks[c.ref_id];
			task = row;
		} else {
			row = data.records[c.ref_id];
			task = row && data.monthly_tasks[row.task_id];
		}
		if (!row || !task) return;
		const comp = row.completion || {};
		const rv = row.review || {};
		const mine = comp.by === me.id || rv.reviewer === me.id || isAssigned(task, me.id) || all.some((o) => o.ref_id === c.ref_id && o.created_by === me.id);
		if (!mine) return;
		const who = data.members[c.created_by];
		out.push({ key: `cm:${c.id}`, text: `${who ? who.name : 'Someone'} commented on “${task.title}”`, sub: c.body || ((c.files || []).length ? `📎 ${c.files.map((f) => f.name).join(', ')}` : '') });
	});
	return out;
}
