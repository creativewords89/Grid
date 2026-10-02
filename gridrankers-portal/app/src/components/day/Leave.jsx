import { useMemo, useState } from 'react';
import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { addDays } from '../../lib/cycles.js';
import { dayOffKind, daysLeft, leaveDays, monthName, takenInMonth, teamWeekly } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import Modal from '../Modal.jsx';

// First date from today that is not one of the person's days off.
function nextWorkday(data, me, today) {
	const self = data.members[me.id] || me;
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	let d = today;
	for (let i = 0; i < 60 && dayOffKind(d, self, team, daysOff); i++) d = addDays(d, 1);
	return d;
}

// Request (Team Member) or take (Team Leader) day leave (SPEC.md 6.10). The server counts
// and checks again; this shows the same numbers before sending.
export function LeaveDialog({ open, onClose }) {
	const { api, data, dispatch, me, today, toast } = usePortal();
	const start = useMemo(() => nextWorkday(data, me, today), [data, me, today]);
	const [type, setType] = useState('day');
	const [from, setFrom] = useState(start);
	const [to, setTo] = useState(start);
	const [reason, setReason] = useState('');
	const [error, setError] = useState('');
	const lead = me.role === 'lead';

	const self = data.members[me.id] || me;
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const end = to < from ? from : to;
	const months = leaveDays(from, end, self, team, daysOff);
	const total = Object.values(months).reduce((a, b) => a + b, 0);
	const over = Object.entries(months)
		.map(([month, days]) => ({ month, n: takenInMonth(self, month, leaves, team, daysOff) + days - 1 }))
		.filter((o) => o.n > 0);
	const range = from === end ? short(from) : `${short(from)} – ${short(end)}`;

	const submit = async (e) => {
		e.preventDefault();
		if (!total) return setError('Those days are all days off already.');
		try {
			const row = await api.post('leave', { type, from, to: end, reason });
			dispatch({ type: 'upsert', table: 'leave', row });
			toast(lead ? 'Leave taken — approved straight away' : 'Leave requested — your Team Leaders will answer');
			setReason('');
			setError('');
			onClose();
		} catch (err) {
			setError(err.message);
		}
	};

	return (
		<Modal open={open} onClose={onClose} labelledBy="grpLeave">
			<form onSubmit={submit} noValidate>
				<h2 id="grpLeave">{lead ? 'Take day leave' : 'Request day leave'}</h2>
				<label>
					Type
					<select value={type} onChange={(e) => setType(e.target.value)} aria-label="Leave type">
						<option value="day">Day leave</option>
						<option value="sick">Sick leave</option>
					</select>
				</label>
				<div className="row">
					<label>
						From
						<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" required />
					</label>
					<label>
						To
						<input type="date" value={end} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" required />
					</label>
				</div>
				<div className="lv-sum" aria-live="polite">
					<b>
						{total} day{total === 1 ? '' : 's'}
					</b>{' '}
					· {range} {total ? '(days off aren’t counted)' : '— all days off'}
					{over.map((o) => (
						<p key={o.month} className="ap-over">
							This request is {o.n} day{o.n === 1 ? '' : 's'} over. Settled at the end of {monthName(o.month)}: {o.n} day{o.n === 1 ? '' : 's'} deducted from {monthName(o.month)}’s salary.
						</p>
					))}
					<p className="muted">Day leave and sick leave share 1 day each month. An unused day is paid with that month’s salary.</p>
				</div>
				<label>
					Reason (optional)
					<textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
				</label>
				<p className="hint">{lead ? 'Your leave is approved straight away.' : 'Your Team Leaders get a notification. You’ll see their answer on My day.'}</p>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						{lead ? 'Take day leave' : 'Send request'}
					</button>
				</div>
			</form>
		</Modal>
	);
}

// Day leave box (Team Member, Team Leader): days left this month and the button.
export default function DayLeave() {
	const { data, me, today, setView, setTeamPerson } = usePortal();
	const [open, setOpen] = useState(false);
	const month = today.slice(0, 7);
	const self = data.members[me.id] || me;
	const leaves = rowsOf(data, 'leave');
	const left = daysLeft(takenInMonth(self, month, leaves, teamWeekly(data), rowsOf(data, 'days_off')));
	const lead = me.role === 'lead';
	const latest = leaves
		.filter((l) => l.member_id === me.id && l.status === 'approved' && l.to_date >= today && l.decided_by !== me.id)
		.sort((a, b) => a.from_date.localeCompare(b.from_date))[0];
	const pending = leaves.filter((l) => l.member_id === me.id && l.status === 'pending').length;

	return (
		<section className="md-card" aria-labelledby="dlTitle">
			<div className="md-h">
				<h2 id="dlTitle">Day leave</h2>
				<button type="button" className="linkbtn" onClick={() => (setTeamPerson(me.id), setView('team'))}>
					My leave
				</button>
			</div>
			<p className="dl-left">
				<b>{left}</b> day{left === 1 ? '' : 's'} left in {monthName(month)}
			</p>
			{lead && <p className="muted">Your leave is approved straight away.</p>}
			{latest && <p className="muted">Approved: {latest.from_date === latest.to_date ? short(latest.from_date) : `${short(latest.from_date)} – ${short(latest.to_date)}`}.</p>}
			{pending > 0 && (
				<p className="muted">
					{pending} request{pending === 1 ? '' : 's'} waiting for an answer.
				</p>
			)}
			<div>
				<button type="button" className="btn primary" onClick={() => setOpen(true)}>
					{lead ? 'Take day leave' : 'Request day leave'}
				</button>
			</div>
			<LeaveDialog open={open} onClose={() => setOpen(false)} />
		</section>
	);
}
