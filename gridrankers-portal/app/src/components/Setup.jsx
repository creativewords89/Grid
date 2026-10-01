import { useState } from 'react';

// SPEC.md 4.1: a WordPress administrator without a linked team member sets up GridRankers.
export default function Setup({ api, onDone, defaultName }) {
	const [name, setName] = useState(defaultName || '');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);

	const submit = async (e) => {
		e.preventDefault();
		setBusy(true);
		setError('');
		try {
			const res = await api.post('auth/setup', { name });
			onDone(res.member);
		} catch (err) {
			setError(err.message);
			setBusy(false);
		}
	};

	return (
		<div className="auth-gate">
			<form className="ag-card" onSubmit={submit}>
				<div className="ag-logo">GridRankers</div>
				<p className="ag-sub">Team portal</p>
				<h1>Set up GridRankers</h1>
				<p className="ag-hint">You're signed in to WordPress as an administrator. Create your Super Admin profile to start.</p>
				<label className="ag-field">
					<span>Your name</span>
					<input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} autoComplete="name" required />
				</label>
				<p className="err" role="alert">
					{error}
				</p>
				<button type="submit" className="btn primary ag-btn" disabled={busy}>
					Set up GridRankers
				</button>
			</form>
		</div>
	);
}
