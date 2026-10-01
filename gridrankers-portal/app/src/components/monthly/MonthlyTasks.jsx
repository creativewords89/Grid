import { useMemo, useState } from 'react';
import { usePortal } from '../../context.js';
import { activeWeek, addDays, cycleFill, cycleRange, daysBetween, dueAt, periodsOf, weekRange } from '../../lib/cycles.js';
import { short } from '../../lib/format.js';
import { computeMissed, isWaived, periodKeyOf, recordOf, stateOf } from '../../lib/monthly.js';
import { isManager } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import { assigneesOf, searchText } from '../../lib/tasks.js';
import Avatar from '../Avatar.jsx';
import CycleBar from '../CycleBar.jsx';
import MonthlyCard from './MonthlyCard.jsx';
import MonthlyDetails from './MonthlyDetails.jsx';
import MonthlyDialog from './MonthlyDialog.jsx';
import useRecordActions from './useRecordActions.js';

// Transition / pending cycle-change notices for the viewed cycle (reference transitionNotices).
function TransitionNotice({ project }) {
	const { cycleOff, today } = usePortal();
	const P = cycleRange(project, cycleOff, today);
	if (P.transition) {
		const left = Math.max(0, daysBetween(today, P.end));
		return (
			<div className="tnote">
				<span className="t-ico" aria-hidden="true">
					⇄
				</span>
				<div>
					<strong>
						Transition period · {short(P.start)} – {short(P.end)}
					</strong>
					<span>
						{P.monthly === 'due' ? `Finish all previous cycle tasks by ${short(P.end)}.` : 'Weekly tasks continue; monthly tasks are waived.'} New cycle starts {short(addDays(P.end, 1))} (day {P.change.day}).
					</span>
				</div>
				{today < P.start ? <span className="t-left">Starts {short(P.start)}</span> : today > P.end ? <span className="t-left">Ended</span> : (
					<span className="t-left">
						<b>{left}</b> {left === 1 ? 'day' : 'days'} left
					</span>
				)}
			</div>
		);
	}
	if (P.merged && P.change) {
		return (
			<div className="tnote fresh">
				<span className="t-ico" aria-hidden="true">
					↺
				</span>
				<div>
					<strong>Fresh start since {short(P.start)}</strong>
					<span>
						This first cycle runs to {short(P.end)}, then day {P.day} each month.
					</span>
				</div>
			</div>
		);
	}
	const pend = cycleOff === 0 ? (project.cycle_changes || []).find((ch) => ch.from > today) : null;
	if (!pend) return null;
	const tr = periodsOf(project, today).find((x) => x.change && x.change.from === pend.from && x.transition);
	return (
		<div className="tnote soon">
			<span className="t-ico" aria-hidden="true">
				⏭
			</span>
			<div>
				<strong>Cycle change on {short(pend.from)}</strong>
				<span>{tr ? `Transition ${short(tr.start)} – ${short(tr.end)}, then day ${pend.day}.` : `Day ${pend.day} from then on.`}</span>
			</div>
			<span className="t-left">
				<b>{daysBetween(today, pend.from)}</b> days to go
			</span>
		</div>
	);
}

function MissedBanner({ project, tasks, missed }) {
	const { data, me, cycleOff, today } = usePortal();
	const { setStatus } = useRecordActions();
	const [open, setOpen] = useState(false);
	const members = data.members;
	if (!tasks.length) return null;
	const undone = tasks.filter((t) => {
		const rec = recordOf(data.records, t, project, undefined, cycleOff, today);
		return !isWaived(t, project, cycleOff, today) && stateOf(t, rec) !== 'done' && !(rec && rec.status === 'skipped');
	}).length;
	const where = cycleOff === 0 ? 'cycle' : 'period';
	if (!missed.length) {
		return (
			<section className="alert calm">
				<span className="a-ico" aria-hidden="true">
					✓
				</span>
				<strong>No unfinished tasks in this {where}.</strong>
				<span>
					{undone} {undone === 1 ? 'task' : 'tasks'} still undone{cycleOff === 0 ? ' this cycle' : ''}.
				</span>
			</section>
		);
	}
	const who = (t) => assigneesOf(t, members).map((a) => members[a.id].name).join(', ');
	const byPerson = new Map();
	missed.forEach((m) => byPerson.set(who(m.task) || 'Unassigned', (byPerson.get(who(m.task) || 'Unassigned') || 0) + 1));
	const unassigned = missed.filter((m) => !who(m.task)).length;
	return (
		<details className="alert" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
			<summary>
				<span className="a-ico" aria-hidden="true">
					!
				</span>
				<span className="a-head">
					<strong>
						{missed.length} unfinished {missed.length === 1 ? 'task' : 'tasks'} in this {where}
					</strong>
					<span className="a-sub">{[...byPerson].map(([k, v]) => `${k} ${v}`).join(' · ')}</span>
				</span>
				<span className="a-stats">
					<span>
						<b>{missed.length}</b> unfinished
					</span>
					<span>
						<b>{undone}</b> undone{cycleOff === 0 ? ' this cycle' : ''}
					</span>
					{unassigned > 0 && (
						<span>
							<b>{unassigned}</b> unassigned
						</span>
					)}
				</span>
				<span className="a-tog">{open ? 'Hide' : 'Show'}</span>
			</summary>
			<ul className="a-list">
				{missed.map((m, i) => {
					const first = assigneesOf(m.task, members)[0];
					const key = periodKeyOf(m.task, m.project, m.w, m.off, today);
					return (
						<li key={m.task.id + key + i}>
							<Avatar person={first ? members[first.id] : null} />
							<div className="a-main">
								<strong>{m.task.title}</strong>
								<span>
									{m.project.name} · {m.label} · {who(m.task) || <em>Unassigned</em>}
								</span>
							</div>
							<span className="a-age">{m.days}d</span>
							<button className="btn small a-done" onClick={() => setStatus(m.task, key, 'done')}>
								Mark finished
							</button>
							{isManager(me) && (
								<button className="btn small" title="Close it without doing it; it's recorded as skipped" onClick={() => setStatus(m.task, key, 'skipped')}>
									Skip
								</button>
							)}
						</li>
					);
				})}
			</ul>
		</details>
	);
}

const TILES = [
	['all', 'All', 't-all'],
	['todo', 'Not started', 't-todo'],
	['doing', 'In progress', 't-doing'],
	['done', 'Completed', 't-done'],
	['late', 'Overdue', 't-late'],
];

// Monthly Tasks (SPEC.md 7.3): banner, project cycle bar, stats, filters + week bar, cards.
export default function MonthlyTasks({ reviewActions }) {
	const { data, project, search, cycleOff, today } = usePortal();
	const [freq, setFreq] = useState('all');
	const [status, setStatus] = useState('all');
	const [wkSel, setWkSel] = useState(null);
	const [selWeek, setSelWeek] = useState({});
	const [dialog, setDialog] = useState(null);
	const p = data.projects[project];

	const all = rowsOf(data, 'monthly_tasks').filter((t) => p && t.project_id === p.id);
	const missedAll = useMemo(() => (p ? computeMissed(all, data.projects, data.records, today) : []), [all, data.projects, data.records, today, p]);
	if (!p) return null;

	const missed = missedAll.filter((m) => m.off === cycleOff);
	const missedOf = (t) => missed.filter((m) => m.task.id === t.id);
	const q = search.trim().toLowerCase();
	const members = data.members;
	const aw = activeWeek(cycleOff, today);
	const barWeek = freq === 'weekly' && wkSel !== null ? wkSel : null;
	const weekOf = (t) => (t.freq === 'weekly' ? (selWeek[t.id] !== undefined ? selWeek[t.id] : barWeek) ?? aw : undefined);
	const stOf = (t) => stateOf(t, recordOf(data.records, t, p, weekOf(t), cycleOff, today));

	const scope = all.filter((t) => freq === 'all' || (t.freq || 'monthly') === freq);
	const passQ = (t) => !q || searchText([t.title, t.notes, ...assigneesOf(t, members).map((a) => members[a.id].name)]).includes(q);
	const counted = scope.filter((t) => passQ(t) && !isWaived(t, p, cycleOff, today));
	const cnt = { todo: 0, doing: 0, done: 0 };
	counted.forEach((t) => cnt[stOf(t)]++);
	const late = counted.filter((t) => missedOf(t).length).length;
	const num = { all: counted.length, ...cnt, late };
	const pass = (t) => status === 'all' || (status === 'late' ? missedOf(t).length > 0 : stOf(t) === status);
	const list = scope
		.filter((t) => passQ(t) && pass(t))
		.sort((a, b) => (missedOf(b).length > 0) - (missedOf(a).length > 0) || dueAt(a, p, weekOf(a), cycleOff, today).localeCompare(dueAt(b, p, weekOf(b), cycleOff, today)));

	const P = cycleRange(p, cycleOff, today);
	const phase = today < P.start ? 'up' : today > P.end ? 'past' : 'now';
	const left = Math.max(0, daysBetween(today, P.end));
	const fill = cycleFill(P, today);
	const tone = phase !== 'now' ? phase : left <= 3 ? 'hot' : left <= 7 ? 'warm' : '';

	const pickW = barWeek ?? aw;
	const wr = weekRange(pickW, cycleOff, today);
	const wkTasks = scope.filter((t) => t.freq === 'weekly');
	const wkDone = wkTasks.filter((t) => stateOf(t, recordOf(data.records, t, p, pickW, cycleOff, today)) === 'done').length;

	return (
		<>
			<TransitionNotice project={p} />
			<MissedBanner project={p} tasks={all} missed={missed} />
			<CycleBar project={p} />
			{freq === 'weekly' && (
				<div className="cyc-inline wk-inline">
					<div className="cyc-chip">
						<span className="cc-name">Week</span>
						<span className="cc-lock">
							<span className="lk" aria-hidden="true">
								📅
							</span>
							Week <b>{pickW + 1}</b> of 4{pickW === aw ? ' · this week' : ''}
						</span>
						<span className="cc-dates">
							<span>
								{short(wr.start)} – {short(wr.end)}
							</span>
						</span>
						<span className="cc-done">
							{wkTasks.length ? (
								<>
									<b>{wkDone}</b>/{wkTasks.length} done
								</>
							) : (
								'No weekly tasks'
							)}
						</span>
						{pickW !== aw && (
							<button type="button" className="cc-change" onClick={() => (setWkSel(null), setSelWeek({}))}>
								Back to this week
							</button>
						)}
						<span className="wk-nav">
							<button type="button" aria-label="Previous week" disabled={pickW <= 0} onClick={() => (setWkSel(pickW - 1 === aw ? null : pickW - 1), setSelWeek({}))}>
								‹
							</button>
							<button type="button" aria-label="Next week" disabled={pickW >= 3} onClick={() => (setWkSel(pickW + 1 === aw ? null : pickW + 1), setSelWeek({}))}>
								›
							</button>
						</span>
					</div>
				</div>
			)}
			{scope.length > 0 && (
				<section className="stats2" aria-label="Monthly statistics">
					<div className="s-tiles">
						<div className="segs" role="tablist" aria-label="Filter by status">
							{TILES.map(([key, label, cls]) => (
								<button
									key={key}
									className={`sg ${cls} ${key === 'late' && num.late ? 'hot' : ''}`}
									role="tab"
									aria-selected={status === key}
									aria-pressed={status === key}
									onClick={() => setStatus(status === key && key !== 'all' ? 'all' : key)}
								>
									<span className="sg-dot" />
									{label}
									<span className="sg-n">{num[key]}</span>
								</button>
							))}
						</div>
					</div>
					<div className="s-dates">
						<div className="segs dates" aria-label="Cycle dates">
							<span className="dt" title="Cycle starts">
								<span className="dt-v">{short(P.start)}</span>
							</span>
							<span className="dt-arr" aria-hidden="true">
								→
							</span>
							<span className="dt" title="Cycle ends">
								<span className="dt-v">{short(P.end)}</span>
							</span>
						</div>
					</div>
					<div className="s-bar">
						<span className="s-k">{phase === 'now' ? 'Cycle progress' : phase === 'up' ? 'Not started' : 'Finished'}</span>
						<span className={'s-track ' + phase} title={`${fill}% of the cycle has passed`}>
							<i style={{ width: fill + '%' }} />
						</span>
					</div>
					<div className="s-left">
						<div className={'sl ' + tone}>
							<span className="s-k">{phase === 'now' ? 'Days left' : phase === 'up' ? 'Starts in' : 'Ended'}</span>
							<div className="sl-big">
								{phase === 'now' ? (
									<>
										<strong>{left === 0 ? 'Last' : left}</strong>
										<span>{left <= 1 ? 'day' : 'days'}</span>
									</>
								) : phase === 'up' ? (
									<>
										<strong>{daysBetween(today, P.start)}</strong>
										<span>days</span>
									</>
								) : (
									<>
										<strong>{daysBetween(P.end, today)}</strong>
										<span>days ago</span>
									</>
								)}
							</div>
						</div>
					</div>
				</section>
			)}
			<div className="mfilters" aria-label="Filter monthly tasks">
				{[
					['all', 'All tasks'],
					['weekly', 'Weekly'],
					['monthly', 'Monthly'],
				].map(([v, l]) => (
					<button key={v} className="fchip plain" aria-pressed={freq === v} onClick={() => (setFreq(v), setWkSel(null), setSelWeek({}))}>
						{l}
					</button>
				))}
			</div>
			<div className="mcards">
				{list.map((t) => (
					<MonthlyCard
						key={t.id}
						task={t}
						selWeek={weekOf(t)}
						missed={missedOf(t)}
						onSelectWeek={(id, w) => setSelWeek({ ...selWeek, [id]: w === null ? undefined : w })}
						onDetails={(id, w) => setDialog({ type: 'details', id, week: w })}
						onEdit={(id) => setDialog({ type: 'edit', id })}
					/>
				))}
				<button type="button" className="card add-card" aria-label="Add monthly task" onClick={() => setDialog({ type: 'edit', id: null })}>
					<span className="plus" aria-hidden="true">
						+
					</span>
					<b>Add monthly task</b>
					<small>{scope.length ? 'Weekly or monthly, with quantity and who’s responsible' : 'Set up the recurring work for this project'}</small>
				</button>
			</div>
			{dialog && dialog.type === 'edit' && <MonthlyDialog taskId={dialog.id} onClose={() => setDialog(null)} />}
			{dialog && dialog.type === 'details' && (
				<MonthlyDetails taskId={dialog.id} week={dialog.week} missed={missedOf(data.monthly_tasks[dialog.id] || { id: '' })} onClose={() => setDialog(null)} reviewActions={reviewActions} />
			)}
		</>
	);
}
