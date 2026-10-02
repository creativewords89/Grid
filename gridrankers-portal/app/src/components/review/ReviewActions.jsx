import { useState } from 'react';
import { usePortal } from '../../context.js';
import { ROLE, isAdmin, isManager } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import Modal from '../Modal.jsx';
import useReview from './useReview.js';

// "Ask someone to review it" (SPEC.md 6.6): a Team Leader or the Super Admin picks anyone for
// work they finished themselves; it goes back to pending for that person.
function AskReview({ kind, id, onClose }) {
	const { api, data, dispatch, me, toast } = usePortal();
	const [reviewer, setReviewer] = useState('');
	const [note, setNote] = useState('');
	const [error, setError] = useState('');
	const people = rowsOf(data, 'members')
		.filter((m) => m.active && m.id !== me.id)
		.sort((a, b) => a.name.localeCompare(b.name));

	const submit = async (e) => {
		e.preventDefault();
		if (!reviewer) return setError('Pick who should review it.');
		try {
			const row = await api.post('review/request', { kind, id, reviewer, note });
			dispatch({ type: 'upsert', table: kind === 'item' ? 'meeting_tasks' : 'records', row });
			toast(`Sent to ${data.members[reviewer].name} for review`);
			onClose();
		} catch (err) {
			setError(err.message);
		}
	};

	return (
		<Modal open onClose={onClose} labelledBy="grpAskReview">
			<form onSubmit={submit} noValidate>
				<h2 id="grpAskReview">Ask someone to review it</h2>
				<label>
					Reviewer
					<select value={reviewer} onChange={(e) => setReviewer(e.target.value)} aria-label="Reviewer">
						<option value="">Pick someone</option>
						{people.map((m) => (
							<option key={m.id} value={m.id}>
								{m.name} · {ROLE[m.role]}
							</option>
						))}
					</select>
				</label>
				<label>
					Note for the reviewer (optional)
					<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="e.g. Please check the October topics" />
				</label>
				<p className="hint">They see it at the top of their My day until they approve it or send it back.</p>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						Send for review
					</button>
				</div>
			</form>
		</Modal>
	);
}

// Reviewer buttons in a Details window (reference reviewActions). Work someone asked a
// particular person to review belongs to that person (and the Super Admin).
export default function ReviewActions({ kind, id, review, done }) {
	const { me } = usePortal();
	const decide = useReview();
	const [asking, setAsking] = useState(false);

	if (review && review.state === 'pending') {
		const asked = !!review.reviewer;
		const mine = asked ? review.reviewer === me.id || isAdmin(me) : isManager(me);
		if (!mine) return null;
		return (
			<div className="dt-racts">
				<button type="button" className="btn small primary" onClick={() => decide(kind, id, 'accept')}>
					{asked ? 'Approve' : 'Accept'}
				</button>
				<button type="button" className="btn small" onClick={() => decide(kind, id, 'revision')}>
					{asked ? 'Send back' : 'Revise'}
				</button>
				{isManager(me) && (
					<button type="button" className="btn small danger-soft" onClick={() => decide(kind, id, 'reject')}>
						Reject
					</button>
				)}
			</div>
		);
	}
	if (!isManager(me)) return null;
	const own = done && review && review.state === 'accepted' && review.auto && review.submittedBy === me.id;
	if (done) {
		return (
			<div className="dt-racts">
				{own && (
					<button type="button" className="btn small" onClick={() => setAsking(true)}>
						Ask someone to review it
					</button>
				)}
				<span className="muted">Reopen this completed task:</span>
				<button type="button" className="btn small" onClick={() => decide(kind, id, 'revision')}>
					Request revision
				</button>
				<button type="button" className="btn small danger-soft" onClick={() => decide(kind, id, 'reject')}>
					Reject
				</button>
				{asking && <AskReview kind={kind} id={id} onClose={() => setAsking(false)} />}
			</div>
		);
	}
	return null;
}
