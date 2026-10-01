import { useCallback, useEffect, useState } from 'react';
import { usePortal } from '../context.js';
import { dateTime, localYmd, longDate, toDate } from '../lib/format.js';
import { ROLE, isManager } from '../lib/roles.js';
import { rowsOf } from '../lib/store.js';

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

// "Recently deleted" (admin/lead): restore puts it back exactly where it was.
function Trash() {
	const { api, data, dispatch, toast, confirm } = usePortal();
	const [all, setAll] = useState(false);
	const list = rowsOf(data, 'trash').sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
	if (!list.length) return null;
	const show = all ? list : list.slice(0, 5);
	const name = (id) => (data.members[id] ? data.members[id].name : '');

	const restore = async (e) => {
		try {
			const row = await api.post(`trash/${e.id}/restore`);
			dispatch({ type: 'upsert', table: TRASH_TABLE[e.type], row });
			dispatch({ type: 'remove', table: 'trash', id: e.id });
			toast(`“${e.title || 'Task'}” restored`);
		} catch (err) {
			toast(err.message);
		}
	};
	const purge = async (e) => {
		const ok = await confirm({ title: 'Delete forever?', message: `“${e.title || 'Untitled'}” can't be restored after this.`, ok: 'Delete forever', danger: true });
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
				<span className="s-k">Recently deleted</span>
				<span className="muted">Kept 30 days · restore puts a task back exactly where it was</span>
			</div>
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
									{e.type === 'grp_projects' ? 'Project' : project ? project.name : 'Project removed'} · deleted {dateTime(e.deleted_at)}
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

// Recent Activities (SPEC.md 7.4): recently deleted, then a dated log of changes.
export default function RecentActivities() {
	const { api, data, me, project } = usePortal();
	const [rows, setRows] = useState(null);
	const [error, setError] = useState('');

	const load = useCallback(() => {
		if (document.hidden) return;
		api
			.get('audit', { project })
			.then((r) => {
				setRows(r);
				setError('');
			})
			.catch((e) => setError(e.message));
	}, [api, project]);

	useEffect(() => {
		load();
		const t = setInterval(load, 10000);
		return () => clearInterval(t);
	}, [load]);

	const groups = [];
	(rows || []).forEach((x) => {
		const day = localYmd(x.at);
		const g = groups[groups.length - 1];
		if (g && g.day === day) g.list.push(x);
		else groups.push({ day, list: [x] });
	});
	const name = (id) => (data.members[id] ? data.members[id].name : 'Someone');
	const projectName = (id) => (data.projects[id] ? data.projects[id].name : '—');

	return (
		<>
			{isManager(me) && <Trash />}
			{error && <p className="err">{error}</p>}
			{rows && !rows.length && <p className="empty">Nothing yet. Completed tasks, edits, deletions and cycle changes are all logged here by date.</p>}
			{groups.length > 0 && (
				<div className="log">
					{groups.map((g) => (
						<div key={g.day}>
							<h2>{longDate(g.day)}</h2>
							<ul>
								{g.list.map((x) => (
									<li key={x.id} className={x.kind === 'cycle' ? 'lg-cyc' : `lg-ev lg-${x.kind}`}>
										<span className="c">{projectName(x.project_id)}</span>
										<span className="t">
											<span className={`lg-tag lgk-${x.kind}`}>{TAG[x.kind] || 'Changed'}</span> {x.title || 'Untitled'} {x.type && <span className="lg-type">{TYPE_LABEL[x.type] || x.type}</span>}
											<small>
												{name(x.by_member)}
												{x.by_role && x.by_role !== 'member' ? ` (${ROLE[x.by_role]})` : ''} · {toDate(x.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
												{x.detail ? ' · ' + x.detail : ''}
												{x.changes && x.changes.length ? ' · ' + x.changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join('  ·  ') : ''}
											</small>
										</span>
									</li>
								))}
							</ul>
						</div>
					))}
				</div>
			)}
		</>
	);
}
