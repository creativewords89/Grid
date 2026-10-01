import { usePortal } from '../../context.js';
import { activeWeek, cycleRange, daysBetween, dueAt, isWeekly, monthRange, parts, weekRange, ymd } from '../../lib/cycles.js';
import { localYmd, short } from '../../lib/format.js';
import { bornAt, isShared, isWaived, periodKeyOf, recordOf, stateOf, typePeople } from '../../lib/monthly.js';
import { isManager } from '../../lib/roles.js';
import { assigneesOf, canWorkOn, isAssigned } from '../../lib/tasks.js';
import Avatar from '../Avatar.jsx';
import { MiniReview, People } from '../meeting/TaskCard.jsx';
import useRecordActions from './useRecordActions.js';

// Everything the card and the Details window need about a task in the viewed period.
export function usePeriod(task, selWeek) {
	const { data, cycleOff, today } = usePortal();
	const project = data.projects[task.project_id];
	const wk = isWeekly(task);
	const aw = activeWeek(cycleOff, today);
	const sel = wk ? (selWeek ?? aw) : undefined;
	const range = wk ? monthRange(cycleOff, today) : cycleRange(project, cycleOff, today);
	const periodKey = periodKeyOf(task, project, sel, cycleOff, today);
	const rec = recordOf(data.records, task, project, sel, cycleOff, today);
	return { project, wk, aw, sel, range, periodKey, rec, st: stateOf(task, rec), n: Math.max(1, task.target || 1), count: rec && rec.status !== 'skipped' ? rec.count || 0 : 0 };
}

export function DueChip({ task, period, missed }) {
	const { cycleOff, today } = usePortal();
	const { project, wk, sel, range, rec, st } = period;
	const due = dueAt(task, project, sel, cycleOff, today);
	const left = daysBetween(today, due);
	if (range.end < bornAt(task, project, today)) {
		return (
			<span className="due" title="This task was added after this period">
				Not tracked yet
			</span>
		);
	}
	if (isWaived(task, project, cycleOff, today)) {
		return (
			<span className="due" title="Monthly tasks are waived in this transition cycle">
				Waived · transition
			</span>
		);
	}
	if (missed.length) {
		return (
			<span className="due late pulse" title={missed.map((m) => m.label).join('\n')}>
				⚠ {missed.length} unfinished
			</span>
		);
	}
	if (wk && st === 'done') return <span className="due ok">Week {sel + 1} done</span>;
	if (st === 'done') return <span className="due ok">Done{rec && rec.done_at ? ' ' + short(localYmd(rec.done_at)) : ''}</span>;
	if (due < today) return <span className="due late">{today > range.end ? 'Unfinished' : `Overdue ${daysBetween(due, today)}d`}</span>;
	if (task.due_mode === 'none') return <span className="due">No deadline · this cycle</span>;
	if (task.due_mode === 'dates' && task.due_from_day) {
		const [y, m, d] = parts(range.start);
		const from = ymd(y, m, d + task.due_from_day - 1);
		return (
			<span className={'due ' + (left <= 3 ? 'soon' : '')}>
				Due {short(from)} – {short(due)}
				{left > 0 ? ` · ${left}d left` : ''}
			</span>
		);
	}
	if (today < range.start) return <span className="due">Due {short(due)}</span>;
	return <span className={'due ' + (left <= 3 ? 'soon' : '')}>{left <= 0 ? 'Due today' : left === 1 ? 'Due tomorrow' : `Due ${short(due)} · ${left}d left`}</span>;
}

function Stepper({ got, max, label, onMinus, onPlus, can, plusDisabled }) {
	return (
		<span className="qstep">
			{can && (
				<button type="button" aria-label={`One less${label ? ' ' + label : ''}`} disabled={got <= 0} onClick={onMinus}>
					−
				</button>
			)}
			<span className="qnum">
				<b>{got}</b> / {max}
			</span>
			{can && (
				<button type="button" aria-label={`One more${label ? ' ' + label : ''}`} disabled={got >= max || plusDisabled} onClick={onPlus}>
					+
				</button>
			)}
		</span>
	);
}

// Progress for the Details window: breakdown rows, per-person shares, or one stepper.
export function ProgressBox({ task, period }) {
	const { data, me } = usePortal();
	const { tick } = useRecordActions();
	const members = data.members;
	const { periodKey, rec, wk, sel, aw, n, count, st } = period;
	const locked = !canWorkOn(task, me) || st === 'done';
	const people = assigneesOf(task, members);
	const shared = isShared(task);
	const byPerson = (rec && rec.by_person) || {};
	const pc = (rec && rec.parts) || {};
	const when = wk ? (sel === aw ? 'this week' : `in week ${sel + 1}`) : 'this cycle';
	const mayTick = (id) => st !== 'done' && (isManager(me) || id === me.id);

	if (Array.isArray(task.parts) && task.parts.length) {
		const anyone = st !== 'done' && (isManager(me) || isAssigned(task, me.id) || !people.length);
		return (
			<div className="bdbox">
				<div className="qtop">
					<span className="qlab">
						Breakdown · {count}/{n} done {when}
					</span>
				</div>
				{task.parts.map((x) => {
					const got = pc[x.id] || 0;
					const tpl = typePeople(x, members);
					if (tpl.length > 1) {
						return (
							<div key={x.id} className={'bd-line multi ' + (got >= x.n ? 'full' : '')}>
								<span className="bd-name">
									<span>{x.name}</span>
									<small>
										{got}/{x.n}
									</small>
								</span>
								<span className="shbar">
									<i style={{ width: Math.round((got / x.n) * 100) + '%' }} />
								</span>
								{tpl.map((a) => (
									<div className="bd-sub" key={a.id}>
										<span className="bd-sw">
											<Avatar person={members[a.id]} small />
											{members[a.id].name.split(' ')[0]}
										</span>
										<Stepper
											got={pc[`${x.id}|${a.id}`] || 0}
											max={a.n}
											can={mayTick(a.id)}
											plusDisabled={got >= x.n}
											onMinus={() => tick(task, periodKey, -1, { partId: x.id, memberId: a.id })}
											onPlus={() => tick(task, periodKey, 1, { partId: x.id, memberId: a.id })}
										/>
									</div>
								))}
							</div>
						);
					}
					const xp = tpl.length === 1 ? members[tpl[0].id] : null;
					return (
						<div key={x.id} className={'bd-line ' + (got >= x.n ? 'full' : '')}>
							<span className="bd-name">
								{xp && <Avatar person={xp} small />}
								<span>{x.name}</span>
								{xp && <small>{xp.name.split(' ')[0]}</small>}
							</span>
							<Stepper
								got={got}
								max={x.n}
								label={x.name}
								can={xp ? mayTick(xp.id) : anyone}
								onMinus={() => tick(task, periodKey, -1, { partId: x.id })}
								onPlus={() => tick(task, periodKey, 1, { partId: x.id })}
							/>
							<span className="shbar">
								<i style={{ width: Math.round((got / x.n) * 100) + '%' }} />
							</span>
						</div>
					);
				})}
				{shared && (
					<div className="bd-people">
						{people.map((a) => (
							<span key={a.id}>
								<Avatar person={members[a.id]} small /> {members[a.id].name.split(' ')[0]}{' '}
								<b>
									{byPerson[a.id] || 0}/{a.n}
								</b>
							</span>
						))}
					</div>
				)}
			</div>
		);
	}

	if (shared) {
		return (
			<div className="shbox">
				<div className="qtop">
					<span className="qlab">
						Split between {people.length} people{n > 1 ? ` · ${count}/${n} done` : ''}
					</span>
				</div>
				{people.map((a) => {
					const mine = byPerson[a.id] || 0;
					return (
						<div className="shrow" key={a.id}>
							<span className="shwho">
								<Avatar person={members[a.id]} small />
								<b>{members[a.id].name.split(' ')[0]}</b>
							</span>
							<Stepper
								got={mine}
								max={a.n}
								label={`for ${members[a.id].name}`}
								can={mayTick(a.id)}
								onMinus={() => tick(task, periodKey, -1, { memberId: a.id })}
								onPlus={() => tick(task, periodKey, 1, { memberId: a.id })}
							/>
							<span className="shbar">
								<i style={{ width: Math.round((mine / a.n) * 100) + '%' }} />
							</span>
						</div>
					);
				})}
				<div className="qbar total">
					<i style={{ width: Math.round((count / n) * 100) + '%' }} />
				</div>
			</div>
		);
	}

	if (n > 1) {
		return (
			<div className="qbox">
				<div className="qtop">
					<span className="qlab">Done {when}</span>
					<Stepper got={count} max={n} can={!locked} onMinus={() => tick(task, periodKey, -1)} onPlus={() => tick(task, periodKey, 1)} />
				</div>
				<div className="qbar">
					<i style={{ width: Math.round((count / n) * 100) + '%' }} />
				</div>
			</div>
		);
	}
	return null;
}

// Monthly / weekly task card (SPEC.md 7.3).
export default function MonthlyCard({ task, selWeek, onSelectWeek, missed, onDetails, onEdit }) {
	const { data, me, cycleOff, today } = usePortal();
	const { setStatus, remove } = useRecordActions();
	const period = usePeriod(task, selWeek);
	const { project, wk, aw, sel, range, periodKey, st, n, count } = period;
	const members = data.members;
	const locked = !canWorkOn(task, me);
	const late = missed.length > 0;
	const born = bornAt(task, project, today);

	const seg = [
		['todo', 'Not started'],
		['doing', 'In progress'],
		['done', 'Completed'],
	].map(([k, label]) => (
		<button
			key={k}
			type="button"
			className={'s-' + k}
			aria-pressed={st === k}
			disabled={locked || (st === 'done' && k !== 'done') || (st === 'doing' && k === 'todo' && !isManager(me))}
			title={st === 'done' && k !== 'done' ? 'Completed — reopen with Revise or Reject' : undefined}
			onClick={() => setStatus(task, periodKey, k)}
		>
			{label}
		</button>
	));

	const weeks = wk && (
		<div className="weeks" role="group" aria-label="Weeks this cycle" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
			{[0, 1, 2, 3].map((w) => {
				const r2 = weekRange(w, cycleOff, today);
				const rec2 = recordOf(data.records, task, project, w, cycleOff, today);
				const ws = stateOf(task, rec2);
				const skipped = rec2 && rec2.status === 'skipped';
				const past = r2.end < today && r2.start >= born;
				const cur = w === aw && today >= range.start && today <= range.end;
				const cls = ws === 'done' ? 'wd' : skipped ? 'wsk' : ws === 'doing' ? (past ? 'wl' : 'wp') : past ? 'wl' : '';
				const lab = ws === 'done' ? 'done' : skipped ? 'skipped' : ws === 'doing' ? (past ? 'unfinished (was in progress)' : 'in progress') : past ? 'unfinished' : 'not started';
				return (
					<button
						key={w}
						type="button"
						className={`wk ${cls} ${cur ? 'cur' : ''} ${w === sel ? 'sel' : ''}`}
						aria-pressed={w === sel}
						title={`Week ${w + 1} · ${short(r2.start)}–${short(r2.end)} · ${lab}${cur ? ' · this week' : ''}. Click to select this week`}
						aria-label={`Week ${w + 1}, ${lab}${cur ? ', this week' : ''}`}
						onClick={() => onSelectWeek(task.id, w === aw ? null : w)}
					>
						W{w + 1}
						{ws === 'done' ? ' ✓' : ''}
					</button>
				);
			})}
		</div>
	);

	return (
		<article className={`card mcard st-${st} ${late ? 'late' : ''} ${wk && sel !== aw ? 'off-wk' : ''}`}>
			<div className="co-row">
				<span className={'freq ' + (wk ? 'fw' : 'fm')}>{wk ? 'Weekly' : 'Monthly'}</span>
				<span className="qty" title="Quantity">
					Qty {n} per {wk ? 'week' : 'cycle'}
				</span>
			</div>
			<h3>{task.title}</h3>
			<div className="line">
				<DueChip task={task} period={period} missed={missed} />
				<MiniReview review={period.rec && period.rec.review} me={me} />
			</div>
			{weeks}
			{n > 1 && (
				<div className="mini-prog">
					<span className="mp-bar">
						<i style={{ width: Math.round((count / n) * 100) + '%' }} />
					</span>
					<b>
						{count}/{n}
					</b>
					{Array.isArray(task.parts) && task.parts.length > 0 && <small>{task.parts.length} types</small>}
				</div>
			)}
			<div className="seg" role="group" aria-label={`Status of ${task.title}`}>
				{seg}
			</div>
			<div className="acts">
				<div className="assign">
					<People list={assigneesOf(task, members)} members={members} />
				</div>
				<button className="btn small primary-soft" onClick={() => onDetails(task.id, sel)}>
					Details
				</button>
				{isManager(me) && (
					<button className="btn small" onClick={() => onEdit(task.id)}>
						Edit
					</button>
				)}
				{isManager(me) && (
					<button className="btn small icon-del" aria-label={`Delete ${task.title}`} title="Delete" onClick={() => remove(task)}>
						🗑
					</button>
				)}
			</div>
		</article>
	);
}
