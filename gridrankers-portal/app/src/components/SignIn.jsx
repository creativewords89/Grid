import { useState } from 'react';

// SPEC.md 4.2: logo, "Sign in to continue", one field "Your code", button "Sign in",
// "Forgot your code?" → ask the Super Admin. Nothing else renders before sign-in.
export default function SignIn({ api, onSignedIn, loginUrl }) {
	const [code, setCode] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [forgot, setForgot] = useState(false);

	const submit = async (e) => {
		e.preventDefault();
		if (!code.trim()) return setError('Enter your code.');
		setBusy(true);
		setError('');
		try {
			const res = await api.post('auth/login', { code });
			onSignedIn(res.member);
		} catch (err) {
			setError(err.message);
			setBusy(false);
		}
	};

	return (
		<div className="auth-gate">
			<form className="ag-card" onSubmit={submit} noValidate>
				<div className="ag-logo">GridRankers</div>
				<p className="ag-sub">Team portal</p>
				<h1>Sign in to continue</h1>
				<label className="ag-field">
					<span>Your code</span>
					<input type="password" autoComplete="off" maxLength={32} value={code} onChange={(e) => setCode(e.target.value)} autoFocus aria-describedby="grpSignErr" />
				</label>
				<p className="err" id="grpSignErr" role="alert">
					{error}
				</p>
				<button type="submit" className="btn primary ag-btn" disabled={busy}>
					{busy ? 'Signing in…' : 'Sign in'}
				</button>
				<button type="button" className="btn link" onClick={() => setForgot(true)}>
					Forgot your code?
				</button>
				{forgot && <p className="ag-hint">Ask your Super Admin to set a new code (Team → Settings → Set code)</p>}
				{loginUrl && (
					<p className="ag-acct">
						Super Admin? <a href={loginUrl}>Sign in with WordPress</a>
					</p>
				)}
			</form>
		</div>
	);
}
