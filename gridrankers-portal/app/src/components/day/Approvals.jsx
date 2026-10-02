import { useMemo, useState } from 'react';
import { usePortal } from '../../context.js';
import { approvals } from '../../lib/day.js';
import { short } from '../../lib/format.js';
import { leaveDays, monthName, takenInMonth, teamWeekly } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';
import useReview from '../review/useReview.js';

const SHOWN = 2;

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

function Item({ item }) {
	const { api, data, dispatch, toast, confirm, setProject, setSearch, setView } = usePortal();
	const decide = useReview();

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

// Needs your approval (Team Leader, Super Admin): leave requests and work to check.
export default function Approvals() {
	const { data, me } = usePortal();
	const [all, setAll] = useState(false);
	const list = useMemo(() => approvals(data, me), [data, me]);

	return (
		<section className="md-card md-grow" aria-labelledby="apTitle">
			<div className="md-h">
				<h2 id="apTitle">Needs your approval</h2>
				{list.length > SHOWN && (
					<button type="button" className="linkbtn" onClick={() => setAll(true)}>
						View all {list.length}
					</button>
				)}
			</div>
			{list.length === 0 ? (
				<div className="md-empty">
					<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--done)" strokeWidth="1.8" aria-hidden="true">
						<circle cx="12" cy="12" r="9" />
						<path d="M8 12.5l2.5 2.5L16 9.5" />
					</svg>
					<b>Nothing waiting for you</b>
					<span>Leave requests and finished tasks to check will show here.</span>
				</div>
			) : (
				<div className="ap-list">
					{list.slice(0, SHOWN).map((i) => (
						<Item key={i.kind + i.id} item={i} />
					))}
				</div>
			)}
			<Modal open={all} onClose={() => setAll(false)} labelledBy="apAll" className="ap-dlg">
				<h2 id="apAll">Needs your approval</h2>
				<div className="ap-list">
					{list.map((i) => (
						<Item key={i.kind + i.id} item={i} />
					))}
				</div>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={() => setAll(false)}>
						Close
					</button>
				</div>
			</Modal>
		</section>
	);
}
