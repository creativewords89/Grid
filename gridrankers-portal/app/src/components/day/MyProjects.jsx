import { useMemo, useState } from 'react';
import { usePortal } from '../../context.js';
import { daysBetween } from '../../lib/cycles.js';
import { PAGE_SIZE, PROJECT_FILTERS, SOON_DAYS, myProjects } from '../../lib/day.js';
import { MEMBER_TAB_KEY, profileLocked } from '../../lib/people.js';
import { LogWorkDialog } from '../team/parts.jsx';

const FILTERS = [
	['all', 'All'],
	['urgent', 'Urgent'],
	['overdue', 'Overdue'],
	['week', 'Due this week'],
];

function ProjectBox({ group, today }) {
	const { setProject, setView, setSearch } = usePortal();
	const [more, setMore] = useState(false);
	const shown = more ? group.tasks : group.tasks.slice(0, 2);
	const hidden = group.tasks.length - shown.length;
	const open = (tab, title) => {
		setProject(group.project.id);
		setSearch(title || '');
		setView(tab);
	};
	const soon = (t) => !t.overdue && !!t.due && daysBetween(today, t.due) <= SOON_DAYS;

	return (
		<article className={'mp-box e-' + group.flag.tone}>
			<div className="mp-head">
				<button type="button" className="mp-name" onClick={() => open('board')}>
					{group.project.name}
				</button>
				<span className="mp-count">
					{group.tasks.length} task{group.tasks.length === 1 ? '' : 's'}
				</span>
				<span className={'mp-flag f-' + group.flag.tone}>{group.flag.text}</span>
			</div>
			<ul className="mp-tasks">
				{shown.map((t) => (
					<li key={t.kind + t.id}>
						<button type="button" onClick={() => open(t.kind === 'monthly' ? 'monthly' : 'board', t.title)}>
							<span className="mp-check" aria-hidden="true" />
							<span className="mp-title">
								{t.title} <small>· {t.sub}</small>
							</span>
							<span className={'mp-flag f-' + (t.overdue || t.urgent ? 'red' : soon(t) ? 'amber' : 'plain')}>{t.urgent && !t.overdue ? 'Urgent · ' + t.dueText : t.dueText}</span>
						</button>
					</li>
				))}
			</ul>
			{hidden > 0 && (
				<button type="button" className="mp-more" onClick={() => setMore(true)}>
					+{hidden} more task{hidden === 1 ? '' : 's'}
				</button>
			)}
		</article>
	);
}

// My projects (SPEC.md 7.0): the person's open work by project, most urgent first, 5 per page.
export default function MyProjects() {
	const { data, me, today, setTeamPerson, setView, viewOnly } = usePortal();
	const [filter, setFilter] = useState('all');
	const [page, setPage] = useState(0);
	const [logging, setLogging] = useState(false);
	const groups = useMemo(() => myProjects(data, me, today), [data, me, today]);
	const counts = Object.fromEntries(FILTERS.map(([k]) => [k, groups.filter((g) => PROJECT_FILTERS[k](g, today)).length]));
	const list = groups.filter((g) => PROJECT_FILTERS[filter](g, today));
	const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
	const at = Math.min(page, pages - 1);
	const shown = list.slice(at * PAGE_SIZE, at * PAGE_SIZE + PAGE_SIZE);
	const tasks = groups.reduce((n, g) => n + g.tasks.length, 0);
	// Log work (SPEC.md 7.0): custom work that isn't a task, for yourself.
	const logBtn = viewOnly ? null : (
		<>
			<button type="button" className="btn small mp-log" onClick={() => setLogging(true)}>
				+ Log work
			</button>
			{logging && <LogWorkDialog open onClose={() => setLogging(false)} memberId={me.id} date={today} />}
		</>
	);

	if (profileLocked(data.members[me.id] || me, me)) {
		const openSettings = () => {
			try {
				window.sessionStorage.setItem(MEMBER_TAB_KEY, 'profile');
			} catch (e) {
				/* opens on the first tab */
			}
			setTeamPerson(me.id);
			setView('team');
		};
		return (
			<section className="md-card md-grow" aria-labelledby="mpTitle">
				<div className="md-h">
					<h2 id="mpTitle">My projects</h2>
					<span className="muted">Locked until your profile is complete</span>
				</div>
				<div className="md-empty">
					<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
						<rect x="5" y="11" width="14" height="10" rx="2" />
						<path d="M8 11V7a4 4 0 0 1 8 0v4" />
					</svg>
					<b className="md-empty-big">Your tasks are waiting</b>
					<span>
						You have {tasks} open task{tasks === 1 ? '' : 's'}. Finish your profile in Settings to start working on them.
					</span>
					<button type="button" className="btn primary" onClick={openSettings}>
						Complete profile
					</button>
				</div>
			</section>
		);
	}

	if (!groups.length) {
		return (
			<section className="md-card md-grow" aria-labelledby="mpTitle">
				<div className="md-h">
					<h2 id="mpTitle">My projects</h2>
					{logBtn}
				</div>
				<div className="md-empty">
					<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--done)" strokeWidth="1.8" aria-hidden="true">
						<circle cx="12" cy="12" r="9" />
						<path d="M8 12.5l2.5 2.5L16 9.5" />
					</svg>
					<b className="md-empty-big">You’re all caught up</b>
					<span>No open tasks. New tasks assigned to you will show here, most urgent first.</span>
				</div>
			</section>
		);
	}

	return (
		<section className="md-card md-grow" aria-labelledby="mpTitle">
			<div className="md-h">
				<h2 id="mpTitle">My projects</h2>
				<span className="muted">
					Most urgent first · {tasks} open task{tasks === 1 ? '' : 's'} in {groups.length} project{groups.length === 1 ? '' : 's'}
				</span>
				{logBtn}
			</div>
			<div className="ra-chips" role="group" aria-label="Filter my projects">
				{FILTERS.map(([k, l]) => (
					<button key={k} type="button" className="ra-chip" aria-pressed={filter === k} onClick={() => (setFilter(k), setPage(0))}>
						{l} {counts[k]}
					</button>
				))}
			</div>
			{shown.length === 0 ? <p className="empty">Nothing here.</p> : shown.map((g) => <ProjectBox key={g.project.id} group={g} today={today} />)}
			{list.length > PAGE_SIZE && (
				<nav className="mp-pages" aria-label="My projects pages">
					<span className="muted">
						Showing {at * PAGE_SIZE + 1}–{at * PAGE_SIZE + shown.length} of {list.length} projects
					</span>
					<div>
						<button type="button" className="pg" disabled={at === 0} onClick={() => setPage(at - 1)}>
							‹ Previous
						</button>
						{Array.from({ length: pages }, (_, i) => (
							<button key={i} type="button" className="pg" aria-current={i === at ? 'page' : undefined} onClick={() => setPage(i)}>
								{i + 1}
							</button>
						))}
						<button type="button" className="pg" disabled={at === pages - 1} onClick={() => setPage(at + 1)}>
							Next ›
						</button>
					</div>
				</nav>
			)}
		</section>
	);
}
