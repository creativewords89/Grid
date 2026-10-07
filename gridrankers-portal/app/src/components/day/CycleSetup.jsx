import { useMemo, useState } from 'react';
import { usePortal } from '../../context.js';
import { allReminders, cycleSetup, lastCycleCount } from '../../lib/cycleSetup.js';
import { isBiweekly, isSplit } from '../../lib/cycles.js';
import { itemDeadline } from '../../lib/deadline.js';
import { short } from '../../lib/format.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';
import { TAG_LABEL } from '../monthly/MonthlyCard.jsx';
import { openRequest } from '../../lib/requests.js';

const dueText = (c) => {
	if (c.done) return ['Done', 'f-green'];
	if (c.late) return [`Overdue · ${c.late} day${c.late === 1 ? '' : 's'}`, 'f-red'];
	return [`${c.left} day${c.left === 1 ? '' : 's'} left · due ${new Date(c.due + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`, 'f-amber'];
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

// One task of last cycle: done vs target (monthly) or Done / Open (meeting), and Looks good /
// Send feedback; an open meeting task can also be carried over with a new deadline.
function ReviewRow({ c, task, meeting = false }) {
	const { api, data, dispatch, toast, today } = usePortal();
	const [writing, setWriting] = useState(false);
	const [carrying, setCarrying] = useState(false);
	const [note, setNote] = useState('');
	const [carry, setCarry] = useState(c.cycle.end);
	const [busy, setBusy] = useState(false);
	const done = c.reviews[task.id];
	const people = [...new Set([...(task.assignees || []).map((a) => a.id), ...(task.parts || []).flatMap((p) => (p.people || []).map((x) => x.id))])].map((id) => data.members[id]).filter(Boolean);
	const { got, need } = meeting ? { got: 0, need: 0 } : lastCycleCount(data, task, c.project, today);
	const met = got >= need;
	const due = meeting ? itemDeadline(task) : null;
	const open = meeting && task.status !== 'done';

	const send = async (body) => {
		setBusy(true);
		try {
			const row = await api.post(`projects/${c.project.id}/cycle-review`, { task_id: task.id, ...body });
			dispatch({ type: 'upsert', table: 'projects', row });
			if (body.carry) {
				const moved = await api.get(`meeting-tasks/${task.id}`);
				dispatch({ type: 'upsert', table: 'meeting_tasks', row: moved });
			}
			const sent = ((row.cycle_reviews || {})[c.prev.key] || {})[task.id];
			toast(body.carry ? `Carried over to ${short(body.carry)}` : body.ok ? 'Marked as looks good' : sent && sent.to && sent.to.length ? 'Feedback sent' : 'Feedback saved — nobody is responsible to send it to');
			setWriting(false);
			setCarrying(false);
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
						{people.length ? people.map((p) => p.name).join(', ') : 'Nobody responsible'} · {meeting ? `Meeting${due ? ` · due ${short(due.end)}` : ''}` : TAG_LABEL[tagOf(task)]}
					</small>
				</span>
				{meeting ? (
					<span className={'mp-flag ' + (open ? 'f-amber' : 'f-green')}>{open ? 'Open' : 'Done'}</span>
				) : (
					<span className={'cs-count' + (met ? ' met' : ' short')} title={`${got} of ${need} done last cycle`}>
						<b>
							{got} / {need}
						</b>
						<span className="cs-bar">
							<span style={{ width: Math.round((100 * Math.min(got, need)) / need) + '%' }} />
						</span>
					</span>
				)}
				<span className="cs-acts">
					{done && !writing ? (
						<span className={done.ok ? 'cs-ok' : 'cs-fb'} title={done.note || ''}>
							{done.carry ? `↷ Carried over · ${short(done.carry)}` : done.ok ? '✓ Looks good' : '✉ Feedback sent'}
						</span>
					) : (
						<>
							<button type="button" className="btn small" disabled={busy} onClick={() => send({ ok: true })}>
								Looks good
							</button>
							<button type="button" className={'btn small' + (writing ? ' primary' : '')} disabled={busy} onClick={() => (setWriting(true), setCarrying(false))}>
								Send feedback
							</button>
							{open && (
								<button type="button" className={'btn small' + (carrying ? ' primary' : '')} disabled={busy} onClick={() => (setCarrying(true), setWriting(false))}>
									Carry over
								</button>
							)}
						</>
					)}
				</span>
			</div>
			{carrying && (
				<div className="cs-fbox cs-carry">
					<label>
						New deadline
						<input type="date" value={carry} min={today} onChange={(e) => setCarry(e.target.value)} aria-label={`New deadline for ${task.title}`} />
					</label>
					<div className="cs-fbox-acts">
						<button type="button" className="btn small" onClick={() => setCarrying(false)}>
							Cancel
						</button>
						<button type="button" className="btn small primary" disabled={busy || !carry || carry < today} onClick={() => send({ carry })}>
							Carry over
						</button>
					</div>
				</div>
			)}
			{writing && (
				<div className="cs-fbox">
					<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} aria-label={`Feedback on ${task.title}`} placeholder="What should change next cycle?" autoFocus />
					<div className="cs-fbox-acts">
						<button type="button" className="btn small" onClick={() => setWriting(false)}>
							Cancel
						</button>
						<button type="button" className="btn small primary" disabled={busy || !note.trim()} onClick={() => send({ ok: false, note: note.trim() })}>
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
					Cycle {short(c.prev.start)} – {short(c.prev.end)} · {c.reviewed + c.meetingReviewed} of {c.last.length + c.meeting.length} reviewed · due {short(c.due)}
				</span>
				<span className="pf-bar" aria-hidden="true">
					<span style={{ width: (c.last.length + c.meeting.length ? Math.round((100 * (c.reviewed + c.meetingReviewed)) / (c.last.length + c.meeting.length)) : 100) + '%' }} />
				</span>
			</div>
			<div className="ld-body cs-parts">
				<h3 className="cs-h">
					Monthly tasks <span className="muted">· {c.reviewed} of {c.last.length} reviewed</span>
				</h3>
				<ul className="cs-list" aria-label="Monthly tasks">
					{c.last.map((t) => (
						<ReviewRow key={t.id} c={c} task={t} />
					))}
				</ul>
				<h3 className="cs-h">
					Meeting minutes <span className="muted">· {c.meeting.length ? `${c.meetingReviewed} of ${c.meeting.length} reviewed · due or finished last cycle` : 'none due or finished last cycle'}</span>
				</h3>
				{c.meeting.length > 0 && (
					<ul className="cs-list" aria-label="Meeting minutes">
						{c.meeting.map((t) => (
							<ReviewRow key={t.id} c={c} task={t} meeting />
						))}
					</ul>
				)}
			</div>
			<div className="ld-foot">
				<span className="muted">Feedback goes to the people responsible (bell and Notifications box). Carry over moves an open meeting task into this cycle.</span>
				<button type="button" className="btn" onClick={onClose}>
					Close
				</button>
			</div>
		</Modal>
	);
}

// What a setup reminder's button does: Open setup → the New cycle setup box; Assign people → the
// project's Monthly Tasks.
export function useReminderAction() {
	const { setProject, setView } = usePortal();
	return (r) => {
		if (r.kind === 'invoice') {
			setView('invoices');
			return;
		}
		if (r.kind === 'chase') {
			setProject(r.project.id);
			setView('details');
			openRequest(r.request);
			return;
		}
		if (r.kind === 'unassigned') {
			setProject(r.project.id);
			setView('monthly');
			return;
		}
		window.dispatchEvent(new Event('grp:cycle-setup'));
	};
}

// The setup and invoice reminders at the top of Notifications (SPEC.md 6.11, 6.14): no dismiss,
// no Mark all read — each goes away when its work is done.
export function SetupReminders() {
	const { data, me, today, viewOnly } = usePortal();
	const list = useMemo(() => allReminders(data, me, today), [data, me, today]);
	const act = useReminderAction();
	if (!list.length) return null;
	return (
		<div className="nf-must" aria-label="Until it’s done">
			{list.map((r) => (
				<div key={r.key} className={'nf-must-item t-' + r.tone}>
					<span className="nf-ic" aria-hidden="true">
						{r.kind === 'unassigned' ? '👤' : r.kind === 'invoice' ? '🧾' : r.kind === 'chase' ? '✉' : '!'}
					</span>
					<span className="nf-body">
						<span className="nf-top">
							<b>{r.title}</b>
							<small>Today</small>
						</span>
						{!viewOnly && (
							<button type="button" className="btn small" onClick={() => act(r)}>
								{r.ok}
							</button>
						)}
					</span>
				</div>
			))}
		</div>
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
				<span className="muted">Within 3 days of each cycle start · reminders every day until done</span>
			</div>
			<div className="cs-projects">
				{list.map((c) => {
					const [flag, cls] = dueText(c);
					const assignedOk = c.assigned === c.tasks.length;
					const reviewOk = c.reviewed === c.last.length && c.meetingReviewed === c.meeting.length;
					return (
						<div key={c.project.id} className={'cs-proj ' + (c.done ? 'e-green' : c.late ? 'e-red' : 'e-amber')}>
							<div className="cs-ph">
								<b>{c.project.name}</b>
								<span className={'mp-flag ' + cls}>{flag}</span>
							</div>
							<Step ok={assignedOk} label="Assign monthly tasks" sub={`${c.assigned} of ${c.tasks.length} have people`} />
							{c.prev && <Step ok={c.reviewed === c.last.length} label="Review monthly tasks" sub={`${c.reviewed} of ${c.last.length} reviewed`} />}
							{c.prev && <Step ok={c.meetingReviewed === c.meeting.length} label="Review meeting minutes" sub={`${c.meetingReviewed} of ${c.meeting.length} reviewed`} />}
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

