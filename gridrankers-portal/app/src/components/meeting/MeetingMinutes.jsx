import { useState } from 'react';
import { usePortal } from '../../context.js';
import { cycleFill, cycleRange, daysBetween } from '../../lib/cycles.js';
import { localYmd, short } from '../../lib/format.js';
import { assigneesOf, searchText, sortOpen } from '../../lib/tasks.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import CycleBar from '../CycleBar.jsx';
import TaskCard from './TaskCard.jsx';
import TaskDialog from './TaskDialog.jsx';
import TaskDetails from './TaskDetails.jsx';
import useTaskActions from './useTaskActions.js';

// A meeting task belongs to the cycle containing its meeting date (or created date).
export const taskCycleDate = (t) => t.meeting_date || localYmd(t.created_at);

function UrgentBanner({ items, onOpen }) {
	const { data, today } = usePortal();
	const { setStatus } = useTaskActions();
	const [open, setOpen] = useState(false);
	const members = data.members;
	if (!items.length) return null;
	const urgent = items.filter((i) => i.status !== 'done' && i.priority === 'urgent').sort(sortOpen);
	const openCount = items.filter((i) => i.status !== 'done').length;
	if (!urgent.length) {
		return (
			<section className="alert calm">
				<span className="a-ico" aria-hidden="true">
					✓
				</span>
				<strong>Nothing urgent.</strong>
				<span>
					{openCount} {openCount === 1 ? 'task' : 'tasks'} still open.
				</span>
			</section>
		);
	}
	const who = (i) => assigneesOf(i, members).map((a) => members[a.id].name).join(', ');
	const byPerson = new Map();
	urgent.forEach((i) => byPerson.set(who(i) || 'Unassigned', (byPerson.get(who(i) || 'Unassigned') || 0) + 1));
	const unassigned = urgent.filter((i) => !who(i)).length;
	return (
		<details className="alert" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
			<summary>
				<span className="a-ico" aria-hidden="true">
					!
				</span>
				<span className="a-head">
					<strong>
						{urgent.length} urgent {urgent.length === 1 ? 'fix needs' : 'fixes need'} attention
					</strong>
					<span className="a-sub">{[...byPerson].map(([k, v]) => `${k} ${v}`).join(' · ')}</span>
				</span>
				<span className="a-stats">
					<span>
						<b>{urgent.length}</b> urgent
					</span>
					<span>
						<b>{openCount}</b> open
					</span>
					{unassigned > 0 && (
						<span>
							<b>{unassigned}</b> unassigned
						</span>
					)}
				</span>
				<span className="a-tog">{open ? 'Hide' : 'Show'}</span>
			</summary>
			<ul className="a-list">
				{urgent.map((i) => {
					const first = assigneesOf(i, members)[0];
					return (
						<li key={i.id}>
							<Avatar person={first ? members[first.id] : null} />
							<div className="a-main">
								<strong>{i.title}</strong>
								<span>
									{i.status === 'doing' ? 'In progress' : 'Not started'} · {who(i) || <em>Unassigned</em>}
								</span>
							</div>
							<span className="a-age">{Math.max(0, daysBetween(localYmd(i.created_at), today))}d</span>
							<button className="btn small a-done" onClick={() => setStatus(i, 'done')}>
								Mark completed
							</button>
							<button className="btn small" onClick={() => onOpen(i.id)}>
								Open
							</button>
						</li>
					);
				})}
			</ul>
		</details>
	);
}

const FILTERS = [
	['all', 'All', 't-all'],
	['todo', 'Not started', 't-todo'],
	['doing', 'In progress', 't-doing'],
	['done', 'Completed', 't-done'],
	['urgent', 'Urgent', 't-late'],
];

// Meeting Minutes (SPEC.md 7.2): banner, project cycle bar, stats, cards, "+ Add task".
export default function MeetingMinutes() {
	const { data, project, search, cycleOff, today } = usePortal();
	const [filter, setFilter] = useState('all');
	const [dialog, setDialog] = useState(null);
	const p = data.projects[project];
	if (!p) return null;

	const P = cycleRange(p, cycleOff, today);
	const q = search.trim().toLowerCase();
	const members = data.members;
	const items = rowsOf(data, 'meeting_tasks').filter((t) => {
		if (t.project_id !== p.id) return false;
		const d = taskCycleDate(t);
		if (d < P.start || d > P.end) return false;
		if (!q) return true;
		return searchText([t.title, t.notes, t.url, ...assigneesOf(t, members).map((a) => members[a.id].name)]).includes(q);
	});

	const cnt = { todo: 0, doing: 0, done: 0 };
	items.forEach((i) => (cnt[i.status] = (cnt[i.status] || 0) + 1));
	const urgent = items.filter((i) => i.status !== 'done' && i.priority === 'urgent').length;
	const pass = (i) => filter === 'all' || (filter === 'urgent' ? i.status !== 'done' && i.priority === 'urgent' : i.status === filter);
	const list = items
		.filter(pass)
		.sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.status === 'done' ? String(b.done_at || '').localeCompare(String(a.done_at || '')) : sortOpen(a, b)));
	const num = { all: items.length, todo: cnt.todo, doing: cnt.doing, done: cnt.done, urgent };

	const past = P.end < today;
	const future = P.start > today;
	const left = Math.max(0, daysBetween(today, P.end));
	const fill = cycleFill(P, today);
	const tone = past ? 'past' : future ? 'up' : left <= 3 ? 'hot' : left <= 7 ? 'warm' : '';

	return (
		<>
			<UrgentBanner items={items} onOpen={(id) => setDialog({ type: 'details', id })} />
			<CycleBar project={p} />
			{items.length > 0 && (
				<section className="stats2" aria-label="Board statistics">
					<div className="s-tiles">
						<div className="segs" role="tablist" aria-label="Filter by status">
							{FILTERS.map(([key, label, cls]) => (
								<button
									key={key}
									className={`sg ${cls} ${key === 'urgent' && num.urgent ? 'hot' : ''}`}
									role="tab"
									aria-selected={filter === key}
									aria-pressed={filter === key}
									onClick={() => setFilter(filter === key && key !== 'all' ? 'all' : key)}
								>
									<span className="sg-dot" />
									{label}
									<span className="sg-n">{num[key]}</span>
								</button>
							))}
						</div>
					</div>
					<div className="s-dates">
						<div className="segs dates" aria-label="Cycle dates">
							<span className="dt" title="Cycle starts">
								<span className="dt-v">{short(P.start)}</span>
							</span>
							<span className="dt-arr" aria-hidden="true">
								→
							</span>
							<span className="dt" title="Cycle ends">
								<span className="dt-v">{short(P.end)}</span>
							</span>
						</div>
					</div>
					<div className="s-bar">
						<span className="s-k">Cycle progress</span>
						<span className="s-track now" title={`${fill}% of the cycle has passed`}>
							<i style={{ width: fill + '%' }} />
						</span>
					</div>
					<div className="s-left">
						<div className={'sl ' + tone}>
							<span className="s-k">{past ? 'Cycle' : future ? 'Starts in' : 'Days left'}</span>
							<div className="sl-big">
								{past ? (
									<strong>Ended</strong>
								) : future ? (
									<>
										<strong>{daysBetween(today, P.start)}</strong>
										<span>days</span>
									</>
								) : (
									<>
										<strong>{left === 0 ? 'Last' : left}</strong>
										<span>{left <= 1 ? 'day' : 'days'}</span>
									</>
								)}
							</div>
						</div>
					</div>
				</section>
			)}
			<div className="mcards">
				{list.map((t) => (
					<TaskCard key={t.id} task={t} onDetails={(id) => setDialog({ type: 'details', id })} onEdit={(id) => setDialog({ type: 'edit', id })} />
				))}
				<button type="button" className="card add-card" aria-label="Add task" onClick={() => setDialog({ type: 'edit', id: null })}>
					<span className="plus" aria-hidden="true">
						+
					</span>
					<b>Add task</b>
					<small>{items.length ? 'A new fix or change for this site' : cycleOff ? 'No meeting tasks in this cycle' : 'Add the first fix for this cycle'}</small>
				</button>
			</div>
			{dialog && dialog.type === 'edit' && <TaskDialog taskId={dialog.id} onClose={() => setDialog(null)} />}
			{dialog && dialog.type === 'details' && <TaskDetails taskId={dialog.id} onClose={() => setDialog(null)} />}
		</>
	);
}
