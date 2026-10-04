import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { DUE_MODE_TEXT, M_STATUS_TXT } from '../../lib/monthly.js';
import { assigneesOf } from '../../lib/tasks.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';
import { DueChip, ProgressBox, usePeriod } from './MonthlyCard.jsx';
import ReviewActions from '../review/ReviewActions.jsx';
import Submission from '../review/Submission.jsx';

export default function MonthlyDetails({ taskId, week, missed, onClose }) {
	const { data } = usePortal();
	const task = data.monthly_tasks[taskId];
	const period = usePeriod(task || { project_id: '', freq: 'monthly' }, week);
	if (!task || !period.project) {
		return (
			<Modal open onClose={onClose} className="det-dlg">
				<div className="det-body">
					<p>Not found. It may have been deleted.</p>
				</div>
				<div className="dlg-acts">
					<button className="btn" onClick={onClose}>
						Close
					</button>
				</div>
			</Modal>
		);
	}
	const members = data.members;
	const { wk, sel, range, rec, st, n, name, unit, freqLabel, tag } = period;
	const people = assigneesOf(task, members);
	const hasParts = Array.isArray(task.parts) && task.parts.length > 0;

	return (
		<Modal open onClose={onClose} className="det-dlg" labelledBy="grpMDetTitle">
			<div className="det-body">
				<header className="dt-head">
					<div className="co-row">
						<span className={'freq dlt-' + tag}>{freqLabel}</span>
						<span className="qty q-strong">
							Qty {n} per {wk ? unit : 'cycle'}
						</span>
						<span className={'dt-st s-' + st}>{M_STATUS_TXT[st]}</span>
					</div>
					<h2 id="grpMDetTitle">{task.title}</h2>
					<p className="muted">
						{period.project.name}
						{wk ? ` · showing ${name(sel).toLowerCase()}` : ` · cycle ${short(range.start)} – ${short(range.end)}`}
					</p>
				</header>
				<dl className="dt-grid">
					<div>
						<dt>Deadline</dt>
						<dd>{DUE_MODE_TEXT(task)}</dd>
					</div>
					<div>
						<dt>Due</dt>
						<dd>
							<DueChip task={task} period={period} missed={missed} />
						</dd>
					</div>
					<div>
						<dt>Responsible</dt>
						<dd>
							{people.length
								? people.map((a) => (
										<span className="dt-p" key={a.id}>
											<Avatar person={members[a.id]} small />
											{members[a.id].name}
											{!task.team && people.length > 1 ? ` · ${a.n}` : ''}
										</span>
									))
								: 'Unassigned'}
						</dd>
					</div>
				</dl>
				{(hasParts || n > 1 || (!task.team && people.length > 1)) && (
					<section className="dt-sec">
						<h4>{hasParts ? 'Breakdown & progress' : 'Progress'}</h4>
						<ProgressBox task={task} period={period} />
					</section>
				)}
				{task.notes && (
					<section className="dt-sec">
						<h4>Details</h4>
						<p className="dt-notes">{task.notes}</p>
					</section>
				)}
				<section className="dt-sec">
					<h4>Submission &amp; review</h4>
					<Submission kind="record" row={rec} task={task} title={task.title} />
					{rec && <ReviewActions kind="record" id={rec.id} review={rec.review} done={st === 'done'} />}
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
