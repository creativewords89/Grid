import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_SERVER } from '../core/api.js';
import { fmtClock, fmtMinutes, fmtTime } from '../core/clock.js';

const tracker = window.tracker;

// The tracker's window (SPEC.md 6.21): sign in with the employee code; then the running timer, the
// tasks to start on, what is waiting to sync and what needs attention.
export default function App() {
	const [view, setView] = useState(null);
	useEffect(() => {
		tracker.view().then(setView);
		return tracker.onView(setView);
	}, []);
	if (!view) return null;
	return view.signedIn ? <Main view={view} /> : <SignIn view={view} />;
}

function SignIn({ view }) {
	const [server, setServer] = useState(view.server || DEFAULT_SERVER);
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [more, setMore] = useState(view.server && view.server !== DEFAULT_SERVER);
	const submit = async (e) => {
		e.preventDefault();
		if (!code.trim()) return setError('Type your code.');
		setBusy(true);
		setError('');
		const res = await tracker.signIn(server, code);
		setBusy(false);
		if (!res.ok) setError(res.message);
	};
	return (
		<form className="signin" onSubmit={submit}>
			<div className="logo" aria-hidden="true">
				GR
			</div>
			<h1>GridRankers Tracker</h1>
			<p className="muted">Sign in with your code — the same one you use on the portal.</p>
			{view.signedOut && <p className="warn">You were signed out. Sign in again; time not sent yet is safe on this computer.</p>}
			<label>
				Your code
				<input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" aria-label="Your code" />
			</label>
			{more ? (
				<label>
					Portal address
					<input value={server} onChange={(e) => setServer(e.target.value)} aria-label="Portal address" />
				</label>
			) : (
				<button type="button" className="link" onClick={() => setMore(true)}>
					Another portal address?
				</button>
			)}
			<p className="err" role="alert">
				{error}
			</p>
			<button type="submit" className="btn primary" disabled={busy}>
				{busy ? 'Signing in…' : 'Sign in'}
			</button>
			<p className="muted small">Forgot your code? Ask your Super Admin to set a new one (Team → Settings → Set code).</p>
		</form>
	);
}

function Main({ view }) {
	const [now, setNow] = useState(Date.now());
	const [query, setQuery] = useState('');
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	const run = view.running;
	const list = useMemo(() => {
		const q = query.trim().toLowerCase();
		const all = view.choices.filter((c) => !q || (c.label + ' ' + c.sub).toLowerCase().includes(q));
		const recent = view.recent.map((k) => all.find((c) => c.key === k)).filter(Boolean);
		return [...recent, ...all.filter((c) => !view.recent.includes(c.key))];
	}, [view.choices, view.recent, query]);
	const status = view.sync.online === false ? 'offline' : 'online';

	return (
		<div className="main">
			<header className="head">
				<div>
					<b>{view.member.name}</b>
					<span className={'status ' + status} role="status">
						<i aria-hidden="true" />
						{status === 'offline' ? `Offline · ${view.waiting} entr${view.waiting === 1 ? 'y' : 'ies'} waiting to sync` : view.flash ? `Synced ${view.flash.n} entr${view.flash.n === 1 ? 'y' : 'ies'}` : view.waiting ? `Syncing ${view.waiting}…` : 'Online'}
					</span>
				</div>
				<span className="today">Today {fmtMinutes(view.todaySeconds / 60)}</span>
			</header>
			{view.today && <p className="day">{view.today.working ? `Working day ${view.today.start}–${view.today.end}` : `${view.today.label || 'Day off'} — no reminders today`}</p>}

			{view.prompts.crash && (
				<section className="prompt" role="alertdialog" aria-label="Timer stopped unexpectedly">
					<p>
						Your timer stopped unexpectedly at <b>{fmtTime(view.prompts.crash.atMs)}</b>
						{view.prompts.crash.label ? ` (${view.prompts.crash.label})` : ''}.
					</p>
					<div className="acts">
						<button type="button" className="btn small primary" onClick={() => tracker.answer('crash', 'keep')}>
							Keep until {fmtTime(view.prompts.crash.atMs)}
						</button>
						<button type="button" className="btn small" onClick={() => tracker.answer('crash', 'discard')}>
							Discard
						</button>
						<button type="button" className="btn small" onClick={() => tracker.answer('crash', 'running')}>
							Keep running
						</button>
					</div>
				</section>
			)}

			<section className={'timer' + (run ? ' on' : '')} aria-label="Timer">
				{run ? (
					<>
						<div>
							<b className="clock" aria-label="Timer running">
								{fmtClock((now - run.startedMs) / 1000)}
							</b>
							<span className="what">{run.label}</span>
						</div>
						<button type="button" className="btn stop" onClick={() => tracker.stop()}>
							Stop
						</button>
					</>
				) : (
					<p className="muted">No timer running. Pick what you’re working on.</p>
				)}
			</section>

			{view.attention.length > 0 && (
				<section className="attention" aria-label="Needs attention">
					<h2>Needs attention</h2>
					{view.attention.map((e) => (
						<div key={e.id} className="att">
							<div>
								<b>{e.label}</b>
								<span>{e.error.message}</span>
							</div>
							<button type="button" className="btn small" onClick={() => tracker.dismiss(e.id)}>
								Dismiss
							</button>
						</div>
					))}
				</section>
			)}

			<section className="pick" aria-label={run ? 'Switch to' : 'Start on'}>
				<input type="search" placeholder="Search tasks" aria-label="Search tasks" value={query} onChange={(e) => setQuery(e.target.value)} />
				<ul>
					{list.map((c) => (
						<li key={c.key}>
							<button type="button" className={run && run.ref_kind === c.ref_kind && (run.ref_id || null) === (c.ref_id || null) && (run.project_id || null) === (c.project_id || null) ? 'cur' : ''} onClick={() => tracker.start(c)}>
								<b>{c.label}</b>
								<span>{c.sub}</span>
							</button>
						</li>
					))}
				</ul>
			</section>

			<footer className="foot">
				<button type="button" className="link" onClick={() => tracker.openPortal()}>
					Open the portal
				</button>
				<button type="button" className="link" onClick={() => tracker.sync()}>
					Sync now
				</button>
				<button type="button" className="link" onClick={() => tracker.signOut()}>
					Sign out
				</button>
			</footer>
		</div>
	);
}
