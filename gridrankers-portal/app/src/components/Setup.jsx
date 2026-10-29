import { useState } from 'react';

// SPEC.md 4.1: a WordPress administrator without a linked team member sets up GridRankers. On a
// tracker portal (6.22) they pick their Super Admin profile copied from the main portal instead.
export default function Setup({ api, onDone, defaultName, choices, mainPortal }) {
	const [name, setName] = useState(defaultName || '');
	const [pick, setPick] = useState(choices && choices.length === 1 ? choices[0].id : '');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const tracker = Array.isArray(choices);
	const host = mainPortal ? mainPortal.replace(/^https?:\/\//, '') : '';

	const submit = async (e) => {
		e.preventDefault();
		setBusy(true);
		setError('');
		try {
			const res = await api.post('auth/setup', tracker ? { member_id: pick } : { name });
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
				<p className="ag-sub">{tracker ? 'Tracker portal' : 'Team portal'}</p>
				<h1>Set up GridRankers</h1>
				{tracker ? (
					<>
						<p className="ag-hint">You're signed in to WordPress as an administrator. Pick your Super Admin profile from {host}.</p>
						{choices.length ? (
							<label className="ag-field">
								<span>Your profile</span>
								<select value={pick} onChange={(e) => setPick(e.target.value)} required>
									<option value="">Choose…</option>
									{choices.map((c) => (
										<option key={c.id} value={c.id}>
											{c.name}
											{c.email ? ` · ${c.email}` : ''}
										</option>
									))}
								</select>
							</label>
						) : (
							<p className="ag-hint">No Super Admin profile has been copied from {host} yet. Link the sites in WP admin → GridRankers → Settings → Sites, then Sync now.</p>
						)}
					</>
				) : (
					<>
						<p className="ag-hint">You're signed in to WordPress as an administrator. Create your Super Admin profile to start.</p>
						<label className="ag-field">
							<span>Your name</span>
							<input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} autoComplete="name" required />
						</label>
					</>
				)}
				<p className="err" role="alert">
					{error}
				</p>
				<button type="submit" className="btn primary ag-btn" disabled={busy || (tracker && !pick)}>
					Set up GridRankers
				</button>
			</form>
		</div>
	);
}
