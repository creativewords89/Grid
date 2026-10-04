import { useState } from 'react';
import { usePortal } from '../../context.js';
import { addDays } from '../../lib/cycles.js';
import { ROLE } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import Modal from '../Modal.jsx';

const SHOW_FOR = [
	['7', '7 days'],
	['30', '30 days'],
	['', 'Until I remove it'],
];

// Send notice (SPEC.md 7.0): a notice to everyone or to chosen people, or a shout-out to chosen
// Team Members. Team Leaders and the Super Admin.
export function NoticeDialog({ open, onClose }) {
	const { api, data, dispatch, me, toast, today } = usePortal();
	const [kind, setKind] = useState('notice');
	const [everyone, setEveryone] = useState(true);
	const [to, setTo] = useState([]);
	const [title, setTitle] = useState('');
	const [body, setBody] = useState('');
	const [days, setDays] = useState('7');
	const [error, setError] = useState('');
	const shout = kind === 'shoutout';
	const toAll = everyone && !shout;
	const people = rowsOf(data, 'members')
		.filter((m) => m.active && m.id !== me.id && (!shout || m.role === 'member'))
		.sort((a, b) => a.name.localeCompare(b.name));
	const chosen = to.filter((id) => people.some((p) => p.id === id));

	const reset = () => {
		setKind('notice');
		setEveryone(true);
		setTo([]);
		setTitle('');
		setBody('');
		setDays('7');
		setError('');
	};
	const submit = async (e) => {
		e.preventDefault();
		if (!toAll && !chosen.length) return setError('Pick who it is for.');
		if (!body.trim()) return setError('Write a message.');
		try {
			const row = await api.post('posts', {
				kind: shout ? 'shoutout' : toAll ? 'announcement' : 'notice',
				to: toAll ? undefined : chosen,
				title: title.trim(),
				body: body.trim(),
				show_until: days ? addDays(today, +days) : '',
			});
			dispatch({ type: 'upsert', table: 'posts', row });
			toast(shout ? 'Shout-out sent' : 'Notice sent');
			reset();
			onClose();
		} catch (err) {
			setError(err.message);
		}
	};

	return (
		<Modal open={open} onClose={onClose} labelledBy="grpNotice">
			<form onSubmit={submit} noValidate>
				<h2 id="grpNotice">Send a notice</h2>
				<fieldset className="nd-row">
					<legend>Kind</legend>
					<div className="ra-chips">
						<button type="button" className="ra-chip" aria-pressed={!shout} onClick={() => setKind('notice')}>
							Notice
						</button>
						<button type="button" className="ra-chip" aria-pressed={shout} onClick={() => setKind('shoutout')}>
							Shout-out ★
						</button>
					</div>
				</fieldset>
				<fieldset className="nd-row">
					<legend>To</legend>
					{!shout && (
						<div className="ra-chips">
							<button type="button" className="ra-chip" aria-pressed={everyone} onClick={() => setEveryone(true)}>
								Everyone
							</button>
							<button type="button" className="ra-chip" aria-pressed={!everyone} onClick={() => setEveryone(false)}>
								Choose people
							</button>
						</div>
					)}
					{!toAll && (
						<div className="nd-people">
							{chosen.map((id) => (
								<button key={id} type="button" className="nd-chip" onClick={() => setTo(to.filter((x) => x !== id))} aria-label={`Remove ${data.members[id].name}`}>
									{data.members[id].name} ✕
								</button>
							))}
							<select value="" onChange={(e) => e.target.value && setTo([...to, e.target.value])} aria-label="Add a person">
								<option value="">{shout ? 'Add a Team Member…' : 'Add a person…'}</option>
								{people
									.filter((p) => !chosen.includes(p.id))
									.map((p) => (
										<option key={p.id} value={p.id}>
											{p.name} · {ROLE[p.role]}
										</option>
									))}
							</select>
						</div>
					)}
				</fieldset>
				<label>
					Title (optional)
					<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={191} />
				</label>
				<label>
					Message
					<textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
				</label>
				<label>
					Show for
					<select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Show for">
						{SHOW_FOR.map(([v, l]) => (
							<option key={l} value={v}>
								{l}
							</option>
						))}
					</select>
				</label>
				<p className="hint">{toAll ? 'Everyone sees it in their Notifications box.' : 'Only the people you choose see it, in their Notifications box and bell.'}{shout ? ' Shout-outs show a star and everyone can see them for 30 days.' : ''}</p>
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
