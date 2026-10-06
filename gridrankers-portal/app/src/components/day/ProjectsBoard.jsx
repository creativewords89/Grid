import { useEffect, useMemo, useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { attentionByProject, healthOf, teamOf } from '../../lib/attention.js';
import { activeWeek, cycleRange, daysBetween, isWeekly } from '../../lib/cycles.js';
import { deadlineInfo } from '../../lib/deadline.js';
import { computeMissed, isWaived, recordOf, stateOf } from '../../lib/monthly.js';
import { pendingReviews } from '../../lib/reviews.js';
import { isAdmin, isManager } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import { searchText } from '../../lib/tasks.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';

const STATES = [
	['active', 'Active'],
	['paused', 'Paused'],
	['inactive', 'Inactive'],
];
const LABEL = Object.fromEntries(STATES);
const ORDER = { active: 0, paused: 1, inactive: 2 };

// Everything a project row shows, from data the app already syncs.
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
		cycle: P && { day: P.day || p.cycle_day, end: P.end, left: Math.max(0, daysBetween(today, P.end)), len: daysBetween(P.start, P.end) + 1 },
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

// Row menu (SPEC.md 7.0): move to another status; delete (Super Admin).
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

// The Needs attention cell (design PJ-A4): the most urgent item, why in its colour, and +N for
// the rest (a small list). Clicking an item opens it.
function Attention({ p, items }) {
	const { setProject, setSearch, setView } = usePortal();
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
	if (!items.length) return <span className="pj-ok">✓ On track</span>;
	const go = (i) => {
		setOpen(false);
		if (i.setup) {
			window.dispatchEvent(new Event('grp:cycle-setup'));
			return;
		}
		setProject(p.id);
		setSearch(i.open.title);
		setView(i.open.tab);
	};
	const [first] = items;
	return (
		<span className="pj-att" ref={ref}>
			<button type="button" className={'pj-item t-' + first.tone} onClick={(e) => (e.stopPropagation(), go(first))}>
				<span className="pj-t">{first.title}</span>
				<b> · {first.why}</b>
			</button>
			{items.length > 1 && (
				<button type="button" className="pj-more" aria-expanded={open} aria-label={`${items.length - 1} more for ${p.name}`} onClick={(e) => (e.stopPropagation(), setOpen(!open))}>
					+{items.length - 1}
				</button>
			)}
			{open && (
				<span className="pj-pop" role="dialog" aria-label={`${p.name}: needs attention`} onClick={(e) => e.stopPropagation()}>
					<b className="pj-pop-h">
						{p.name} · {items.length} need attention
					</b>
					{items.map((i) => (
						<button key={i.key} type="button" className={'pj-pop-i t-' + i.tone} onClick={() => go(i)}>
							<span>{i.title}</span>
							<b>{i.why}</b>
						</button>
					))}
				</span>
			)}
		</span>
	);
}

function ProjectRow({ p, s, items, team }) {
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
			// Back to Active: the server adds this cycle's standard monthly tasks; show them now.
			if (to === 'active') dispatch({ type: 'sync', changes: { monthly_tasks: await api.get('monthly-tasks', { project: p.id }) } });
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
	const health = healthOf(items);
	const pct = s.mTotal ? Math.round((s.mDone / s.mTotal) * 100) : 0;
	const cyc = s.cycle ? Math.round((100 * (s.cycle.len - s.cycle.left)) / Math.max(1, s.cycle.len)) : 0;
	return (
		<div className={`pj-row st-${p.state}`} role="row" onClick={open}>
			<span role="cell" className={'pj-dot h-' + health} aria-label={{ red: 'Needs attention now', amber: 'Keep an eye on it', green: 'On track' }[health]} />
			<span role="cell" className="pj-name">
				<button type="button" className="pj-open" onClick={(e) => (e.stopPropagation(), open())} aria-label={`Open ${p.name}`}>
					{p.name}
				</button>
				{p.state !== 'active' && <small>{LABEL[p.state]}</small>}
			</span>
			<span role="cell" className="pj-cyc">
				<span className="pd-cycle">{s.cycle ? `Day ${s.cycle.day} · ${s.cycle.left} day${s.cycle.left === 1 ? '' : 's'} left` : 'No cycle start day yet'}</span>
				{s.cycle && (
					<span className="pj-bar g" aria-hidden="true">
						<span style={{ width: cyc + '%' }} />
					</span>
				)}
			</span>
			<span role="cell" className="pj-mon">
				{/* Monthly tasks are added only while a project is active (SPEC.md 6.8). */}
				{p.state !== 'active' && !s.mTotal ? (
					<span className="muted">Start when active</span>
				) : (
					<>
						<span className={'pj-bar' + (s.mTotal && s.mDone === s.mTotal ? ' full' : '')} aria-hidden="true">
							<span style={{ width: pct + '%' }} />
						</span>
						<b>
							{s.mDone}/{s.mTotal}
						</b>
					</>
				)}
			</span>
			<span role="cell" className="pj-attc">
				<Attention p={p} items={items} />
			</span>
			<span role="cell" className="pj-team">
				{team.slice(0, 4).map((m) => (
					<Avatar key={m.id} person={m} small />
				))}
				{team.length > 4 && <small>+{team.length - 4}</small>}
			</span>
			<span role="cell" className="pj-menu" onClick={(e) => e.stopPropagation()}>
				{isManager(me) && <CardMenu p={p} onMove={move} onDelete={remove} />}
			</span>
		</div>
	);
}

// Projects tab of the Dashboard (SPEC.md 7.0, design PJ-A4): every project at a glance, one row
// each, worst first (Super Admin, Team Leader).
export default function ProjectsBoard() {
	const { data, me, today } = usePortal();
	const [filter, setFilter] = useState('active');
	const [q, setQ] = useState('');
	const [adding, setAdding] = useState(false);

	const projects = rowsOf(data, 'projects').sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
	const reviews = useMemo(() => pendingReviews(data), [data]);
	const attention = useMemo(() => attentionByProject(data, today), [data, today]);
	const counts = { all: projects.length, ...Object.fromEntries(STATES.map(([k]) => [k, projects.filter((p) => p.state === k).length])) };
	const query = q.trim().toLowerCase();
	const list = projects.filter((p) => (filter === 'all' || p.state === filter) && (!query || searchText([p.name]).includes(query)));
	// Worst first (red, amber, green), then by name (design PJ-A4).
	const rows = list
		.map((p) => {
			const items = attention[p.id] || [];
			return { p, s: projectSummary(p, data, reviews, today), items, team: teamOf(p, data), h: { red: 0, amber: 1, green: 2 }[healthOf(items)] };
		})
		.sort((a, b) => ORDER[a.p.state] - ORDER[b.p.state] || a.h - b.h || a.p.name.localeCompare(b.p.name));

	return (
		<div className="pd">
			<div className="pd-top">
				<input className="search pd-search" type="search" placeholder="Search projects" aria-label="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
				<div className="pd-tabs" role="tablist" aria-label="Filter projects by status">
					{[...STATES, ['all', 'All']].map(([k, l]) => (
						<button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>
							{l} <span>{counts[k]}</span>
						</button>
					))}
				</div>
				{isManager(me) && (
					<button type="button" className="btn primary" onClick={() => setAdding(true)}>
						+ New project
					</button>
				)}
			</div>
			{projects.length === 0 ? (
				<p className="empty">{isManager(me) ? 'No projects yet. Add the first one with + New project.' : 'No projects yet. A Team Leader or the Super Admin adds them.'}</p>
			) : list.length === 0 ? (
				<p className="empty">{query ? 'No projects match.' : `No ${filter === 'all' ? '' : LABEL[filter].toLowerCase() + ' '}projects.`}</p>
			) : (
				<div className="pj-table" role="table" aria-label="Projects">
					<div className="pj-row pj-head" role="row">
						<span role="columnheader" />
						<span role="columnheader">Project</span>
						<span role="columnheader">Cycle</span>
						<span role="columnheader">Monthly tasks</span>
						<span role="columnheader">Needs attention</span>
						<span role="columnheader">Team</span>
						<span />
					</div>
					{rows.map(({ p, s, items, team }) => (
						<ProjectRow key={p.id} p={p} s={s} items={items} team={team} />
					))}
				</div>
			)}
			<NewProjectDialog open={adding} onClose={() => setAdding(false)} />
		</div>
	);
}
