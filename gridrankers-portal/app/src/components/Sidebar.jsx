import { usePortal } from '../context.js';
import { isManager } from '../lib/roles.js';
import { rowsOf } from '../lib/store.js';

const GROUPS = [
	{ state: 'active', title: 'Active projects', empty: 'No active projects' },
	{ state: 'paused', title: 'Paused projects', empty: 'No paused projects' },
	{ state: 'inactive', title: 'Inactive projects', empty: 'No inactive projects' },
];

// Brand (→ Dashboard), Team (leaders and the Super Admin) and the project list for quick switching. Adding, moving and deleting
// projects happen on the Dashboard (SPEC.md 7.0, 7.1).
export default function Sidebar({ syncStatus }) {
	const { data, view, setView, setProject, project, me, teamPerson, setTeamPerson } = usePortal();
	// A project is highlighted only on its own screens, never on My day or a person's page.
	const onProject = ['board', 'monthly', 'log'].includes(view);

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
			{isManager(me) && (
				<button type="button" className="side-link" aria-current={view === 'team' && teamPerson !== me.id ? 'page' : undefined} onClick={() => (setTeamPerson('all'), setView('team'))}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
						<path d="M9 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.8 5.2" />
					</svg>
					Team
				</button>
			)}
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
										<button className="pick" aria-current={onProject && project === p.id} onClick={() => setProject(p.id)}>
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
