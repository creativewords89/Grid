import { usePortal } from '../context.js';
import { ROLE, isManager } from '../lib/roles.js';
import Avatar from './Avatar.jsx';

export const TABS = [
	{ view: 'board', label: 'Meeting Minutes' },
	{ view: 'monthly', label: 'Monthly Tasks' },
	{ view: 'log', label: 'Recent Activities' },
];

export default function TopBar({ onSignOut }) {
	const { data, project, view, setView, search, setSearch, me } = usePortal();
	const p = project ? data.projects[project] : null;
	const suffix = p && p.state !== 'active' ? ` (${p.state})` : '';

	return (
		<div className="top">
			<h1>{p ? p.name + suffix : 'GridRankers'}</h1>
			<input className="search" type="search" placeholder="Search tasks" aria-label="Search tasks" value={search} onChange={(e) => setSearch(e.target.value)} />
			<div className="tabs" role="tablist">
				{TABS.map((t) => (
					<button key={t.view} role="tab" aria-selected={view === t.view} onClick={() => setView(t.view)}>
						{t.label}
					</button>
				))}
			</div>
			<div className="me">
				<span>
					<button type="button" className="me-btn" title={isManager(me) ? 'Open the team page' : 'Open my page'} onClick={() => setView('team')}>
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
