import { useState } from 'react';
import { usePortal } from '../../context.js';
import { deadlineInfo } from '../../lib/deadline.js';
import { short, localYmd } from '../../lib/format.js';
import { isManager } from '../../lib/roles.js';
import { assigneesOf, canWorkOn, isGeneral, PRI_LABEL, progressTotal, REVIEW_TXT } from '../../lib/tasks.js';
import { hasSteps } from '../../lib/steps.js';
import Avatar from '../Avatar.jsx';
import { StepCard } from '../StepTrack.jsx';
import useTaskActions from './useTaskActions.js';

export function People({ list, members }) {
	if (!list.length) {
		return (
			<>
				<span className="av none" title="Unassigned">
					?
				</span>
				<span className="shn na">Not assigned</span>
			</>
		);
	}
	return (
		<>
			<span className="av-stack" title={list.map((a) => members[a.id]?.name).filter(Boolean).join(', ')}>
				{list.slice(0, 5).map((a) => (
					<Avatar key={a.id} person={members[a.id]} small />
				))}
				{list.length > 5 && <span className="av-more">+{list.length - 5}</span>}
			</span>
			<span className="shn">
				{list.length} {list.length === 1 ? 'person' : 'people'}
			</span>
		</>
	);
}

export function MiniReview({ review, me }) {
	if (!review || review.state === 'accepted') return null;
	if (review.state === 'pending') return <span className="mini-rv p">Awaiting review</span>;
	if (!isManager(me) && review.submittedBy !== me.id) return null;
	return <span className={'mini-rv ' + (review.state === 'revision' ? 'r' : 'x')}>{REVIEW_TXT[review.state]}</span>;
}

// The submitter's own revision / rejection with the reviewer's note (SPEC.md 6.6).
export function ReviewBadge({ review, me, members }) {
	if (!review || !['revision', 'rejected'].includes(review.state) || isManager(me) || review.submittedBy !== me.id) return null;
	return (
		<div className={'rv rv-' + review.state}>
			<span className="rv-tag">{REVIEW_TXT[review.state]}</span>
			<span className="rv-who">{review.by && members[review.by] ? `by ${members[review.by].name}` : ''}</span>
			{review.note && <span className="rv-note">“{review.note}”</span>}
		</div>
	);
}

// Request undo (SPEC.md 6.6, design TC-A): a pending request is a small chip — the reason is not
// on the card. Team Leaders and the Super Admin click Review to read it and answer (or use
// Waiting for you in Notifications); the member sees who it waits for.
export function UndoLine({ task, me, locked, onRequest, onDecide }) {
	const { data } = usePortal();
	const [open, setOpen] = useState(false);
	const [note, setNote] = useState('');
	const ask = task.undo_request;
	if (ask && ask.by) {
		const who = data.members[ask.by];
		if (!isManager(me)) {
			return (
				<div className="undo-line">
					<span className="undo-chip">↶ Undo requested</span>
					<span className="muted">waiting for a Team Leader or Super Admin</span>
				</div>
			);
		}
		const decide = (action) => {
			setOpen(false);
			onDecide(action, note.trim());
			setNote('');
		};
		return (
			<>
				<div className="undo-line">
					<span className="undo-chip">↶ Undo requested{who ? ' · ' + who.name : ''}</span>
					<button type="button" className="linkbtn undo-review" aria-expanded={open} onClick={() => setOpen(!open)}>
						{open ? 'Close' : 'Review'}
					</button>
				</div>
				{open && (
					<div className="undo-pop" role="group" aria-label="Undo request">
						<span>
							In progress → <b>Not started</b>
						</span>
						{ask.reason && <span className="undo-why">“{ask.reason}”</span>}
						<input type="text" className="undo-note" placeholder="Message (optional)" aria-label="Message (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
						<span className="undo-acts">
							<button type="button" className="btn small" onClick={() => decide('keep')}>
								Keep In progress
							</button>
							<button type="button" className="btn small primary" onClick={() => decide('undo')}>
								Undo
							</button>
						</span>
					</div>
				)}
			</>
		);
	}
	if (task.status !== 'doing' || isManager(me) || locked || Math.max(1, task.target || 1) > 1) return null;
	return (
		<button type="button" className="linkbtn undo-link" onClick={onRequest}>
			↶ Request undo
		</button>
	);
}

// A Team Member can't work on a task until someone is assigned (SPEC.md 6.6).
export function UnassignedLock({ task, me }) {
	if (isManager(me) || (task.assignees || []).length || task.status === 'done') return null;
	return <div className="lock-line">🔒 Assign someone before work starts — ask a Team Leader.</div>;
}

// Compact meeting-task card (SPEC.md 7.2; reference bcard).
export default function TaskCard({ task, onDetails, onEdit }) {
	const { data, me, today } = usePortal();
	const { setStatus, tickStep, setStep, remove, requestUndo, decideUndo } = useTaskActions();
	const steps = hasSteps(task);
	const members = data.members;
	const st = task.status;
	const open = st !== 'done';
	const dl = deadlineInfo(task, today);
	const target = Math.max(1, task.target || 1);
	const done = progressTotal(task);
	const people = assigneesOf(task, members);
	const locked = !canWorkOn(task, me);
	const pending = !!(task.undo_request && task.undo_request.by);
	const lockTitle = people.length ? `Only ${people.map((a) => members[a.id]?.name).join(', ')} can update this` : 'Not assigned — a Team Leader or Super Admin must assign it first';

	const seg = [
		['todo', 'Not started'],
		['doing', 'In progress'],
		['done', 'Completed'],
	].map(([k, label]) => {
		let title;
		let disabled = false;
		if (st === 'done' && k !== 'done') {
			disabled = true;
			title = 'Completed — reopen with Revise or Reject';
		} else if (st === 'doing' && k === 'todo' && !isManager(me)) {
			disabled = true;
			title = 'In progress — only a Team Leader or Super Admin can move it back';
		}
		if (locked) {
			disabled = true;
			title = lockTitle;
		}
		return (
			<button key={k} type="button" className={'s-' + k + (st === k && pending ? ' undo-dot' : '')} aria-pressed={st === k} disabled={disabled} title={title} onClick={() => setStatus(task, k)}>
				{label}
			</button>
		);
	});

	return (
		<article className={`card mcard st-${st} ${open && (task.priority === 'urgent' || (dl && dl.overdue)) ? 'late' : ''}`}>
			<div className="co-row">
				<span className={'freq pr-' + task.priority}>{PRI_LABEL[task.priority] || 'Normal'}</span>
				{target > 1 && <span className="qty q-strong">Qty {target}</span>}
				{isGeneral(task) ? <span className="qty">General</span> : task.meeting_date && <span className="qty">Meeting {short(task.meeting_date)}</span>}
			</div>
			<h3>{task.title}</h3>
			<div className="line">
				{st === 'done' ? <span className="due ok">Completed{task.done_at ? ' ' + short(localYmd(task.done_at)) : ''}</span> : <span className="due">Added {short(localYmd(task.created_at))}</span>}
				{dl && (
					<span className={`due dl-${dl.type} ${dl.overdue ? 'late' : dl.soon ? 'soon' : ''}`} title={dl.label}>
						{dl.overdue ? 'Overdue · ' : ''}
						{dl.label}
					</span>
				)}
				<MiniReview review={task.review} me={me} />
				{(task.files || []).length > 0 && (
					<span className="att-chip" title={task.files.map((f) => f.name).join(', ')}>
						📎 {task.files.length}
					</span>
				)}
			</div>
			<ReviewBadge review={task.review} me={me} members={members} />
			{steps && <StepCard task={task} done={task.step_done} status={st} onStatus={(row, to) => setStep(task, row, to)} onTick={(row, delta) => tickStep(task, row, delta)} />}
			{!steps && target > 1 && (
				<div className="mini-prog">
					<span className="mp-bar">
						<i style={{ width: Math.round((done / target) * 100) + '%' }} />
					</span>
					<b>
						{done}/{target}
					</b>
				</div>
			)}
			{!steps && (
				<div className="seg" role="group" aria-label={`Status of ${task.title}`}>
					{seg}
				</div>
			)}
			<UnassignedLock task={task} me={me} />
			{!steps && <UndoLine task={task} me={me} locked={locked} onRequest={() => requestUndo(task)} onDecide={(a, note) => decideUndo(task, a, note)} />}
			<div className="acts">
				<div className="assign">
					<People list={people} members={members} />
				</div>
				<button className="btn small primary-soft" onClick={() => onDetails(task.id)}>
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
