import { useState } from 'react';
import { usePortal } from '../../context.js';
import { firstName } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import Modal from '../Modal.jsx';

// Send shout-out (to a Team Member) and Post announcement (SPEC.md 7.0). Team Leaders and the Super Admin.
export function ShoutoutDialog({ open, onClose }) {
	const { api, data, dispatch, toast } = usePortal();
	const people = rowsOf(data, 'members')
		.filter((m) => m.active && m.role === 'member')
		.sort((a, b) => a.name.localeCompare(b.name));
	const [to, setTo] = useState('');
	const [body, setBody] = useState('');
	const [error, setError] = useState('');
	const who = data.members[to];

	const submit = async (e) => {
		e.preventDefault();
		if (!to) return setError('Pick who the shout-out is for.');
		if (!body.trim()) return setError('Write a message.');
		try {
			dispatch({ type: 'upsert', table: 'posts', row: await api.post('posts', { kind: 'shoutout', to, body: body.trim() }) });
			toast(`Shout-out sent to ${who ? who.name : 'them'}`);
			setTo('');
			setBody('');
			setError('');
			onClose();
		} catch (err) {
			setError(err.message);
		}
	};

	return (
		<Modal open={open} onClose={onClose} labelledBy="grpShout">
			<form onSubmit={submit} noValidate>
				<h2 id="grpShout">Send a shout-out</h2>
				<label>
					To
					<select value={to} onChange={(e) => setTo(e.target.value)} aria-label="To">
						<option value="">Pick a Team Member</option>
						{people.map((m) => (
							<option key={m.id} value={m.id}>
								{m.name}
							</option>
						))}
					</select>
				</label>
				<label>
					Message
					<textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder="e.g. Great work on the Acme H1 fixes, the client loved it." />
				</label>
				<p className="hint">Shown on everyone’s My day for 30 days{who ? `, with a notification to ${firstName(who.name)}` : ''}.</p>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						Send
					</button>
				</div>
			</form>
		</Modal>
	);
}

export function AnnouncementDialog({ open, onClose }) {
	const { api, dispatch, toast, today } = usePortal();
	const [title, setTitle] = useState('');
	const [body, setBody] = useState('');
	const [until, setUntil] = useState('');
	const [pinned, setPinned] = useState(false);
	const [error, setError] = useState('');

	const submit = async (e) => {
		e.preventDefault();
		if (!title.trim()) return setError('Give the announcement a title.');
		if (!body.trim()) return setError('Write a message.');
		try {
			dispatch({ type: 'upsert', table: 'posts', row: await api.post('posts', { kind: 'announcement', title: title.trim(), body: body.trim(), show_until: until, pinned }) });
			toast('Announcement posted');
			setTitle('');
			setBody('');
			setUntil('');
			setPinned(false);
			setError('');
			onClose();
		} catch (err) {
			setError(err.message);
		}
	};

	return (
		<Modal open={open} onClose={onClose} labelledBy="grpAnnounce">
			<form onSubmit={submit} noValidate>
				<h2 id="grpAnnounce">Post an announcement</h2>
				<label>
					Title
					<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={191} placeholder="e.g. Office closed on Tuesday 6 October" />
				</label>
				<label>
					Message
					<textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
				</label>
				<div className="row">
					<label>
						Show until (optional)
						<input type="date" value={until} min={today} onChange={(e) => setUntil(e.target.value)} aria-label="Show until" />
					</label>
					<label className="chk">
						<input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to the top
					</label>
				</div>
				<p className="hint">Everyone sees it at the top of My day until they dismiss it or the date passes.</p>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						Post
					</button>
				</div>
			</form>
		</Modal>
	);
}
