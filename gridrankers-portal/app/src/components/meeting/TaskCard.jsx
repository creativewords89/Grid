import { usePortal } from '../../context.js';
import { deadlineInfo } from '../../lib/deadline.js';
import { short, localYmd } from '../../lib/format.js';
import { isManager } from '../../lib/roles.js';
import { PRI_LABEL, REVIEW_TXT, assigneesOf, canWorkOn, progressTotal } from '../../lib/tasks.js';
import Avatar from '../Avatar.jsx';
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

// Request undo (SPEC.md 6.6): the pending request on a card, or the link to ask. Team Leaders and
// the Super Admin answer it here or in Needs your approval.
export function UndoLine({ task, me, locked, onRequest, onDecide }) {
	const { data } = usePortal();
	const ask = task.undo_request;
	if (ask && ask.by) {
		const who = data.members[ask.by];
		return (
			<div className="undo-req">
				<b>Undo requested</b> · {who ? who.name : 'someone'} · waiting for a Team Leader
				{ask.reason && <span className="undo-why">“{ask.reason}”</span>}
				{isManager(me) && (
					<span className="undo-acts">
						<button type="button" className="btn small" onClick={() => onDecide('keep')}>
							Keep In progress
						</button>
						<button type="button" className="btn small primary" onClick={() => onDecide('undo')}>
							Undo
						</button>
					</span>
				)}
			</div>
		);
	}
	if (task.status !== 'doing' || isManager(me) || locked || Math.max(1, task.target || 1) > 1) return null;
	return (
		<button type="button" className="linkbtn undo-link" onClick={onRequest}>
			↶ Request undo
		</button>
	);
}

// Compact meeting-task card (SPEC.md 7.2; reference bcard).
export default function TaskCard({ task, onDetails, onEdit }) {
	const { data, me, today } = usePortal();
	const { setStatus, remove, requestUndo, decideUndo } = useTaskActions();
	const members = data.members;
	const st = task.status;
	const open = st !== 'done';
	const dl = deadlineInfo(task, today);
	const target = Math.max(1, task.target || 1);
	const done = progressTotal(task);
	const people = assigneesOf(task, members);
	const locked = !canWorkOn(task, me);
	const lockTitle = `Only ${people.map((a) => members[a.id]?.name).join(', ') || 'the assignee'} can update this`;

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
			<button key={k} type="button" className={'s-' + k} aria-pressed={st === k} disabled={disabled} title={title} onClick={() => setStatus(task, k)}>
				{label}
			</button>
		);
	});

	return (
		<article className={`card mcard st-${st} ${open && (task.priority === 'urgent' || (dl && dl.overdue)) ? 'late' : ''}`}>
			<div className="co-row">
				<span className={'freq pr-' + task.priority}>{PRI_LABEL[task.priority] || 'Normal'}</span>
				{target > 1 && <span className="qty q-strong">Qty {target}</span>}
				{task.meeting_date && <span className="qty">Meeting {short(task.meeting_date)}</span>}
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
			</div>
			<ReviewBadge review={task.review} me={me} members={members} />
			{target > 1 && (
				<div className="mini-prog">
					<span className="mp-bar">
						<i style={{ width: Math.round((done / target) * 100) + '%' }} />
					</span>
					<b>
						{done}/{target}
					</b>
				</div>
			)}
			<div className="seg" role="group" aria-label={`Status of ${task.title}`}>
				{seg}
			</div>
			<UndoLine task={task} me={me} locked={locked} onRequest={() => requestUndo(task)} onDecide={(a) => decideUndo(task, a)} />
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
