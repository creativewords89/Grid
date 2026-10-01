import { useEffect, useMemo, useRef, useState } from 'react';
import { usePortal } from '../context.js';
import { activeWeek, cycleRange, daysBetween, isWeekly } from '../lib/cycles.js';
import { deadlineInfo } from '../lib/deadline.js';
import { computeMissed, isWaived, recordOf, stateOf } from '../lib/monthly.js';
import { pendingReviews } from '../lib/reviews.js';
import { isAdmin, isManager } from '../lib/roles.js';
import { rowsOf } from '../lib/store.js';
import { searchText } from '../lib/tasks.js';
import Modal from './Modal.jsx';

const STATES = [
	['active', 'Active'],
	['paused', 'Paused'],
	['inactive', 'Inactive'],
];
const LABEL = Object.fromEntries(STATES);
const ORDER = { active: 0, paused: 1, inactive: 2 };

// Everything a project card shows, from data the app already syncs.
export function projectSummary(p, data, reviews, today) {
	const tasks = rowsOf(data, 'meeting_tasks').filter((t) => t.project_id === p.id);
	const monthly = rowsOf(data, 'monthly_tasks').filter((t) => t.project_id === p.id);
	const open = tasks.filter((t) => t.status !== 'done');
	const counted = monthly.filter((t) => !isWaived(t, p, 0, today));
	const mDone = counted.filter((t) => stateOf(t, recordOf(data.records, t, p, isWeekly(t) ? activeWeek(p, 0, today) : undefined, 0, today)) === 'done').length;
	const overdue = open.filter((t) => (deadlineInfo(t, today) || {}).overdue).length + computeMissed(monthly, data.projects, data.records, today).length;
	const P = p.cycle_set ? cycleRange(p, 0, today) : null;
	return {
		open: open.length,
		urgent: open.filter((t) => t.priority === 'urgent').length,
		mDone,
		mTotal: counted.length,
		reviews: reviews.filter((r) => r.project_id === p.id).length,
		overdue,
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

// Card menu (SPEC.md 7.0): move to another status; delete (Super Admin).
function CardMenu({ p, onMove, onDelete }) {
	const { me } = usePortal();
	const [open, setOpen] = useState(false);
	const ref = useRef(null);

	useEffect(() => {
		if (!open) return undefined;
		const close = (e) => {
			if (e.type === 'keydown' ? e.key === 'Escape' : !ref.current || !ref.current.contains(e.target)) setOpen(false);
		};
		document.addEventListener('mousedown', close);
		document.addEventListener('keydown', close);
		return () => {
			document.removeEventListener('mousedown', close);
			document.removeEventListener('keydown', close);
		};
	}, [open]);

	const pick = (fn) => () => {
		setOpen(false);
		fn();
	};

	return (
		<div className="pd-menu" ref={ref}>
			<button type="button" className="pd-dots" aria-label={`Options for ${p.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<circle cx="5" cy="12" r="2" />
					<circle cx="12" cy="12" r="2" />
					<circle cx="19" cy="12" r="2" />
				</svg>
			</button>
			{open && (
				<div className="pd-pop" role="menu" aria-label={`Options for ${p.name}`}>
					{STATES.filter(([k]) => k !== p.state).map(([k, l]) => (
						<button key={k} type="button" role="menuitem" onClick={pick(() => onMove(k))}>
							Move to {l}
						</button>
					))}
					{isAdmin(me) && (
						<button type="button" role="menuitem" className="danger" onClick={pick(onDelete)}>
							Delete project
						</button>
					)}
				</div>
			)}
		</div>
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
			message: `${n ? `Its ${n} task${n === 1 ? '' : 's'} will be deleted too. ` : ''}The Super Admin can restore it for 30 days from Team → Settings, with its tasks.`,
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

	const issues = [s.urgent && `${s.urgent} urgent`, s.overdue && `${s.overdue} overdue`, s.reviews && `${s.reviews} to review`].filter(Boolean);
	const pct = s.mTotal ? Math.round((s.mDone / s.mTotal) * 100) : 0;

	return (
		<article className={`pd-card st-${p.state}`}>
			<button type="button" className="pd-open" onClick={open} aria-label={`Open ${p.name}`}>
				<span className="pd-head">
					<b className="pd-name">{p.name}</b>
					<span className="pd-cycle">
						{s.cycle ? `Day ${s.cycle.day} · ${s.cycle.left} day${s.cycle.left === 1 ? '' : 's'} left` : 'No cycle start day yet'}
						{p.state !== 'active' ? ` · ${LABEL[p.state]}` : ''}
					</span>
				</span>
				<span className="pd-prog">
					<span className="pd-prog-l">
						<span>Monthly tasks</span>
						<b>
							{s.mDone}/{s.mTotal}
						</b>
					</span>
					<span className="pd-bar-t" aria-hidden="true">
						<span className="pd-bar-f" style={{ width: pct + '%' }} />
					</span>
				</span>
				<span className="pd-foot">
					<span>
						<b>{s.open}</b> open task{s.open === 1 ? '' : 's'}
					</span>
					<span className={issues.length ? 'pd-hot' : 'pd-ok'}>{issues.length ? issues.join(' · ') : 'On track'}</span>
				</span>
			</button>
			{isManager(me) && <CardMenu p={p} onMove={move} onDelete={remove} />}
		</article>
	);
}

// Dashboard (SPEC.md 7.0): every project at a glance; the landing page after sign-in.
export default function Dashboard() {
	const { data, me, today } = usePortal();
	const [filter, setFilter] = useState('active');
	const [q, setQ] = useState('');
	const [adding, setAdding] = useState(false);

	const projects = rowsOf(data, 'projects').sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
	const reviews = useMemo(() => pendingReviews(data), [data]);
	const counts = { all: projects.length, ...Object.fromEntries(STATES.map(([k]) => [k, projects.filter((p) => p.state === k).length])) };
	const query = q.trim().toLowerCase();
	const list = projects.filter((p) => (filter === 'all' || p.state === filter) && (!query || searchText([p.name]).includes(query)));

	return (
		<div className="pd">
			<div className="pd-top">
				<input className="search pd-search" type="search" placeholder="Search projects" aria-label="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
				{isManager(me) && (
					<button type="button" className="btn primary" onClick={() => setAdding(true)}>
						+ New project
					</button>
				)}
			</div>
			<div className="pd-tabs" role="tablist" aria-label="Filter projects by status">
				{[...STATES, ['all', 'All']].map(([k, l]) => (
					<button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>
						{l} <span>{counts[k]}</span>
					</button>
				))}
			</div>
			{projects.length === 0 ? (
				<p className="empty">{isManager(me) ? 'No projects yet. Add the first one with + New project.' : 'No projects yet. A Team Leader or the Super Admin adds them.'}</p>
			) : list.length === 0 ? (
				<p className="empty">{query ? 'No projects match.' : `No ${filter === 'all' ? '' : LABEL[filter].toLowerCase() + ' '}projects.`}</p>
			) : (
				<div className="pd-grid">
					{list.map((p) => (
						<ProjectCard key={p.id} p={p} s={projectSummary(p, data, reviews, today)} />
					))}
				</div>
			)}
			<NewProjectDialog open={adding} onClose={() => setAdding(false)} />
		</div>
	);
}
