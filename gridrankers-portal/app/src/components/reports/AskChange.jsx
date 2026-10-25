import { useState } from 'react';
import { usePortal } from '../../context.js';
import { changeRequest, dayTitle, fmtMinutes, totalMinutes } from '../../lib/reports.js';
import Modal from '../Modal.jsx';

// Ask to change a past report (SPEC.md 6.18, design RC-1): the right time for each entry (hours and
// minutes), the new total, a reason, Send request. Team Leaders and the Super Admin approve it.
export default function AskChange({ report, onClose }) {
	const { api, dispatch, toast } = usePortal();
	const [times, setTimes] = useState(() => Object.fromEntries(report.entries.map((e) => [e.id, +e.minutes])));
	const [reason, setReason] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const was = totalMinutes(report.entries);
	const now = report.entries.reduce((n, e) => n + (times[e.id] || 0), 0);
	const set = (id, h, m) => (setError(''), setTimes({ ...times, [id]: Math.max(0, Math.floor(+h || 0)) * 60 + Math.max(0, Math.min(59, Math.floor(+m || 0))) }));
	const send = async (e) => {
		e.preventDefault();
		const req = changeRequest(report.entries, times, reason);
		if (req.error) return setError(req.error);
		setBusy(true);
		try {
			const row = await api.post(`daily-reports/${report.day}/change`, { entries: req.entries, reason: reason.trim() });
			dispatch({ type: 'upsert', table: 'report_changes', row });
			toast('Change asked — your Team Leaders will answer');
			onClose();
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal open onClose={onClose} labelledBy="drAskTitle">
			<form className="rc-form" onSubmit={send} noValidate>
				<h2 id="drAskTitle">Ask to change {dayTitle(report.day)}</h2>
				<p className="muted">Put the right time for each entry. Your Team Leaders approve it before it counts.</p>
				<div className="rc-rows" role="table" aria-label="Entries">
					<div className="rc-row rc-head" role="row">
						<span role="columnheader">Entry</span>
						<span role="columnheader">Hours</span>
						<span role="columnheader">Minutes</span>
					</div>
					{report.entries.map((e) => {
						const t = times[e.id] || 0;
						return (
							<div key={e.id} className={'rc-row' + (t !== +e.minutes ? ' on' : '')} role="row">
								<span role="cell">
									<b>{e.title}</b>
									<small className="muted">sent: {fmtMinutes(e.minutes)}</small>
								</span>
								<input role="cell" type="number" min="0" max="24" value={Math.floor(t / 60)} onChange={(ev) => set(e.id, ev.target.value, t % 60)} aria-label={`Hours for ${e.title}`} />
								<input role="cell" type="number" min="0" max="59" step="5" value={t % 60} onChange={(ev) => set(e.id, Math.floor(t / 60), ev.target.value)} aria-label={`Minutes for ${e.title}`} />
							</div>
						);
					})}
				</div>
				<p className="rc-total">
					<span>Total</span>
					<span>
						{now !== was && <s className="muted">{fmtMinutes(was)}</s>} {now !== was && '→ '}
						<b>{fmtMinutes(now)}</b>
					</span>
				</p>
				<label>
					Reason (required)
					<input type="text" value={reason} maxLength={500} onChange={(e) => (setError(''), setReason(e.target.value))} placeholder="e.g. Typed 10h instead of 1h" />
				</label>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary" disabled={busy}>
						Send request
					</button>
				</div>
			</form>
		</Modal>
	);
}
