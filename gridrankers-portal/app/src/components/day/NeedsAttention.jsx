import { useMemo, useState } from 'react';
import { usePortal } from '../../context.js';
import { attention } from '../../lib/day.js';

const CHIPS = [
	['all', 'All'],
	['overdue', 'Overdue'],
	['soon', 'Due soon'],
	['review', 'To review'],
	['unassigned', 'Unassigned'],
];

export const useAttention = () => {
	const { data, today } = usePortal();
	return useMemo(() => attention(data, today), [data, today]);
};

// Projects tab, top: everything that needs attention across active projects (SPEC.md 7.0).
export default function NeedsAttention({ items }) {
	const { data, setProject, setSearch, setView } = usePortal();
	const [filter, setFilter] = useState('all');
	const [all, setAll] = useState(false);
	const counts = Object.fromEntries(CHIPS.map(([k]) => [k, k === 'all' ? items.length : items.filter((i) => i.type === k).length]));
	const list = items.filter((i) => filter === 'all' || i.type === filter);
	const shown = all ? list : list.slice(0, 8);
	const projects = new Set(items.map((i) => i.task.project_id)).size;

	const open = (i) => {
		setProject(i.task.project_id);
		setSearch(i.task.title);
		setView(i.tab);
	};

	return (
		<section className="md-card" aria-labelledby="naTitle">
			<div className="md-h">
				<h2 id="naTitle">Needs attention</h2>
				<span className="muted">{items.length ? `${items.length} item${items.length === 1 ? '' : 's'} across ${projects} project${projects === 1 ? '' : 's'}` : ''}</span>
			</div>
			{items.length === 0 ? (
				<p className="muted">Nothing overdue, due soon, waiting for review or unassigned.</p>
			) : (
				<>
					<div className="ra-chips" role="group" aria-label="Filter what needs attention">
						{CHIPS.map(([k, l]) => (
							<button key={k} type="button" className="ra-chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
								{l} {counts[k]}
							</button>
						))}
					</div>
					<ul className="na-list">
						{shown.map((i, n) => (
							<li key={i.type + i.task.id + n}>
								<b>{(data.projects[i.task.project_id] || {}).name}</b>
								<span className="na-task">
									{i.task.title}
									{i.sub && <small> · {i.sub}</small>}
								</span>
								<span className={'mp-flag f-' + i.tone}>{i.reason}</span>
								<span className="muted na-who">{i.who || 'Unassigned'}</span>
								<button type="button" className="btn small" onClick={() => open(i)} aria-label={`Open ${i.task.title}`}>
									Open
								</button>
							</li>
						))}
					</ul>
					{list.length > shown.length && (
						<button type="button" className="mp-more" onClick={() => setAll(true)}>
							Show all {list.length}
						</button>
					)}
				</>
			)}
		</section>
	);
}
