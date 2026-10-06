import { usePortal } from '../context.js';
import { ROLE } from '../lib/roles.js';
import { GENERAL_NAME } from '../lib/tasks.js';
import Avatar from './Avatar.jsx';

export const TABS = [
	{ view: 'board', label: 'Meeting Minutes' },
	{ view: 'monthly', label: 'Monthly Tasks' },
	{ view: 'plan', label: 'Plan' },
	{ view: 'details', label: 'Details' },
	{ view: 'log', label: 'Recent Activities' },
];

export default function TopBar({ onSignOut }) {
	const { data, project, view, setView, search, setSearch, me, teamPerson, setTeamPerson } = usePortal();
	const dash = view === 'dash';
	// Your page and the Team area are not about a project: no project name, search or tabs.
	const people = view === 'team';
	// General tasks (SPEC.md 6.13): its own screen, with task search but no project tabs.
	const general = view === 'general';
	const p = !dash && !people && !general && project ? data.projects[project] : null;
	const suffix = p && p.state !== 'active' ? ` (${p.state})` : '';
	const title = people ? (teamPerson === me.id || teamPerson === 'all' ? 'My page' : 'Team') : dash ? 'Dashboard' : general ? GENERAL_NAME : p ? p.name + suffix : 'GridRankers';

	return (
		<div className="top">
			<h1>{title}</h1>
			{!dash && !people && view !== 'plan' && view !== 'details' && <input className="search" type="search" placeholder="Search tasks" aria-label="Search tasks" value={search} onChange={(e) => setSearch(e.target.value)} />}
			{!people && !general && (
				<div className="tabs" role="tablist" aria-label={dash ? 'Open the selected project' : undefined}>
					{TABS.map((t) => (
						<button key={t.view} role="tab" aria-selected={view === t.view} disabled={dash && !p && !project} onClick={() => setView(t.view)}>
							{t.label}
						</button>
					))}
				</div>
			)}
			<div className="me">
				<span>
					<button type="button" className="me-btn" title="Open my page" onClick={() => (setTeamPerson(me.id), setView('team'))}>
						<Avatar person={me} />
						<b>{me.name}</b>
						<span className={'role r-' + me.role}>{ROLE[me.role]}</span>
					</button>
				</span>
				<span className="me-st">
					<button type="button" className="btn small ghost" onClick={onSignOut}>
						Sign out
					</button>
				</span>
			</div>
		</div>
	);
}
