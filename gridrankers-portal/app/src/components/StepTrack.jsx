import { usePortal } from '../context.js';
import { short, localYmd } from '../lib/format.js';
import { canSetStep, canTickStep, currentStep, dueBadge, stepDue, stepN, stepRows } from '../lib/steps.js';
import Avatar from './Avatar.jsx';

const LABEL = { todo: 'Not started', doing: 'In progress', done: 'Completed' };

// Not started · In progress · Completed for one step (SPEC.md 6.16). Forward is the step's person
// (or a leader) once something is ready; back is leaders only. 🔒 while the step before isn't ready.
function StepStatus({ row, status, done, onStatus }) {
	const { me, viewOnly } = usePortal();
	const locked = row.state === 'wait' && row.status === 'todo';
	return (
		<div className={'seg stp-seg' + (locked ? ' locked' : '')} role="group" aria-label={`Status of ${row.name}`}>
			{['todo', 'doing', 'done'].map((k) => (
				<button
					key={k}
					type="button"
					className={'s-' + k}
					aria-pressed={row.status === k}
					disabled={viewOnly || row.status === k || !canSetStep(me, row, k, status, done)}
					title={locked ? `Waiting for ${row.prev.name}` : undefined}
					onClick={() => onStatus(row, k)}
				>
					{LABEL[k]}
				</button>
			))}
		</div>
	);
}

// + / − for a step with a quantity (each unit; the next step counts what this one finished).
function StepCount({ row, status, done, onTick }) {
	const { me, viewOnly } = usePortal();
	if (row.target <= 1) return null;
	const plus = !viewOnly && canTickStep(me, row, 1, status);
	const minus = !viewOnly && canTickStep(me, row, -1, status) && (!row.next || row.n > stepN(done, row.next.id));
	return (
		<div className="stp-count">
			<span className="stp-bar" aria-hidden="true">
				<i style={{ width: Math.round((row.n / row.target) * 100) + '%' }} />
			</span>
			<span className="stp-n">
				{row.n} of {row.target}
			</span>
			{minus && (
				<button type="button" className="stp-btn" aria-label={`Count back ${row.name}`} title="Count back one" onClick={() => onTick(row, -1)}>
					−
				</button>
			)}
			{plus && (
				<button type="button" className="stp-btn go" aria-label={`${row.name} +1`} title={`${row.name}: one more done`} onClick={() => onTick(row, 1)}>
					+1
				</button>
			)}
		</div>
	);
}

function DueTag({ badge }) {
	if (!badge) return null;
	return <span className={'stp-due t-' + badge.tone}>{badge.text}</span>;
}

const firstName = (members, id) => (members[id] ? members[id].name.split(' ')[0] : '—');

// The card (SPEC.md 6.16, design DEP-K4): "STEP 2 OF 3" with a bar split into steps, then only the
// current step — person, due date, Not started · In progress · Completed (and +1 with a quantity) —
// and who is next. Every step, with its status, is in Details.
export function StepCard({ task, done, status, project, onStatus, onTick }) {
	const { data, today } = usePortal();
	const rows = stepRows(task, done);
	const cur = currentStep(task, done);
	const late = (r) => {
		const d = stepDue(task, r, project, today);
		return !!d && r.status !== 'done' && d < today;
	};
	const bar = (
		<span className="stp-segs" aria-hidden="true">
			{rows.map((r) => (
				<i key={r.id} className={'b-' + (r.status === 'done' ? 'done' : late(r) && r === cur ? 'late' : r === cur ? 'now' : 'todo')} />
			))}
		</span>
	);
	if (!cur) {
		const last = rows[rows.length - 1];
		const fin = (done || {})[last.id] || {};
		return (
			<div className="stpc done" aria-label={`Steps of ${task.title}`}>
				<div className="stpc-top">
					<span className="stpc-badge">All {rows.length} steps done</span>
					{bar}
				</div>
				<span className="stpc-sum">
					Completed{fin.at ? ` ${short(localYmd(fin.at))}` : ''}
					{fin.by && data.members[fin.by] ? ` by ${data.members[fin.by].name}` : ''}
				</span>
			</div>
		);
	}
	const due = stepDue(task, cur, project, today);
	const badge = dueBadge(due, today, false);
	const next = cur.next;
	const nextDue = next ? stepDue(task, next, project, today) : null;
	const sub = [firstName(data.members, cur.member), due ? (badge.tone === 'late' ? badge.text : `due ${short(due)}${badge.left != null && badge.left <= 14 ? ` · ${badge.left} day${badge.left === 1 ? '' : 's'} left` : ''}`) : '', cur.state === 'wait' ? `waiting for ${cur.prev.name}` : ''].filter(Boolean).join(' · ');
	return (
		<div className="stpc" aria-label={`Steps of ${task.title}`}>
			<div className="stpc-top">
				<span className="stpc-badge">
					Step {cur.i + 1} of {rows.length}
				</span>
				{bar}
			</div>
			<div className={'stpc-box' + (badge && badge.tone === 'late' ? ' late' : '')}>
				<div className="stpc-who">
					<Avatar person={data.members[cur.member]} />
					<span>
						<b>{cur.name}</b>
						<small className={badge && badge.tone === 'late' ? 'late' : ''}>{sub}</small>
					</span>
				</div>
				<StepStatus row={cur} status={status} done={done} onStatus={onStatus} />
				<StepCount row={cur} status={status} done={done} onTick={onTick} />
			</div>
			{next && (
				<div className="stpc-next">
					Next: <b>{next.name}</b> · {firstName(data.members, next.member)}
					{nextDue ? ` · ${short(nextDue)}` : ''}
					<span aria-hidden="true">🔒</span>
				</div>
			)}
		</div>
	);
}

// Every step in Details (SPEC.md 6.16): number (✓ / 🔒), name, person, due date, its status and
// what it finished.
export default function StepTrack({ task, done, status, project, onStatus, onTick, title }) {
	const { data, today } = usePortal();
	const rows = stepRows(task, done);
	const note = (r) => {
		const at = ((done || {})[r.id] || {}).at;
		if (r.status === 'done') return `Completed${at ? ' ' + short(localYmd(at)) : ''}`;
		if (r.state === 'wait') return `Waiting for ${r.prev.name}`;
		if (r.prev && r.target > 1) return `${r.waiting} ready`;
		return r.status === 'doing' ? 'In progress' : `${firstName(data.members, r.member)}’s turn`;
	};
	return (
		<ol className="stp" aria-label={`Steps of ${title || task.title}`}>
			{rows.map((r) => (
				<li key={r.id} className={'stp-row s-' + r.state}>
					<div className="stp-head">
						<span className="stp-mark" aria-hidden="true">
							{r.status === 'done' ? '✓' : r.state === 'wait' ? '🔒' : r.i + 1}
						</span>
						<span className="stp-name">{r.name}</span>
						<span className="stp-who">
							<Avatar person={data.members[r.member]} small />
							{firstName(data.members, r.member)}
						</span>
						<DueTag badge={dueBadge(stepDue(task, r, project, today), today, r.status === 'done')} />
					</div>
					<StepStatus row={r} status={status} done={done} onStatus={onStatus} />
					<StepCount row={r} status={status} done={done} onTick={onTick} />
					<span className="stp-note">{note(r)}</span>
				</li>
			))}
		</ol>
	);
}
