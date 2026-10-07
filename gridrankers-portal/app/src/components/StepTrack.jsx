import { usePortal } from '../context.js';
import { short, localYmd } from '../lib/format.js';
import { canTickStep, stepN, stepRows } from '../lib/steps.js';
import Avatar from './Avatar.jsx';

// The steps of a task on its card (SPEC.md 6.16, design DEP-A): one row per step — its number
// (✓ when finished, 🔒 while nothing is ready), name, person, what it finished, and + for the
// step's person (− for leaders). A step counts only what the step before has finished.
export default function StepTrack({ task, done, status, onTick, title }) {
	const { data, me, viewOnly } = usePortal();
	const rows = stepRows(task, done);
	const first = (id) => (data.members[id] ? data.members[id].name.split(' ')[0] : '—');
	const note = (r) => {
		if (r.state === 'done') {
			const at = ((done || {})[r.id] || {}).at;
			return r.target > 1 ? 'Done' : `Done${at ? ' ' + short(localYmd(at)) : ''}`;
		}
		if (r.state === 'wait') return `Waiting for ${r.prev.name}`;
		if (r.prev && r.target > 1) return `${r.waiting} ready`;
		return r.n > 0 ? 'In progress' : `${first(r.member)}’s turn`;
	};
	return (
		<ol className="stp" aria-label={`Steps of ${title || task.title}`}>
			{rows.map((r) => {
				const plus = !viewOnly && canTickStep(me, r, 1, status);
				const minus = !viewOnly && canTickStep(me, r, -1, status) && (!r.next || r.n > stepN(done, r.next.id));
				return (
					<li key={r.id} className={'stp-row s-' + r.state}>
						<span className="stp-mark" aria-hidden="true">
							{r.state === 'done' ? '✓' : r.state === 'wait' ? '🔒' : r.i + 1}
						</span>
						<span className="stp-name">{r.name}</span>
						<span className="stp-who">
							<Avatar person={data.members[r.member]} small />
							{first(r.member)}
						</span>
						{r.target > 1 ? (
							<span className="stp-bar" aria-hidden="true">
								<i style={{ width: Math.round((r.n / r.target) * 100) + '%' }} />
							</span>
						) : (
							<span className="stp-bar empty" aria-hidden="true" />
						)}
						<span className="stp-n">{r.target > 1 ? `${r.n}/${r.target}` : ''}</span>
						<span className="stp-note">{note(r)}</span>
						<span className="stp-btns">
							{minus && (
								<button type="button" className="stp-btn" aria-label={`Count back ${r.name}`} title="Count back one" onClick={() => onTick(r, -1)}>
									−
								</button>
							)}
							{plus && (
								<button type="button" className="stp-btn go" aria-label={`${r.name} done${r.target > 1 ? ' +1' : ''}`} title={r.target > 1 ? `${r.name}: one more done` : `${r.name}: done`} onClick={() => onTick(r, 1)}>
									{r.target > 1 ? '+1' : '✓'}
								</button>
							)}
						</span>
					</li>
				);
			})}
		</ol>
	);
}
