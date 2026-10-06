import { useState } from 'react';
import { usePortal } from '../../context.js';
import { deadlineInfo } from '../../lib/deadline.js';
import { isManager } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import { GENERAL_NAME, assigneesOf, isAssigned, isGeneral, searchText, sortOpen } from '../../lib/tasks.js';
import RecentActivities from '../RecentActivities.jsx';
import TaskCard from '../meeting/TaskCard.jsx';
import TaskDetails from '../meeting/TaskDetails.jsx';
import TaskDialog from '../meeting/TaskDialog.jsx';

const FILTERS = [
	['all', 'All'],
	['mine', 'Mine'],
	['todo', 'Not started'],
	['doing', 'In progress'],
	['done', 'Completed'],
	['late', 'Overdue'],
];

// The tasks on the General tasks board, open first (most urgent), then the finished ones.
export function generalTasks(data) {
	return rowsOf(data, 'meeting_tasks')
		.filter(isGeneral)
		.sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.status === 'done' ? String(b.done_at || '').localeCompare(String(a.done_at || '')) : sortOpen(a, b)));
}

// General tasks (SPEC.md 6.13, design GT-A): work that isn't part of any project — the same task
// cards as Meeting Minutes, without a project or cycle. Tabs: Tasks · Recent Activities.
export default function GeneralTasks() {
	const { data, me, search, today } = usePortal();
	const [tab, setTab] = useState('tasks');
	const [filter, setFilter] = useState('all');
	const [dialog, setDialog] = useState(null);
	const members = data.members;
	const q = search.trim().toLowerCase();
	const all = generalTasks(data).filter((t) => !q || searchText([t.title, t.notes, t.url, ...assigneesOf(t, members).map((a) => members[a.id].name)]).includes(q));
	const late = (t) => !!(deadlineInfo(t, today) || {}).overdue;
	const test = { all: () => true, mine: (t) => isAssigned(t, me.id), todo: (t) => t.status === 'todo', doing: (t) => t.status === 'doing', done: (t) => t.status === 'done', late };
	const num = Object.fromEntries(FILTERS.map(([k]) => [k, all.filter(test[k]).length]));
	const list = all.filter(test[filter]);
	const lead = isManager(me);

	return (
		<div className="gt">
			<section className="gt-head">
				<span className="gt-ic" aria-hidden="true">
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						<rect x="4" y="4" width="16" height="16" rx="3" />
						<path d="M8 9h8M8 13h8M8 17h5" />
					</svg>
				</span>
				<div>
					<h2>{GENERAL_NAME}</h2>
					<p className="muted">Work that isn’t part of any project — training, office, our own website, reports</p>
				</div>
				{lead && tab === 'tasks' && (
					<button type="button" className="btn primary" onClick={() => setDialog({ type: 'edit', id: null })}>
						+ Add task
					</button>
				)}
			</section>
			<div className="tabs gt-tabs" role="tablist" aria-label="General tasks">
				<button type="button" role="tab" aria-selected={tab === 'tasks'} onClick={() => setTab('tasks')}>
					Tasks
				</button>
				<button type="button" role="tab" aria-selected={tab === 'log'} onClick={() => setTab('log')}>
					Recent Activities
				</button>
			</div>
			{tab === 'log' ? (
				<RecentActivities general />
			) : (
				<>
					<div className="nf-chips gt-chips" role="group" aria-label="Show">
						{FILTERS.map(([k, label]) => (
							<button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
								{label} {num[k] > 0 && <span>{num[k]}</span>}
							</button>
						))}
					</div>
					<div className="mcards">
						{lead && filter === 'all' && (
							<button type="button" className="card add-card" aria-label="Add general task" onClick={() => setDialog({ type: 'edit', id: null })}>
								<span className="plus" aria-hidden="true">
									+
								</span>
								<b>Add general task</b>
								<small>Not part of any project</small>
							</button>
						)}
						{list.map((t) => (
							<TaskCard key={t.id} task={t} onDetails={(id) => setDialog({ type: 'details', id })} onEdit={(id) => setDialog({ type: 'edit', id })} />
						))}
					</div>
					{list.length === 0 && !(lead && filter === 'all') && <p className="empty">{filter === 'all' ? 'No general tasks yet. A Team Leader or the Super Admin adds them.' : 'Nothing here.'}</p>}
				</>
			)}
			{dialog && dialog.type === 'edit' && <TaskDialog taskId={dialog.id} general onClose={() => setDialog(null)} />}
			{dialog && dialog.type === 'details' && <TaskDetails taskId={dialog.id} onClose={() => setDialog(null)} />}
		</div>
	);
}
