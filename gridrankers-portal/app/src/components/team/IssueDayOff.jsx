import { useState } from 'react';
import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { mayIssueLeave } from '../../lib/leaveBoard.js';
import { balance, hasLeave, leaveDays, overBy, teamWeekly } from '../../lib/people.js';
import { ROLE } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Issue a day off (SPEC.md 6.10, design LV-C): approved casual leave for someone else, counted
// like any other. Team Leaders and the Super Admin; the server checks who may get one.
export default function IssueDayOff({ onClose }) {
	const { api, data, dispatch, me, today, toast } = usePortal();
	const [q, setQ] = useState('');
	const [who, setWho] = useState('');
	const [from, setFrom] = useState(today);
	const [to, setTo] = useState(today);
	const [note, setNote] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);

	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const year = +(from || today).slice(0, 4);
	const query = q.trim().toLowerCase();
	const people = rowsOf(data, 'members')
		.filter((p) => mayIssueLeave(me, p))
		.sort((a, b) => a.name.localeCompare(b.name));
	const shown = people.filter((p) => !query || p.name.toLowerCase().includes(query));
	const person = data.members[who];
	const end = to < from ? from : to;
	const months = person ? leaveDays(from, end, person, team, daysOff) : {};
	const total = Object.values(months).reduce((a, b) => a + b, 0);
	const over = person && total ? overBy(person, { id: '', type: 'day', from_date: from, to_date: end }, leaves, team, daysOff) : 0;

	const submit = async (e) => {
		e.preventDefault();
		if (!person) return setError('Pick the person.');
		if (!from) return setError('Pick the first day.');
		if (!total) return setError('Those days are all days off already.');
		setBusy(true);
		try {
			const row = await api.post('leave', { member_id: person.id, from, to: end, note: note.trim() });
			dispatch({ type: 'upsert', table: 'leave', row });
			toast(`Day off issued to ${person.name}`);
			onClose();
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal open onClose={onClose} labelledBy="grpIssue" className="io-dlg">
			<form onSubmit={submit} noValidate>
				<h2 id="grpIssue">Issue a day off</h2>
				<p className="hint io-sub">Recorded as approved casual leave for them — it uses their casual days for the year.</p>
				<fieldset className="io-people">
					<legend>Person</legend>
					<label className="ld-search io-search">
						<span aria-hidden="true">⌕</span>
						<input type="search" placeholder="Search people" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
					</label>
					<div className="io-list" role="radiogroup" aria-label="Person">
						{shown.map((p) => {
							const left = balance(p, year, leaves, team, daysOff).day.left;
							return (
								<button key={p.id} type="button" role="radio" aria-checked={who === p.id} className={'io-p' + (who === p.id ? ' on' : '')} onClick={() => (setWho(p.id), setError(''))}>
									<Avatar person={p} small />
									<b>{p.name}</b>
									<small>{ROLE[p.role]}</small>
									<span className={'io-left' + (left ? '' : ' none')}>{hasLeave(p) ? `${plural(left, 'casual day')} left` : 'No leave days'}</span>
								</button>
							);
						})}
						{shown.length === 0 && <p className="ld-empty">Nobody matches.</p>}
					</div>
				</fieldset>
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
				<label>
					Note for them (optional)
					<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Thanks for the extra hours on the launch." />
				</label>
				{person && (
					<div className={'io-sum' + (over ? ' over' : '')} aria-live="polite">
						<b>{total ? plural(total, 'working day') : 'All days off'}</b> · {from === end ? short(from) : `${short(from)} – ${short(end)}`}
						{over ? (
							<span>
								{' '}
								· {person.name} goes over the allowance → <b className="io-ded">{plural(over, 'day')} deducted</b>
							</span>
						) : total ? (
							` · within ${person.name}’s casual days`
						) : (
							''
						)}
					</div>
				)}
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary" disabled={busy}>
						Issue day off
					</button>
				</div>
			</form>
		</Modal>
	);
}
