import { useMemo, useState } from 'react';
import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { addDays } from '../../lib/cycles.js';
import { EMPLOYMENT, MEMBER_TAB_KEY, balance, dayOffKind, employmentOf, hasLeave, leaveDays, overBy, teamWeekly } from '../../lib/people.js';
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

// Request (Team Member) or take (Team Leader) casual or sick leave (SPEC.md 6.10, design HOL-3). The
// server counts and checks again; this shows the same numbers before sending.
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
	const left = balance(self, +from.slice(0, 4), leaves, team, daysOff);
	const over = total ? overBy(self, { id: '', type, from_date: from, to_date: end }, leaves, team, daysOff) : 0;
	const paid = hasLeave(self);
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
				<h2 id="grpLeave">{paid ? (lead ? 'Take leave' : 'Request leave') : lead ? 'Take unpaid leave' : 'Request unpaid leave'}</h2>
				<label>
					Type
					<select value={type} onChange={(e) => setType(e.target.value)} aria-label="Leave type">
						<option value="day">Casual{paid ? ` · ${left.day.left} of ${left.day.allowance} left` : ''}</option>
						<option value="sick">Sick{paid ? ` · ${left.sick.left} of ${left.sick.allowance} left` : ''}</option>
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
					· {range} {total ? '(days off and festival holidays aren’t counted)' : '— all days off'}
					{over > 0 && (
						<p className="ap-over">
							{paid ? `${over} day${over === 1 ? '' : 's'} over the allowance · deducted from salary` : `Unpaid · ${over} day${over === 1 ? '' : 's'} deducted from salary`}
						</p>
					)}
					<p className="muted">{paid ? '10 casual and 14 sick days a year (Jan 1 – Dec 31). Unused days are paid with December’s salary.' : `${EMPLOYMENT[employmentOf(self)]}s have no leave days: leave is unpaid.`}</p>
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
						{lead ? 'Take leave' : 'Send request'}
					</button>
				</div>
			</form>
		</Modal>
	);
}

// Leave box (Team Member, Team Leader): casual and sick days left this year and the button.
export default function DayLeave({ bare = false }) {
	const { data, me, today, setView, setTeamPerson, viewOnly } = usePortal();
	const [open, setOpen] = useState(false);
	const year = today.slice(0, 4);
	const self = data.members[me.id] || me;
	const leaves = rowsOf(data, 'leave');
	const left = balance(self, +year, leaves, teamWeekly(data), rowsOf(data, 'days_off'));
	const lead = me.role === 'lead';
	const latest = leaves
		.filter((l) => l.member_id === me.id && l.status === 'approved' && l.to_date >= today && l.decided_by !== me.id)
		.sort((a, b) => a.from_date.localeCompare(b.from_date))[0];
	const pending = leaves.filter((l) => l.member_id === me.id && l.status === 'pending').length;
	const openMine = () => {
		try {
			window.sessionStorage.setItem(MEMBER_TAB_KEY, 'leave');
		} catch (e) {
			/* opens on the first tab */
		}
		setTeamPerson(me.id);
		setView('team');
	};

	// `bare`: one half of the Today card (design NF-A) instead of its own card.
	const Box = bare ? 'div' : 'section';
	return (
		<Box className={bare ? 'td-half' : 'md-card'} aria-labelledby="dlTitle">
			<div className="md-h">
				<h2 id="dlTitle">Leave</h2>
				<button type="button" className="linkbtn" onClick={openMine}>
					My leave
				</button>
			</div>
			{hasLeave(self) ? (
				<p className="dl-left">
					<b>{left.day.left}</b> casual · <b>{left.sick.left}</b> sick days left in {year}
				</p>
			) : (
				<p className="dl-left">No leave days ({EMPLOYMENT[employmentOf(self)]}) · leave is deducted</p>
			)}
			{lead && <p className="muted">Your leave is approved straight away.</p>}
			{latest && <p className="muted">Approved: {latest.from_date === latest.to_date ? short(latest.from_date) : `${short(latest.from_date)} – ${short(latest.to_date)}`}.</p>}
			{pending > 0 && (
				<p className="muted">
					{pending} request{pending === 1 ? '' : 's'} waiting for an answer.
				</p>
			)}
			{!viewOnly && (
				<div>
					<button type="button" className={'btn primary' + (bare ? ' small' : '')} onClick={() => setOpen(true)}>
						{lead ? 'Take leave' : 'Request leave'}
					</button>
				</div>
			)}
			<LeaveDialog open={open} onClose={() => setOpen(false)} />
		</Box>
	);
}
