import { useState } from 'react';
import Modal from './Modal.jsx';

// SPEC.md 6.6: a Team Member completing work says what they did (note required,
// optional https link). Resolves through onSubmit({note, link}).
export default function CompletionDialog({ open, title, onCancel, onSubmit }) {
	const [note, setNote] = useState('');
	const [link, setLink] = useState('');
	const [error, setError] = useState('');

	const submit = (e) => {
		e.preventDefault();
		const n = note.trim();
		const l = link.trim();
		if (n.length < 3) return setError('Add a few words about what you completed.');
		if (l && !/^https?:\/\//i.test(l)) return setError('The link should start with https://');
		setNote('');
		setLink('');
		setError('');
		onSubmit({ note: n, link: l });
	};

	return (
		<Modal open={open} onClose={onCancel} labelledBy="grpDoneTitle">
			<form onSubmit={submit} noValidate>
				<h2 id="grpDoneTitle">What did you complete?</h2>
				{title && <p className="hint">“{title}” — this goes to your Team Leader / Super Admin with the task.</p>}
				<label>
					What you did
					<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} autoFocus required />
				</label>
				<label>
					Link <small>(optional)</small>
					<input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" />
				</label>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onCancel}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						Mark completed
					</button>
				</div>
			</form>
		</Modal>
	);
}
