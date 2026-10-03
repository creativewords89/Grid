import { useState } from 'react';
import { usePortal } from '../context.js';
import { rowsOf } from '../lib/store.js';

const GROUPS = [
	{ state: 'active', title: 'Active projects' },
	{ state: 'paused', title: 'Paused projects' },
	{ state: 'inactive', title: 'Inactive projects' },
];

// A steady colour per project for its initials badge.
const COLORS = ['#2753C9', '#0F6E77', '#B4316E', '#4D7C0F', '#6B3FB5', '#C2410C', '#15233A', '#8A5F00', '#2A7A4B', '#4A5A70', '#0E7490', '#9F1239'];
const colorOf = (id) => COLORS[[...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const initialsOf = (name) =>
	String(name)
		.replace(/[^\p{L}\p{N}\s]/gu, '')
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0])
		.join('')
		.toUpperCase() || '?';

// Brand and My day (→ Dashboard), then the project list for quick switching (SPEC.md 7.0, 7.1):
// Active projects always open; Paused and Inactive folded until opened. Counts show only when a
// project has open work (red when something is urgent).
export default function Sidebar({ syncStatus }) {
	const { data, view, setView, setProject, project } = usePortal();
	const [open, setOpen] = useState({ paused: false, inactive: false });

	const projects = rowsOf(data, 'projects').sort((a, b) => a.name.localeCompare(b.name));
	const tasks = rowsOf(data, 'meeting_tasks');
	const monthly = rowsOf(data, 'monthly_tasks');
	// A project is highlighted only on its own screens, never on My day or a person's page.
	const onProject = ['board', 'monthly', 'plan', 'details', 'log'].includes(view);
	const current = onProject && data.projects[project];

	const counts = (id) => {
		if (view === 'monthly') return { n: monthly.filter((t) => t.project_id === id).length, red: false, title: 'Monthly tasks' };
		const left = tasks.filter((t) => t.project_id === id && t.status !== 'done');
		const urgent = left.filter((t) => t.priority === 'urgent').length;
		return { n: left.length, red: urgent > 0, title: urgent ? `${left.length} open, ${urgent} urgent` : `${left.length} open tasks` };
	};

	return (
		<aside>
			<button type="button" className="brand" title="Dashboard: all projects" onClick={() => setView('dash')}>
				<span className="brand-mark" aria-hidden="true">
					GR
				</span>
				<span>
					GridRankers<small>Team portal</small>
				</span>
			</button>
			<button type="button" className="side-link" aria-current={view === 'dash' ? 'page' : undefined} onClick={() => setView('dash')}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
					<path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
				</svg>
				My day
			</button>
			{GROUPS.map((g) => {
				const list = projects.filter((p) => p.state === g.state);
				const folds = g.state !== 'active';
				// A folded group opens by itself while one of its projects is the one on screen.
				const shown = !folds || open[g.state] || (current && current.state === g.state);
				return (
					<div className={'pgroup g-' + g.state} key={g.state}>
						{folds ? (
							<button type="button" className="side-h fold" aria-expanded={!!shown} onClick={() => setOpen({ ...open, [g.state]: !shown })}>
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
									<path d={shown ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} />
								</svg>
								{g.title} <span className="side-n">{list.length}</span>
							</button>
						) : (
							<h2 className="side-h">
								{g.title} <span className="side-n">{list.length}</span>
							</h2>
						)}
						<ul className={'clients ' + g.state} aria-label={g.title} hidden={!shown}>
							{list.length === 0 && <li className="side-empty">No {g.state} projects</li>}
							{list.map((p) => {
								const c = counts(p.id);
								return (
									<li key={p.id}>
										<button className="pick" title={p.name} aria-current={onProject && project === p.id} onClick={() => setProject(p.id)}>
											<span className="pj-badge" style={{ background: colorOf(p.id) }} aria-hidden="true">
												{initialsOf(p.name)}
											</span>
											<span className="nm">{p.name}</span>
											{c.n > 0 && (
												<span className={'pill' + (c.red ? ' red' : '')} title={c.title}>
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
