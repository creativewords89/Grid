import { useMemo, useState } from 'react';
import { usePortal } from '../../context.js';
import { cycleSetup, lastCycleCount } from '../../lib/cycleSetup.js';
import { isBiweekly, isSplit } from '../../lib/cycles.js';
import { short } from '../../lib/format.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';
import { TAG_LABEL } from '../monthly/MonthlyCard.jsx';

const dueText = (c) => {
	if (c.done) return ['Done', 'f-green'];
	if (c.late) return [`Overdue · ${c.late} day${c.late === 1 ? '' : 's'}`, 'f-red'];
	return [`Due ${new Date(c.due + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`, 'f-amber'];
};

const tagOf = (t) => (isSplit(t) ? (isBiweekly(t) ? 'biweekly' : 'weekly') : { date: 'date', dates: 'dates', none: 'none' }[t.due_mode] || 'monthly');

function Step({ ok, label, sub }) {
	return (
		<div className={'cs-step' + (ok ? ' ok' : '')}>
			<span className="cs-tick" aria-hidden="true">
				{ok ? '✓' : ''}
			</span>
			<span>
				<b>{label}</b> <span className="muted">· {sub}</span>
			</span>
		</div>
	);
}

// One task of last cycle: done vs target, and Looks good / Send feedback.
function ReviewRow({ c, task }) {
	const { api, data, dispatch, toast, today } = usePortal();
	const [writing, setWriting] = useState(false);
	const [note, setNote] = useState('');
	const [busy, setBusy] = useState(false);
	const done = c.reviews[task.id];
	const people = [...new Set([...(task.assignees || []).map((a) => a.id), ...(task.parts || []).flatMap((p) => (p.people || []).map((x) => x.id))])].map((id) => data.members[id]).filter(Boolean);
	const { got, need } = lastCycleCount(data, task, c.project, today);
	const met = got >= need;

	const send = async (ok) => {
		setBusy(true);
		try {
			const row = await api.post(`projects/${c.project.id}/cycle-review`, { task_id: task.id, ok, note: ok ? '' : note.trim() });
			dispatch({ type: 'upsert', table: 'projects', row });
			const sent = ((row.cycle_reviews || {})[c.prev.key] || {})[task.id];
			toast(ok ? 'Marked as looks good' : sent && sent.to && sent.to.length ? 'Feedback sent' : 'Feedback saved — nobody is responsible to send it to');
			setWriting(false);
		} catch (err) {
			toast(err.message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<li className="cs-row">
			<div className="cs-line">
				{people[0] ? <Avatar person={people[0]} small /> : <Avatar person={null} small />}
				<span className="cs-task">
					<b>{task.title}</b>
					<small>
						{people.length ? people.map((p) => p.name).join(', ') : 'Nobody responsible'} · {TAG_LABEL[tagOf(task)]}
					</small>
				</span>
				<span className={'cs-count' + (met ? ' met' : ' short')} title={`${got} of ${need} done last cycle`}>
					<b>
						{got} / {need}
					</b>
					<span className="cs-bar">
						<span style={{ width: Math.round((100 * Math.min(got, need)) / need) + '%' }} />
					</span>
				</span>
				<span className="cs-acts">
					{done && !writing ? (
						<span className={done.ok ? 'cs-ok' : 'cs-fb'} title={done.note || ''}>
							{done.ok ? '✓ Looks good' : '✉ Feedback sent'}
						</span>
					) : (
						<>
							<button type="button" className="btn small" disabled={busy} onClick={() => send(true)}>
								Looks good
							</button>
							<button type="button" className={'btn small' + (writing ? ' primary' : '')} disabled={busy} onClick={() => setWriting(true)}>
								Send feedback
							</button>
						</>
					)}
				</span>
			</div>
			{writing && (
				<div className="cs-fbox">
					<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} aria-label={`Feedback on ${task.title}`} placeholder="What should change next cycle?" autoFocus />
					<div className="cs-fbox-acts">
						<button type="button" className="btn small" onClick={() => setWriting(false)}>
							Cancel
						</button>
						<button type="button" className="btn small primary" disabled={busy || !note.trim()} onClick={() => send(false)}>
							{people.length ? `Send to ${people.length === 1 ? people[0].name : people.length + ' people'}` : 'Save feedback'}
						</button>
					</div>
				</div>
			)}
		</li>
	);
}

export function ReviewCycleDialog({ c, onClose }) {
	return (
		<Modal open onClose={onClose} labelledBy="csTitle" className="list-dlg cs-dlg">
			<div className="ld-head">
				<h2 id="csTitle">Review last cycle · {c.project.name}</h2>
				<button type="button" className="ld-x" aria-label="Close" onClick={onClose}>
					✕
				</button>
			</div>
			<div className="cs-sum">
				<span className="muted">
					Cycle {short(c.prev.start)} – {short(c.prev.end)} · {c.reviewed} of {c.last.length} reviewed · due {short(c.due)}
				</span>
				<span className="pf-bar" aria-hidden="true">
					<span style={{ width: (c.last.length ? Math.round((100 * c.reviewed) / c.last.length) : 100) + '%' }} />
				</span>
			</div>
			<ul className="ld-body cs-list">
				{c.last.map((t) => (
					<ReviewRow key={t.id} c={c} task={t} />
				))}
			</ul>
			<div className="ld-foot">
				<span className="muted">Feedback goes to the people responsible as a notice (bell and Notifications box).</span>
				<button type="button" className="btn" onClick={onClose}>
					Close
				</button>
			</div>
		</Modal>
	);
}

// New cycle setup (SPEC.md 6.11): Team Leaders and the Super Admin, top of My day's left column.
export default function CycleSetup() {
	const { data, today, setProject, setView } = usePortal();
	const list = useMemo(() => cycleSetup(data, today), [data, today]);
	const [open, setOpen] = useState('');
	if (!list.length) return null;
	const current = list.find((c) => c.project.id === open);

	return (
		<section className="md-card" id="cycleSetup" aria-labelledby="csBox">
			<div className="md-h">
				<h2 id="csBox">New cycle setup</h2>
				<span className="muted">Within 3 days of each cycle start</span>
			</div>
			<div className="cs-projects">
				{list.map((c) => {
					const [flag, cls] = dueText(c);
					const assignedOk = c.assigned === c.tasks.length;
					const reviewOk = c.reviewed === c.last.length;
					return (
						<div key={c.project.id} className={'cs-proj ' + (c.done ? 'e-green' : c.late ? 'e-red' : 'e-amber')}>
							<div className="cs-ph">
								<b>{c.project.name}</b>
								<span className={'mp-flag ' + cls}>{flag}</span>
							</div>
							<Step ok={assignedOk} label="Assign monthly tasks" sub={`${c.assigned} of ${c.tasks.length} have people`} />
							{c.prev && <Step ok={reviewOk} label="Review last cycle" sub={`${c.reviewed} of ${c.last.length} reviewed`} />}
							{!c.done && (
								<div className="cs-btns">
									{!assignedOk && (
										<button type="button" className="btn small primary" onClick={() => (setProject(c.project.id), setView('monthly'))}>
											Assign people
										</button>
									)}
									{c.prev && !reviewOk && (
										<button type="button" className={'btn small' + (assignedOk ? ' primary' : '')} onClick={() => setOpen(c.project.id)}>
											Review last cycle
										</button>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
			{current && current.prev && <ReviewCycleDialog c={current} onClose={() => setOpen('')} />}
		</section>
	);
}

