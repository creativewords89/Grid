import { usePortal } from '../../context.js';
import { deadlineInfo } from '../../lib/deadline.js';
import { longDate, localYmd, weekdayDate } from '../../lib/format.js';
import { isManager } from '../../lib/roles.js';
import { GENERAL_NAME, PRI_LABEL, STATUS_TXT, assigneesOf, isGeneral, progressTotal } from '../../lib/tasks.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';
import useTaskActions from './useTaskActions.js';
import ReviewActions from '../review/ReviewActions.jsx';
import Submission from '../review/Submission.jsx';

export function ShareSteppers({ task, members, me, onTick }) {
	const target = Math.max(1, task.target || 1);
	const progress = task.progress || {};
	const people = assigneesOf(task, members);
	const done = progressTotal(task);
	const rows = people.length ? people : [{ id: '', n: target }];
	return (
		<div className="shbox">
			<div className="qtop">
				<span className="qlab">
					{people.length > 1 ? `Split between ${people.length} people · ` : ''}
					{done}/{target} done
				</span>
			</div>
			{rows.map((a) => {
				const got = progress[a.id || '_'] || 0;
				const nm = a.id ? members[a.id].name : 'Unassigned';
				const can = task.status !== 'done' && (isManager(me) || a.id === me.id || !a.id);
				return (
					<div className="shrow" key={a.id || '_'}>
						<span className="shwho">
							{a.id && <Avatar person={members[a.id]} small />}
							<b>{nm.split(' ')[0]}</b>
						</span>
						<span className="qstep">
							{can && (
								<button type="button" aria-label={`One less for ${nm}`} disabled={got <= 0} onClick={() => onTick(task, a.id, -1)}>
									−
								</button>
							)}
							<span className="qnum">
								<b>{got}</b> / {a.n}
							</span>
							{can && (
								<button type="button" aria-label={`One more for ${nm}`} disabled={got >= a.n} onClick={() => onTick(task, a.id, 1)}>
									+
								</button>
							)}
						</span>
						<span className="shbar">
							<i style={{ width: Math.round((got / a.n) * 100) + '%' }} />
						</span>
					</div>
				);
			})}
		</div>
	);
}

// Details window (SPEC.md 7.2): header, info grid, progress, details, page link, completion & review.
export default function TaskDetails({ taskId, onClose }) {
	const { data, me, today } = usePortal();
	const { tick } = useTaskActions();
	const task = data.meeting_tasks[taskId];
	const members = data.members;

	if (!task) {
		return (
			<Modal open onClose={onClose} className="det-dlg">
				<div className="det-body">
					<p>Not found. It may have been deleted.</p>
					<div className="dlg-acts">
						<button className="btn" onClick={onClose}>
							Close
						</button>
					</div>
				</div>
			</Modal>
		);
	}

	const project = data.projects[task.project_id];
	const target = Math.max(1, task.target || 1);
	const dl = deadlineInfo(task, today);
	const people = assigneesOf(task, members);
	const safeUrl = /^https?:\/\//i.test(task.url || '') ? task.url : '';
	const Row = ({ k, children }) =>
		children ? (
			<div>
				<dt>{k}</dt>
				<dd>{children}</dd>
			</div>
		) : null;

	return (
		<Modal open onClose={onClose} className="det-dlg" labelledBy="grpDetTitle">
			<div className="det-body">
				<header className="dt-head">
					<div className="co-row">
						<span className={'freq pr-' + task.priority}>{PRI_LABEL[task.priority] || 'Normal'}</span>
						<span className="qty">Meeting task</span>
						{target > 1 && <span className="qty q-strong">Qty {target}</span>}
						<span className={'dt-st s-' + task.status}>{STATUS_TXT[task.status]}</span>
					</div>
					<h2 id="grpDetTitle">{task.title}</h2>
					<p className="muted">{project ? project.name : isGeneral(task) ? GENERAL_NAME : ''}</p>
				</header>
				<dl className="dt-grid">
					<Row k="Meeting">{task.meeting_date ? weekdayDate(task.meeting_date) : ''}</Row>
					<Row k="Added">{longDate(localYmd(task.created_at))}</Row>
					<Row k="Deadline">{dl ? <span className={dl.overdue ? 't-late' : ''}>{(dl.overdue ? 'Overdue · ' : '') + dl.label}</span> : 'No deadline'}</Row>
					<Row k="Completed">{task.done_at ? longDate(localYmd(task.done_at)) : ''}</Row>
					<Row k="Responsible">
						{people.length
							? people.map((a) => (
									<span className="dt-p" key={a.id}>
										<Avatar person={members[a.id]} small />
										{members[a.id].name}
										{target > 1 && !task.team ? ` · ${a.n}` : ''}
									</span>
								))
							: 'Unassigned'}
					</Row>
				</dl>
				{target > 1 && (
					<section className="dt-sec">
						<h4>Progress</h4>
						<ShareSteppers task={task} members={members} me={me} onTick={tick} />
					</section>
				)}
				{task.notes && (
					<section className="dt-sec">
						<h4>Details</h4>
						<p className="dt-notes">{task.notes}</p>
					</section>
				)}
				{safeUrl && (
					<section className="dt-sec">
						<h4>Page</h4>
						<a className="url" href={safeUrl} target="_blank" rel="noopener noreferrer">
							{safeUrl}
						</a>
					</section>
				)}
				<section className="dt-sec">
					<h4>Submission &amp; review</h4>
					<Submission kind="item" row={task} task={task} title={task.title} />
					<ReviewActions kind="item" id={task.id} review={task.review} done={task.status === 'done'} />
				</section>
			</div>
			<div className="dlg-acts">
				<button type="button" className="btn" onClick={onClose}>
					Close
				</button>
			</div>
		</Modal>
	);
}
