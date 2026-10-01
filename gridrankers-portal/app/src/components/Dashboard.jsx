import { useMemo, useState } from 'react';
import { usePortal } from '../context.js';
import { activeWeek, cycleRange, daysBetween, isWeekly } from '../lib/cycles.js';
import { deadlineInfo } from '../lib/deadline.js';
import { short, toDate } from '../lib/format.js';
import { computeMissed, isWaived, recordOf, stateOf } from '../lib/monthly.js';
import { pendingReviews } from '../lib/reviews.js';
import { isAdmin, isManager } from '../lib/roles.js';
import { rowsOf } from '../lib/store.js';
import { searchText } from '../lib/tasks.js';
import Modal from './Modal.jsx';
import { Trash } from './RecentActivities.jsx';

const STATES = [
	['active', 'Active'],
	['paused', 'Paused'],
	['inactive', 'Inactive'],
];
const LABEL = Object.fromEntries(STATES);
const ORDER = { active: 0, paused: 1, inactive: 2 };

// "Updated 2 h ago" from a UTC 'YYYY-MM-DD HH:MM:SS' timestamp.
export function ago(ts, now = Date.now()) {
	const d = toDate(ts);
	if (!d) return '';
	const min = Math.max(0, Math.round((now - d.getTime()) / 60000));
	if (min < 1) return 'just now';
	if (min < 60) return `${min} min ago`;
	const h = Math.round(min / 60);
	if (h < 24) return `${h} h ago`;
	const days = Math.round(h / 24);
	return days < 30 ? `${days} day${days === 1 ? '' : 's'} ago` : `on ${short(ts.slice(0, 10))}`;
}

// Everything a project card shows, from data the app already syncs.
export function projectSummary(p, data, reviews, today) {
	const tasks = rowsOf(data, 'meeting_tasks').filter((t) => t.project_id === p.id);
	const monthly = rowsOf(data, 'monthly_tasks').filter((t) => t.project_id === p.id);
	const open = tasks.filter((t) => t.status !== 'done');
	const counted = monthly.filter((t) => !isWaived(t, p, 0, today));
	const mDone = counted.filter((t) => stateOf(t, recordOf(data.records, t, p, isWeekly(t) ? activeWeek(p, 0, today) : undefined, 0, today)) === 'done').length;
	const overdue = open.filter((t) => (deadlineInfo(t, today) || {}).overdue).length + computeMissed(monthly, data.projects, data.records, today).length;
	const stamps = [p.updated_at, ...tasks.map((t) => t.updated_at), ...monthly.map((t) => t.updated_at), ...rowsOf(data, 'records').filter((r) => r.project_id === p.id).map((r) => r.updated_at)];
	const P = p.cycle_set ? cycleRange(p, 0, today) : null;
	return {
		open: open.length,
		urgent: open.filter((t) => t.priority === 'urgent').length,
		mDone,
		mTotal: counted.length,
		reviews: reviews.filter((r) => r.project_id === p.id).length,
		overdue,
		updated: stamps.filter(Boolean).sort().pop() || '',
		cycle: P && { day: P.day || p.cycle_day, end: P.end, left: Math.max(0, daysBetween(today, P.end)) },
	};
}

function NewProjectDialog({ open, onClose }) {
	const { api, dispatch, toast } = usePortal();
	const [name, setName] = useState('');
	const [day, setDay] = useState('');
	const [state, setState] = useState('active');
	const [error, setError] = useState('');

	const submit = async (e) => {
		e.preventDefault();
		if (!name.trim()) return setError('Enter a project name.');
		try {
			const row = await api.post('projects', { name: name.trim(), state, ...(day ? { cycle_day: +day } : {}) });
			dispatch({ type: 'upsert', table: 'projects', row });
			// Its standard monthly tasks were created with it: show them now, not at the next sync.
			api
				.get('monthly-tasks', { project: row.id })
				.then((tasks) => tasks.forEach((t) => dispatch({ type: 'upsert', table: 'monthly_tasks', row: t })))
				.catch(() => {});
			toast(`${row.name} added`);
			setName('');
			setDay('');
			setState('active');
			setError('');
			onClose();
		} catch (err) {
			setError(err.message);
		}
	};

	return (
		<Modal open={open} onClose={onClose} labelledBy="grpNewProject">
			<form onSubmit={submit} noValidate>
				<h2 id="grpNewProject">New project</h2>
				<label>
					Project name
					<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Acme Plumbing" required autoFocus />
				</label>
				<div className="row">
					<label>
						Cycle start day
						<select value={day} onChange={(e) => setDay(e.target.value)} aria-label="Cycle start day">
							<option value="">Pick later</option>
							{Array.from({ length: 28 }, (_, i) => (
								<option key={i + 1} value={i + 1}>
									{i + 1}
								</option>
							))}
						</select>
					</label>
					<label>
						Status
						<select value={state} onChange={(e) => setState(e.target.value)} aria-label="Status">
							{STATES.map(([k, l]) => (
								<option key={k} value={k}>
									{l}
								</option>
							))}
						</select>
					</label>
				</div>
				<p className="hint">The start day locks once chosen; after that only the Super Admin can change it.</p>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						Add project
					</button>
				</div>
			</form>
		</Modal>
	);
}

function ProjectCard({ p, s }) {
	const { api, data, dispatch, me, setProject, setView, toast, confirm } = usePortal();

	const open = () => {
		setProject(p.id);
		setView('board');
	};
	const move = async (to) => {
		if (to === p.state) return;
		dispatch({ type: 'upsert', table: 'projects', row: { ...p, state: to } });
		try {
			const row = await api.patch(`projects/${p.id}/state`, { state: to });
			dispatch({ type: 'upsert', table: 'projects', row });
			toast(`${p.name} moved to ${LABEL[to]}`);
		} catch (err) {
			dispatch({ type: 'upsert', table: 'projects', row: p });
			toast(err.message);
		}
	};
	const remove = async () => {
		const tasks = rowsOf(data, 'meeting_tasks').filter((t) => t.project_id === p.id);
		const monthly = rowsOf(data, 'monthly_tasks').filter((t) => t.project_id === p.id);
		const n = tasks.length + monthly.length;
		const ok = await confirm({
			title: `Delete ${p.name}?`,
			message: `${n ? `Its ${n} task${n === 1 ? '' : 's'} will be deleted too. ` : ''}It stays in Recently deleted projects for 30 days, and restoring it brings its tasks back.`,
			ok: 'Delete project',
			danger: true,
		});
		if (!ok) return;
		try {
			const res = await api.del(`projects/${p.id}`);
			dispatch({ type: 'remove', table: 'projects', id: p.id });
			(res.trash || []).forEach((row) => dispatch({ type: 'upsert', table: 'trash', row }));
			tasks.forEach((t) => dispatch({ type: 'remove', table: 'meeting_tasks', id: t.id }));
			monthly.forEach((t) => dispatch({ type: 'remove', table: 'monthly_tasks', id: t.id }));
			toast(`${p.name} deleted`);
		} catch (err) {
			toast(err.message);
		}
	};

	return (
		<article className={`pd-card st-${p.state}`}>
			<button type="button" className="pd-open" onClick={open} aria-label={`Open ${p.name}`}>
				<span className="pd-head">
					<b className="pd-name">{p.name}</b>
					<span className={`pd-state ps-${p.state}`}>{LABEL[p.state]}</span>
				</span>
				<span className="pd-cycle">
					{s.cycle ? (
						<>
							Starts day {s.cycle.day} · ends {short(s.cycle.end)} · {s.cycle.left} day{s.cycle.left === 1 ? '' : 's'} left
						</>
					) : (
						'No cycle start day yet'
					)}
				</span>
				<span className="pd-stats">
					<span className={s.urgent ? 'pd-hot' : ''} title="Open meeting tasks">
						<b>{s.open}</b> open{s.urgent ? ` · ${s.urgent} urgent` : ''}
					</span>
					<span title="Monthly tasks done this cycle">
						<b>
							{s.mDone}/{s.mTotal}
						</b>{' '}
						monthly
					</span>
					<span className={s.reviews ? 'pd-warm' : ''} title="Waiting for review">
						<b>{s.reviews}</b> to review
					</span>
					<span className={s.overdue ? 'pd-hot' : ''} title="Overdue meeting tasks and missed monthly periods">
						<b>{s.overdue}</b> overdue
					</span>
				</span>
				<span className="pd-upd">{s.updated ? `Updated ${ago(s.updated)}` : 'No activity yet'}</span>
			</button>
			{isManager(me) && (
				<div className="pd-acts">
					<select value={p.state} onChange={(e) => move(e.target.value)} aria-label={`Status of ${p.name}`}>
						{STATES.map(([k, l]) => (
							<option key={k} value={k}>
								{l}
							</option>
						))}
					</select>
					{isAdmin(me) && (
						<button type="button" className="linkbtn danger" onClick={remove} aria-label={`Delete ${p.name}`}>
							Delete
						</button>
					)}
				</div>
			)}
		</article>
	);
}

// Dashboard (SPEC.md 7.0): every project at a glance; the landing page after sign-in.
export default function Dashboard() {
	const { data, me, today } = usePortal();
	const [filter, setFilter] = useState('all');
	const [q, setQ] = useState('');
	const [adding, setAdding] = useState(false);

	const projects = rowsOf(data, 'projects').sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
	const reviews = useMemo(() => pendingReviews(data), [data]);
	const counts = { all: projects.length, ...Object.fromEntries(STATES.map(([k]) => [k, projects.filter((p) => p.state === k).length])) };
	const query = q.trim().toLowerCase();
	const list = projects.filter((p) => (filter === 'all' || p.state === filter) && (!query || searchText([p.name]).includes(query)));
	const deleted = rowsOf(data, 'trash').filter((e) => e.type === 'grp_projects');

	return (
		<div className="pd">
			<div className="pd-bar">
				<div className="segs" role="tablist" aria-label="Filter projects by status">
					{[['all', 'All'], ...STATES].map(([k, l]) => (
						<button key={k} type="button" className="sg" role="tab" aria-selected={filter === k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
							{l} <b>{counts[k]}</b>
						</button>
					))}
				</div>
				<input className="search pd-search" type="search" placeholder="Search projects" aria-label="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
				{isManager(me) && (
					<button type="button" className="btn primary" onClick={() => setAdding(true)}>
						+ New project
					</button>
				)}
			</div>
			{projects.length === 0 ? (
				<p className="empty">{isManager(me) ? 'No projects yet. Add the first one with + New project.' : 'No projects yet. A Team Leader or the Super Admin adds them.'}</p>
			) : list.length === 0 ? (
				<p className="empty">No projects match.</p>
			) : (
				<div className="pd-grid">
					{list.map((p) => (
						<ProjectCard key={p.id} p={p} s={projectSummary(p, data, reviews, today)} />
					))}
				</div>
			)}
			{isManager(me) && <Trash entries={deleted} title="Recently deleted projects" hint="Kept 30 days · restoring a project brings back the tasks deleted with it" />}
			<NewProjectDialog open={adding} onClose={() => setAdding(false)} />
		</div>
	);
}
