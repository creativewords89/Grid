import { MAX_STEPS, PRESETS, newStepId } from '../lib/steps.js';

// "Who does it" in the task dialogs (SPEC.md 6.16, designs DEP-B, DEP-F): One step (the people picker,
// as before) or Steps in order — 2 to 4 steps, each with a name, one person and a due date (meeting
// tasks) or day of the cycle (monthly tasks), moved with ↑ ↓.
export function WhoToggle({ on, onChange, disabled }) {
	return (
		<span className="stp-toggle" role="group" aria-label="Who does it">
			<button type="button" aria-pressed={!on} disabled={disabled} onClick={() => onChange(false)}>
				One step
			</button>
			<button type="button" aria-pressed={on} disabled={disabled} onClick={() => onChange(true)}>
				Steps in order
			</button>
		</span>
	);
}

export const presetRows = (names, rows = []) => names.map((name, i) => ({ id: (rows[i] && rows[i].id) || newStepId(), name, member: (rows[i] && rows[i].member) || '', due: (rows[i] && rows[i].due) || null }));

export default function StepsEditor({ members, value, onChange, disabled, dueKind = 'date' }) {
	const active = members.filter((m) => m.active !== 0 && m.active !== '0').sort((a, b) => a.name.localeCompare(b.name));
	const put = (i, patch) => onChange(value.map((r, k) => (k === i ? { ...r, ...patch } : r)));
	const move = (i, to) => {
		const next = [...value];
		next.splice(to, 0, next.splice(i, 1)[0]);
		onChange(next);
	};
	return (
		<div className="stp-edit">
			<ol>
				{value.map((r, i) => (
					<li key={r.id}>
						<span className="stp-num" aria-hidden="true">
							{i + 1}
						</span>
						<input type="text" value={r.name} maxLength={40} placeholder={['Write', 'Edit', 'Proofread', 'Publish'][i] || 'Step'} aria-label={`Step ${i + 1} name`} disabled={disabled} onChange={(e) => put(i, { name: e.target.value })} />
						<select value={r.member} aria-label={`Who does step ${i + 1}`} disabled={disabled} onChange={(e) => put(i, { member: e.target.value })}>
							<option value="">Who?</option>
							{active.map((m) => (
								<option key={m.id} value={m.id}>
									{m.name}
								</option>
							))}
						</select>
						{dueKind === 'none' ? null : dueKind === 'day' ? (
							<input type="number" className="stp-due-in" min={1} max={31} inputMode="numeric" placeholder="Day" value={r.due ?? ''} aria-label={`Step ${i + 1} due on day`} title="Day of the cycle" disabled={disabled} onChange={(e) => put(i, { due: e.target.value === '' ? null : e.target.value })} />
						) : (
							<input type="date" className="stp-due-in" value={r.due || ''} aria-label={`Step ${i + 1} due`} disabled={disabled} onChange={(e) => put(i, { due: e.target.value || null })} />
						)}
						<span className="stp-moves">
							<button type="button" className="stp-mv" aria-label={`Move step ${i + 1} up`} disabled={disabled || i === 0} onClick={() => move(i, i - 1)}>
								↑
							</button>
							<button type="button" className="stp-mv" aria-label={`Move step ${i + 1} down`} disabled={disabled || i === value.length - 1} onClick={() => move(i, i + 1)}>
								↓
							</button>
							<button type="button" className="stp-mv x" aria-label={`Remove step ${i + 1}`} disabled={disabled} onClick={() => onChange(value.filter((_, k) => k !== i))}>
								×
							</button>
						</span>
					</li>
				))}
			</ol>
			{!disabled && (
				<div className="stp-more">
					{value.length < MAX_STEPS && (
						<button type="button" className="linkbtn" onClick={() => onChange([...value, { id: newStepId(), name: '', member: '' }])}>
							+ Add a step
						</button>
					)}
					<span className="muted">Quick:</span>
					{PRESETS.map((p) => (
						<button key={p.join()} type="button" className="linkbtn stp-preset" onClick={() => onChange(presetRows(p, value))}>
							{p.join(' → ')}
						</button>
					))}
				</div>
			)}
			<span className="hint">
				Each step starts when the one before is completed; its person is told. {dueKind === 'day' ? 'Due: a day of the cycle (optional), on or after the step before — the last one is the task’s due day.' : 'Due dates are optional, each on or after the one before — the last one is the task’s deadline.'}
			</span>
		</div>
	);
}
