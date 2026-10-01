import { useState } from 'react';
import { usePortal } from '../context.js';
import { isAdmin, isManager } from '../lib/roles.js';
import { rowsOf } from '../lib/store.js';

const GROUPS = [
	{ state: 'active', title: 'Active projects', empty: ['Drag a project here to make it active', 'No active projects'] },
	{ state: 'paused', title: 'Paused projects', empty: ['Drag a project here to pause it', 'No paused projects'] },
	{ state: 'inactive', title: 'Inactive projects', empty: ['Drag a project here when work stops', 'No inactive projects'] },
];
const NEXT = { active: 'paused', paused: 'inactive', inactive: 'active' };
const LABEL = { active: 'Active', paused: 'Paused', inactive: 'Inactive' };

export default function Sidebar({ syncStatus }) {
	const { api, data, dispatch, me, view, setProject, project, toast, confirm } = usePortal();
	const [name, setName] = useState('');
	const [over, setOver] = useState(null);
	const mover = isManager(me);

	const projects = rowsOf(data, 'projects').sort((a, b) => a.name.localeCompare(b.name));
	const tasks = rowsOf(data, 'meeting_tasks');
	const monthly = rowsOf(data, 'monthly_tasks');

	const counts = (id) => {
		if (view === 'monthly') return { n: monthly.filter((t) => t.project_id === id).length, red: 0, title: 'Monthly tasks' };
		const open = tasks.filter((t) => t.project_id === id && t.status !== 'done');
		return { n: open.length, red: open.filter((t) => t.priority === 'urgent').length, title: 'Open tasks' };
	};

	const add = async (e) => {
		e.preventDefault();
		const n = name.trim();
		if (!n) return;
		try {
			const row = await api.post('projects', { name: n });
			dispatch({ type: 'upsert', table: 'projects', row });
			setName('');
			setProject(row.id);
			toast('Project added');
		} catch (err) {
			toast(err.message);
		}
	};

	const move = async (p, to) => {
		if (!mover || p.state === to) return;
		dispatch({ type: 'upsert', table: 'projects', row: { ...p, state: to } });
		try {
			const row = await api.patch(`projects/${p.id}/state`, { state: to });
			dispatch({ type: 'upsert', table: 'projects', row });
			toast(`${p.name} moved to ${to} projects`);
		} catch (err) {
			dispatch({ type: 'upsert', table: 'projects', row: p });
			toast(err.message);
		}
	};

	const remove = async (p) => {
		const n = tasks.filter((t) => t.project_id === p.id).length;
		const ok = await confirm({
			title: `Remove ${p.name}?`,
			message: `${n ? `Its ${n} task${n === 1 ? '' : 's'} will be removed too. ` : ''}It stays in Recently deleted for 30 days.`,
			ok: 'Remove project',
			danger: true,
		});
		if (!ok) return;
		try {
			await api.del(`projects/${p.id}`);
			dispatch({ type: 'remove', table: 'projects', id: p.id });
			tasks.filter((t) => t.project_id === p.id).forEach((t) => dispatch({ type: 'remove', table: 'meeting_tasks', id: t.id }));
			monthly.filter((t) => t.project_id === p.id).forEach((t) => dispatch({ type: 'remove', table: 'monthly_tasks', id: t.id }));
			toast('Project removed');
		} catch (err) {
			toast(err.message);
		}
	};

	return (
		<aside>
			<div className="brand">
				GridRankers<small>Team portal</small>
			</div>
			<form className="addclient" onSubmit={add}>
				<input placeholder="Add a project" aria-label="New project name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
				<button className="btn small" type="submit">
					Add
				</button>
			</form>
			{GROUPS.map((g) => {
				const list = projects.filter((p) => p.state === g.state);
				return (
					<div className="pgroup" key={g.state}>
						<h2 className="side-h">
							{g.title} <span className="pill">{list.length}</span>
						</h2>
						<ul
							className={'clients dropzone' + (g.state !== 'active' ? ' ' + g.state : '') + (over === g.state ? ' drop-over' : '')}
							aria-label={g.title}
							onDragOver={(e) => {
								if (!mover) return;
								e.preventDefault();
								setOver(g.state);
							}}
							onDragLeave={() => setOver(null)}
							onDrop={(e) => {
								e.preventDefault();
								setOver(null);
								const p = data.projects[e.dataTransfer.getData('text/plain')];
								if (p) move(p, g.state);
							}}
						>
							{list.length === 0 && <li className="drop-empty">{g.empty[mover ? 0 : 1]}</li>}
							{list.map((p) => {
								const c = counts(p.id);
								const nx = NEXT[p.state];
								return (
									<li
										key={p.id}
										draggable={mover}
										title={mover ? 'Drag to Active, Paused or Inactive projects' : undefined}
										onDragStart={(e) => {
											e.dataTransfer.setData('text/plain', p.id);
											e.dataTransfer.effectAllowed = 'move';
										}}
									>
										<button className="pick" aria-current={project === p.id} onClick={() => setProject(p.id)}>
											<span className="nm">{p.name}</span>
											{c.red ? (
												<span className="pill red" title="Urgent fixes">
													{c.red}
												</span>
											) : (
												<span className="pill" title={c.title}>
													{c.n}
												</span>
											)}
										</button>
										{isAdmin(me) && (
											<button className="del" aria-label={`Remove ${p.name}`} onClick={() => remove(p)}>
												✕
											</button>
										)}
										{mover && (
											<button className="mv" aria-label={`Move ${p.name} to ${LABEL[nx].toLowerCase()} projects`} title={`Move to ${LABEL[nx]}`} onClick={() => move(p, nx)}>
												{nx === 'active' ? '↑' : '↓'}
											</button>
										)}
									</li>
								);
							})}
						</ul>
					</div>
				);
			})}
			<div className="sync" aria-live="polite">
				{syncStatus}
			</div>
		</aside>
	);
}
