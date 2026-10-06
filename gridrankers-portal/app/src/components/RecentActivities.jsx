import { useCallback, useEffect, useState } from 'react';
import { usePortal } from '../context.js';
import { addDays } from '../lib/cycles.js';
import { dateTime, localYmd, toDate } from '../lib/format.js';
import Avatar from './Avatar.jsx';
import Modal from './Modal.jsx';
import { ROLE, isManager } from '../lib/roles.js';
import { rowsOf } from '../lib/store.js';
import { GENERAL, GENERAL_NAME } from '../lib/tasks.js';

const TAG = {
	add: 'Added',
	edit: 'Changed',
	status: 'Status',
	progress: 'Progress',
	done: 'Completed',
	assign: 'Assigned',
	delete: 'Deleted',
	restore: 'Restored',
	review: 'Review',
	project: 'Project',
	cycle: 'Cycle change',
	import: 'Import',
};
const TYPE_LABEL = { client: 'project', monthly: 'monthly task', items: 'meeting task', team: 'team' };
const TRASH_TABLE = { grp_meeting_tasks: 'meeting_tasks', grp_monthly_tasks: 'monthly_tasks', grp_projects: 'projects' };
const TRASH_TAG = { grp_meeting_tasks: ['board', 'Meeting'], grp_monthly_tasks: ['monthly', 'Recurring'], grp_projects: ['board', 'Project'] };

// "Recently deleted" (admin/lead): restore puts it back exactly where it was. Recent Activities
// shows the selected project's tasks; the Dashboard shows deleted projects (SPEC.md 7.0, 7.4).
export function Trash({ entries, title = 'Recently deleted', hint = 'Kept 30 days · restore puts a task back exactly where it was', empty = '' }) {
	const { api, data, dispatch, toast, confirm } = usePortal();
	const [all, setAll] = useState(false);
	const list = [...entries].sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
	if (!list.length && !empty) return null;
	const show = all ? list : list.slice(0, 5);
	const name = (id) => (data.members[id] ? data.members[id].name : '');

	const restore = async (e) => {
		try {
			const row = await api.post(`trash/${e.id}/restore`);
			dispatch({ type: 'upsert', table: TRASH_TABLE[e.type], row });
			dispatch({ type: 'remove', table: 'trash', id: e.id });
			if (e.type === 'grp_projects') {
				// Its tasks came back with it: show them now, not at the next sync.
				for (const table of ['meeting_tasks', 'monthly_tasks']) {
					api
						.get(table.replace('_', '-'), { project: row.id })
						.then((rows) => rows.forEach((r) => dispatch({ type: 'upsert', table, row: r })))
						.catch(() => {});
				}
				rowsOf(data, 'trash')
					.filter((x) => x.project_id === row.id && x.with_project)
					.forEach((x) => dispatch({ type: 'remove', table: 'trash', id: x.id }));
			}
			toast(`“${e.title || 'Task'}” restored${e.type === 'grp_projects' ? ' with its tasks' : ''}`);
		} catch (err) {
			toast(err.message);
		}
	};
	const purge = async (e) => {
		const message = e.type === 'grp_projects' ? `“${e.title || 'Untitled'}” and its deleted tasks can't be restored after this.` : `“${e.title || 'Untitled'}” can't be restored after this.`;
		const ok = await confirm({ title: 'Delete forever?', message, ok: 'Delete forever', danger: true });
		if (!ok) return;
		try {
			await api.del(`trash/${e.id}`);
			dispatch({ type: 'remove', table: 'trash', id: e.id });
			toast('Deleted forever');
		} catch (err) {
			toast(err.message);
		}
	};

	return (
		<section className="dcard tr-card">
			<div className="dc-head">
				<span className="s-k">{title}</span>
				<span className="muted">{hint}</span>
			</div>
			{!list.length && <p className="hint">{empty}</p>}
			<ul className="tr-list">
				{show.map((e) => {
					const [cls, label] = TRASH_TAG[e.type] || ['board', 'Item'];
					const project = data.projects[e.project_id];
					return (
						<li key={e.id}>
							<span className={'as-tag at-' + cls}>{label}</span>
							<div className="as-main">
								<b>{e.title || 'Untitled'}</b>
								<span>
									{e.type === 'grp_projects' ? 'Project' : project ? project.name : e.project_id === GENERAL ? GENERAL_NAME : 'Project removed'} · deleted {dateTime(e.deleted_at)}
									{name(e.deleted_by) ? ' by ' + name(e.deleted_by) : ''}
								</span>
							</div>
							<button type="button" className="btn small primary" onClick={() => restore(e)}>
								Restore
							</button>
							<button type="button" className="linkbtn danger" onClick={() => purge(e)}>
								Delete forever
							</button>
						</li>
					);
				})}
			</ul>
			{list.length > 5 && (
				<button type="button" className="linkbtn nt-more" onClick={() => setAll(!all)}>
					{all ? 'Show less' : `Show all ${list.length}`}
				</button>
			)}
		</section>
	);
}

const FILTERS = [
	['all', 'All'],
	['add', 'Added'],
	['done', 'Completed'],
	['review', 'Reviews'],
	['other', 'Changes'],
];
const inFilter = (kind, f) => f === 'all' || (f === 'other' ? !['add', 'done', 'review'].includes(kind) : kind === f);

// "Today · 2:41 PM", "Yesterday · 9:00 AM", "Sep 28 · 5:20 PM".
export function whenText(at, today) {
	const day = localYmd(at);
	const time = toDate(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	const label = day === today ? 'Today' : day === addDays(today, -1) ? 'Yesterday' : toDate(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	return `${label} · ${time}`;
}

// Recent Activities (SPEC.md 7.4), for the selected project (or the General tasks, SPEC.md 6.13,
// with `general`): one row per change, filters, and recently deleted tasks behind a button.
export default function RecentActivities({ general = false }) {
	const { api, data, me, project: selected, today } = usePortal();
	const project = general ? GENERAL : selected;
	const [rows, setRows] = useState(null);
	const [error, setError] = useState('');
	const [filter, setFilter] = useState('all');
	const [trashOpen, setTrashOpen] = useState(false);

	const load = useCallback(() => {
		if (document.hidden) return;
		api
			.get('audit', general ? { general: 1 } : { project })
			.then((r) => {
				setRows(r);
				setError('');
			})
			.catch((e) => setError(e.message));
	}, [api, project, general]);

	useEffect(() => {
		load();
		const t = setInterval(load, 10000);
		return () => clearInterval(t);
	}, [load]);

	const deleted = rowsOf(data, 'trash').filter((e) => e.project_id === project && e.type !== 'grp_projects');
	const list = (rows || []).filter((x) => inFilter(x.kind, filter));
	const details = (x) => [x.detail, ...(x.changes || []).map((c) => `${c.label}: ${c.from} → ${c.to}`)].filter(Boolean).join(' · ');

	return (
		<div className="ra">
			<div className="ra-bar">
				<div className="ra-chips" role="group" aria-label="Show">
					{FILTERS.map(([k, l]) => (
						<button key={k} type="button" className="ra-chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
							{l}
						</button>
					))}
				</div>
				{isManager(me) && (
					<button type="button" className="ra-trash" onClick={() => setTrashOpen(true)}>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
							<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
						</svg>
						Recently deleted <span className="ra-n">{deleted.length}</span>
					</button>
				)}
			</div>
			{error && <p className="err">{error}</p>}
			{rows && !rows.length && <p className="empty">Nothing yet. Added and completed tasks, reviews, edits, deletions and cycle changes are all listed here.</p>}
			{rows && rows.length > 0 && !list.length && <p className="empty">Nothing of this kind yet.</p>}
			{list.length > 0 && (
				<div className="ra-table" role="table" aria-label="Recent activities">
					<div className="ra-row ra-headrow" role="row">
						<span role="columnheader">When</span>
						<span role="columnheader">What</span>
						<span role="columnheader">Task</span>
						<span role="columnheader">Who</span>
						<span role="columnheader">Details</span>
					</div>
					{list.map((x) => {
						const who = data.members[x.by_member];
						const d = details(x);
						return (
							<div key={x.id} className="ra-row" role="row">
								<span role="cell" className="ra-when">
									{whenText(x.at, today)}
								</span>
								<span role="cell">
									<span className={`lg-tag lgk-${x.kind}`}>{TAG[x.kind] || 'Changed'}</span>
								</span>
								<span role="cell" className="ra-task" title={x.title || ''}>
									{x.title || 'Untitled'}
									{x.type && <small>{TYPE_LABEL[x.type] || x.type}</small>}
								</span>
								<span role="cell" className="ra-who" title={x.by_role && x.by_role !== 'member' ? ROLE[x.by_role] : undefined}>
									<Avatar person={who} small />
									{who ? who.name : 'Someone'}
								</span>
								<span role="cell" className="ra-det" title={d}>
									{d || '—'}
								</span>
							</div>
						);
					})}
				</div>
			)}
			{isManager(me) && (
				<Modal open={trashOpen} onClose={() => setTrashOpen(false)} className="ra-trash-dlg" labelledBy="grpRaTrash">
					<form method="dialog" onSubmit={(e) => (e.preventDefault(), setTrashOpen(false))}>
						<h2 id="grpRaTrash">Recently deleted</h2>
						<Trash entries={deleted} title="This project's deleted tasks" empty="Nothing deleted in the last 30 days." />
						<div className="dlg-acts">
							<button type="submit" className="btn primary">
								Close
							</button>
						</div>
					</form>
				</Modal>
			)}
		</div>
	);
}
