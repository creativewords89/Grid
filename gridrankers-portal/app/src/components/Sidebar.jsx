import { usePortal } from '../context.js';
import { rowsOf } from '../lib/store.js';

const GROUPS = [
	{ state: 'active', title: 'Active projects', empty: 'No active projects' },
	{ state: 'paused', title: 'Paused projects', empty: 'No paused projects' },
	{ state: 'inactive', title: 'Inactive projects', empty: 'No inactive projects' },
];

// Brand (→ Dashboard) and the project list for quick switching. Adding, moving and deleting
// projects happen on the Dashboard (SPEC.md 7.0, 7.1).
export default function Sidebar({ syncStatus }) {
	const { data, view, setView, setProject, project } = usePortal();

	const projects = rowsOf(data, 'projects').sort((a, b) => a.name.localeCompare(b.name));
	const tasks = rowsOf(data, 'meeting_tasks');
	const monthly = rowsOf(data, 'monthly_tasks');

	const counts = (id) => {
		if (view === 'monthly') return { n: monthly.filter((t) => t.project_id === id).length, red: 0, title: 'Monthly tasks' };
		const open = tasks.filter((t) => t.project_id === id && t.status !== 'done');
		return { n: open.length, red: open.filter((t) => t.priority === 'urgent').length, title: 'Open tasks' };
	};

	return (
		<aside>
			<button type="button" className="brand" aria-current={view === 'dash' ? 'page' : undefined} title="Dashboard: all projects" onClick={() => setView('dash')}>
				GridRankers<small>Team portal</small>
			</button>
			{GROUPS.map((g) => {
				const list = projects.filter((p) => p.state === g.state);
				return (
					<div className="pgroup" key={g.state}>
						<h2 className="side-h">
							{g.title} <span className="pill">{list.length}</span>
						</h2>
						<ul className={'clients' + (g.state !== 'active' ? ' ' + g.state : '')} aria-label={g.title}>
							{list.length === 0 && <li className="drop-empty">{g.empty}</li>}
							{list.map((p) => {
								const c = counts(p.id);
								return (
									<li key={p.id}>
										<button className="pick" aria-current={view !== 'dash' && project === p.id} onClick={() => setProject(p.id)}>
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
