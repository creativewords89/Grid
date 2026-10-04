import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { leaveDays, monthName, takenInMonth, teamWeekly } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import useReview from '../review/useReview.js';

// "within October's 1 day" / "2 days over, deducted" for a pending request.
function overText(data, leave) {
	const person = data.members[leave.member_id];
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const others = rowsOf(data, 'leave').filter((l) => l.id !== leave.id);
	const parts = Object.entries(leaveDays(leave.from_date, leave.to_date, person, team, daysOff)).map(([month, days]) => {
		const over = takenInMonth(person, month, others, team, daysOff) + days - 1;
		return over > 0 ? `${over} day${over === 1 ? '' : 's'} over in ${monthName(month)}, deducted` : `within ${monthName(month)}’s 1 day`;
	});
	return { text: parts.join(' · '), over: parts.some((p) => p.includes('over')) };
}

// One thing waiting for a Team Leader or the Super Admin, with its buttons (SPEC.md 7.0, design
// NF-C): shown under Waiting for you in Notifications.
export function ApprovalItem({ item }) {
	const { api, data, dispatch, toast, confirm, setProject, setSearch, setView } = usePortal();
	const decide = useReview();

	// Someone asked to undo In progress (SPEC.md 6.6): Undo (back to Not started) or Keep.
	if (item.kind === 'undo') {
		const answer = async (action) => {
			const note = await confirm({
				title: action === 'undo' ? 'Undo to Not started?' : 'Keep In progress?',
				message: `“${item.title}” · ${item.project.name}`,
				input: 'Message (optional)',
				ok: action === 'undo' ? 'Undo' : 'Keep In progress',
			});
			if (note === null || note === false) return;
			const body = { action, note: typeof note === 'string' ? note : '' };
			try {
				if (item.item) dispatch({ type: 'upsert', table: 'meeting_tasks', row: await api.post(`meeting-tasks/${item.item.id}/undo/decide`, body) });
				else {
					const res = await api.post('records/undo/decide', { ...body, taskId: item.task.id, periodKey: item.record.period_key });
					if (res.record) dispatch({ type: 'upsert', table: 'records', row: res.record });
					else dispatch({ type: 'remove', table: 'records', id: res.id });
				}
				toast(action === 'undo' ? 'Undone — back to Not started' : 'Kept In progress');
			} catch (err) {
				toast(err.message);
			}
		};
		return (
			<div className="ap-item">
				<div className="ap-head">
					<Avatar person={item.who} small />
					<b>{item.who ? item.who.name : '—'}</b>
					<span className="mp-flag f-amber">Undo requested</span>
				</div>
				<p>
					<button type="button" className="linkbtn" onClick={() => (setProject(item.project.id), setSearch(item.title), setView(item.tab))}>
						{item.title}
					</button>
					{` · ${item.project.name} · In progress → Not started`}
					{item.undo.reason ? <span className="muted"> · “{item.undo.reason}”</span> : null}
				</p>
				<div className="ap-acts">
					<button type="button" className="btn small" onClick={() => answer('keep')}>
						Keep In progress
					</button>
					<button type="button" className="btn small ok-btn" onClick={() => answer('undo')}>
						Undo
					</button>
				</div>
			</div>
		);
	}

	// Someone asked to untick a keyword box (SPEC.md 6.12): Untick, or Keep ticked.
	if (item.kind === 'untick') {
		const { kw, col, project, ask } = item;
		const answer = async (body, done) => {
			try {
				dispatch({ type: 'upsert', table: 'keywords', row: await api.patch(`keywords/${kw.id}`, body) });
				toast(done);
			} catch (err) {
				toast(err.message);
			}
		};
		return (
			<div className="ap-item">
				<div className="ap-head">
					<Avatar person={item.who} small />
					<b>{item.who ? item.who.name : '—'}</b>
					<span className="mp-flag f-amber">Untick asked</span>
				</div>
				<p>
					<button type="button" className="linkbtn" onClick={() => (setProject(project.id), setView('plan'))}>
						{col.name} · {kw.keyword}
					</button>
					{` · ${project.name}`}
					{ask.note ? <span className="muted"> · “{ask.note}”</span> : null}
				</p>
				<div className="ap-acts">
					<button type="button" className="btn small danger-soft" onClick={() => answer({ check: { column: col.id, on: false } }, 'Unticked')}>
						Untick
					</button>
					<button type="button" className="btn small" onClick={() => answer({ keep: { column: col.id } }, 'Kept ticked')}>
						Keep ticked
					</button>
				</div>
			</div>
		);
	}

	if (item.kind === 'leave') {
		const l = item.leave;
		const range = l.from_date === l.to_date ? short(l.from_date) : `${short(l.from_date)} – ${short(l.to_date)}`;
		const info = overText(data, l);
		const answer = async (action) => {
			const message = await confirm({
				title: action === 'approve' ? `Approve ${item.who.name}’s leave?` : `Reject ${item.who.name}’s leave?`,
				message: `${l.type === 'sick' ? 'Sick leave' : 'Day leave'} · ${range} (${l.days} day${l.days === 1 ? '' : 's'})${l.reason ? ` · “${l.reason}”` : ''}`,
				input: 'Message (optional)',
				placeholder: action === 'approve' ? 'e.g. Enjoy the wedding!' : 'Why not',
				ok: action === 'approve' ? 'Approve' : 'Reject',
				danger: action === 'reject',
			});
			if (message === null) return;
			try {
				dispatch({ type: 'upsert', table: 'leave', row: await api.patch(`leave/${l.id}`, { action, message }) });
				toast(action === 'approve' ? 'Leave approved' : 'Leave rejected');
			} catch (err) {
				toast(err.message);
			}
		};
		return (
			<div className="ap-item">
				<div className="ap-head">
					<Avatar person={item.who} small />
					<b>{item.who.name}</b>
					<span className="mp-flag f-teal">Leave request</span>
				</div>
				<p>
					{l.type === 'sick' ? 'Sick leave' : 'Day leave'} · {range} ({l.days} day{l.days === 1 ? '' : 's'}) · <span className={info.over ? 'ap-over' : 'muted'}>{info.text}</span>
				</p>
				<div className="ap-acts">
					<button type="button" className="btn small ok-btn" onClick={() => answer('approve')}>
						Approve
					</button>
					<button type="button" className="btn small danger-soft" onClick={() => answer('reject')}>
						Reject
					</button>
				</div>
			</div>
		);
	}

	const r = item.review;
	const p = data.projects[r.project_id];
	return (
		<div className="ap-item">
			<div className="ap-head">
				<Avatar person={item.who} small />
				<b>{item.who ? item.who.name : '—'}</b>
				<span className="mp-flag f-purple">{r.review.reviewer ? 'Review asked' : 'Task review'}</span>
			</div>
			<p>
				<button type="button" className="linkbtn" onClick={() => (setProject(r.project_id), setSearch(r.title), setView(r.tab))}>
					{r.title}
				</button>
				{p ? ` · ${p.name}` : ''}
				{r.review.note ? <span className="muted"> · “{r.review.note}”</span> : r.completion && r.completion.note ? <span className="muted"> · “{r.completion.note}”</span> : null}
			</p>
			<div className="ap-acts">
				<button type="button" className="btn small ok-btn" onClick={() => decide(r.kind, r.id, 'accept')}>
					Approve
				</button>
				<button type="button" className="btn small danger-soft" onClick={() => decide(r.kind, r.id, 'revision')}>
					Send back
				</button>
			</div>
		</div>
	);
}
