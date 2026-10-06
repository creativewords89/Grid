import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { PortalContext } from './context.js';
import { createApi } from './lib/api.js';
import { dataReducer, emptyData, rowsOf } from './lib/store.js';
import { fetchSync, POLL_MS } from './lib/sync.js';
import { useToasts } from './components/Toasts.jsx';
import { useConfirm } from './components/ConfirmDialog.jsx';
import SignIn from './components/SignIn.jsx';
import Setup from './components/Setup.jsx';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import CompletionDialog from './components/CompletionDialog.jsx';
import MeetingMinutes from './components/meeting/MeetingMinutes.jsx';
import MonthlyTasks from './components/monthly/MonthlyTasks.jsx';
import GeneralTasks from './components/general/GeneralTasks.jsx';
import Invoices from './components/billing/Invoices.jsx';
import TeamView from './components/TeamView.jsx';
import Dashboard from './components/Dashboard.jsx';
import RecentActivities from './components/RecentActivities.jsx';
import KeywordPlan from './components/plan/KeywordPlan.jsx';
import ProjectDetails from './components/plan/ProjectDetails.jsx';
import { todayYmd } from './lib/cycles.js';
import { ROLE, canTour, isAdmin } from './lib/roles.js';
import Avatar from './components/Avatar.jsx';
import TourGuard from './components/TourGuard.jsx';

const VIEW_KEY = 'grp:view';
const PROJECT_KEY = 'grp:project';
const VIEW_OWNER_KEY = 'grp:view-owner';

// The last project is remembered per browser; the screen per tab (sessionStorage), so opening
// the portal starts on the Dashboard while a reload keeps the current screen (SPEC.md 7.0).
const store = (kind) => {
	try {
		return window[kind];
	} catch (e) {
		return null;
	}
};
const remember = (key, value, kind = 'localStorage') => {
	try {
		store(kind).setItem(key, value || '');
	} catch (e) {
		/* private mode: not remembered */
	}
};
const recall = (key, kind = 'localStorage') => {
	try {
		return store(kind).getItem(key) || '';
	} catch (e) {
		return '';
	}
};

// Polls GET /sync every 10 s while the tab is visible; pauses when hidden.
function useSync(api, active, dispatch) {
	const [status, setStatus] = useState('Connecting…');
	const cursor = useRef(null);

	useEffect(() => {
		if (!active) return undefined;
		let stopped = false;
		let timer = null;
		let running = false;

		const tick = async () => {
			clearTimeout(timer);
			if (stopped || running) return;
			if (document.hidden) return;
			running = true;
			try {
				const res = await fetchSync(api, cursor.current);
				if (stopped) return;
				dispatch({ type: 'sync', changes: res.changes, deletions: res.deletions });
				cursor.current = res.cursor;
				setStatus('Shared with your team · live');
			} catch (e) {
				if (!stopped && e.status !== 401) setStatus('Connection lost. Retrying…');
			} finally {
				running = false;
				if (!stopped) timer = setTimeout(tick, POLL_MS);
			}
		};

		const onVisible = () => {
			if (!document.hidden) tick();
		};
		document.addEventListener('visibilitychange', onVisible);
		tick();

		return () => {
			stopped = true;
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', onVisible);
			cursor.current = null;
		};
	}, [api, active, dispatch]);

	return status;
}

export default function App({ config }) {
	const [auth, setAuth] = useState({ status: 'loading', me: null });
	const [data, dispatch] = useReducer(dataReducer, undefined, emptyData);
	const [view, setViewState] = useState(recall(VIEW_KEY, 'sessionStorage') || 'dash');
	const [project, setProjectState] = useState(recall(PROJECT_KEY));
	const [search, setSearch] = useState('');
	const [cycleOff, setCycleOff] = useState(0);
	const [teamPerson, setTeamPerson] = useState('all');
	// Touring someone's portal, view only (SPEC.md 7.0): their id while a tour is on.
	const [viewAs, setViewAs] = useState(null);
	const [toast, toastView] = useToasts();
	const [confirm, confirmView] = useConfirm();
	const [completion, setCompletion] = useState(null);

	// "Submit completed work" (SPEC.md 6.6) — resolves {note, links, files, comment, reviewer?} or null.
	// `opts.edit` with `opts.initial` edits a saved submission.
	const askCompletion = useCallback((title, opts = {}) => new Promise((resolve) => setCompletion({ title, edit: !!opts.edit, initial: opts.initial || null, resolve })), []);
	const finishCompletion = (value) => {
		if (completion) completion.resolve(value);
		setCompletion(null);
	};

	const signOutLocally = useCallback(() => {
		dispatch({ type: 'reset' });
		setAuth({ status: 'signedOut', me: null });
	}, []);

	const api = useMemo(() => createApi({ root: config.restRoot, nonce: config.nonce, onUnauthorized: signOutLocally }), [config, signOutLocally]);

	useEffect(() => {
		api
			.get('auth/me')
			.then((res) => setAuth(res.member ? { status: 'signedIn', me: res.member } : { status: res.needsSetup ? 'setup' : 'signedOut', me: null }))
			.catch(() => setAuth({ status: 'signedOut', me: null }));
	}, [api]);

	const syncStatus = useSync(api, auth.status === 'signedIn', dispatch);

	// The remembered screen belongs to whoever chose it: someone else signing in on this tab
	// (e.g. after the session expired, without "Sign out") starts on the Dashboard.
	const meId = auth.me ? auth.me.id : '';
	useEffect(() => {
		if (!meId || recall(VIEW_OWNER_KEY, 'sessionStorage') === meId) return;
		remember(VIEW_OWNER_KEY, meId, 'sessionStorage');
		setViewState('dash');
		remember(VIEW_KEY, 'dash', 'sessionStorage');
	}, [meId]);

	// Keep "me" fresh from synced member rows (role or name changes).
	const me = auth.me && data.members[auth.me.id] ? { ...auth.me, ...data.members[auth.me.id], role: auth.me.role } : auth.me;

	const setView = (v) => {
		setViewState(v);
		remember(VIEW_KEY, v, 'sessionStorage');
	};
	const setProject = (id) => {
		setProjectState(id);
		setCycleOff(0);
		remember(PROJECT_KEY, id);
		// Picking a project from a screen that isn't a project's (My day, a person's page, General
		// tasks, Invoices) opens its Meeting Minutes.
		if (view === 'team' || view === 'dash' || view === 'general' || view === 'invoices') setView('board');
	};

	// Always show one project: default to the first active one (reference behaviour).
	const projects = rowsOf(data, 'projects');
	useEffect(() => {
		if (!projects.length || (project && data.projects[project])) return;
		const order = { active: 0, paused: 1, inactive: 2 };
		const first = [...projects].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name))[0];
		if (first) setProjectState(first.id);
	}, [projects, project, data.projects]);

	const signOut = async () => {
		try {
			await api.post('auth/logout');
		} catch (e) {
			/* signed out anyway */
		}
		signOutLocally();
		setView('dash');
		if (config.isWpAdmin) window.location.reload();
	};

	if (auth.status === 'loading') {
		return <div className="auth-gate" aria-busy="true" />;
	}
	if (auth.status === 'setup') {
		return <Setup api={api} defaultName={config.wpUserName} onDone={(member) => (setView('dash'), setAuth({ status: 'signedIn', me: member }))} />;
	}
	if (auth.status !== 'signedIn') {
		return <SignIn api={api} loginUrl={config.loginUrl} onSignedIn={(member) => (setView('dash'), setAuth({ status: 'signedIn', me: member }))} />;
	}

	const today = todayYmd();

	// A tour (SPEC.md 7.0) starts on that person's My day, once the server agrees, and lasts until
	// Close tour: you go anywhere they can go and see what they see; nothing can be changed.
	const startTour = async (id) => {
		const target = data.members[id];
		if (!canTour(me, target)) {
			setTeamPerson(id);
			setView('team');
			return;
		}
		try {
			await api.get(`members/${id}/tour`);
			setViewAs(id);
			setTeamPerson('all');
			setSearch('');
			setView('dash');
		} catch (err) {
			toast(err.message);
		}
	};
	// Close tour → back to your own My page, on its Team tab.
	const closeTour = () => {
		setViewAs(null);
		setTeamPerson('all');
		setSearch('');
		setView('team');
	};

	const ctx = { api, data, dispatch, me, view, setView, project, setProject, search, setSearch, toast, confirm, config, cycleOff, setCycleOff, today, askCompletion, teamPerson, setTeamPerson, setViewAs: startTour };

	const target = viewAs && data.members[viewAs];
	const viewing = canTour(me, target) ? target : null;
	let tourCtx = null;
	if (viewing) {
		const refuse = () => Promise.reject(new Error(`View only — you’re touring ${viewing.name}’s portal.`));
		tourCtx = {
			...ctx,
			me: { ...viewing },
			viewer: me,
			viewOnly: true,
			api: { ...api, post: refuse, patch: refuse, put: refuse, del: refuse },
			// Inside a tour of a Team Leader, opening a Team Member tours them instead (if you may).
			setViewAs: (id) => (canTour(me, data.members[id]) ? startTour(id) : null),
		};
	}
	const shown = tourCtx || ctx;
	const shownMe = shown.me;

	return (
		<PortalContext.Provider value={shown}>
			{viewing && (
				<div className="tour-bar" role="region" aria-label="Tour">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
						<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
						<circle cx="12" cy="12" r="3" />
					</svg>
					<Avatar person={viewing} />
					<span className="tour-who">
						Touring <b>{viewing.name}</b>’s portal
					</span>
					<span className="tour-role">{ROLE[viewing.role]}</span>
					<span className="tour-hint">· view only — you see what {viewing.name.split(' ')[0]} sees; nothing can be changed</span>
					<span className="tour-acts">
						{/* Their page as you see it (with your tools); ends the tour. */}
						<button type="button" className="btn small tour-ghost" onClick={() => (setViewAs(null), setTeamPerson(viewing.id), setView('team'))}>
							Open {viewing.name.split(' ')[0]}’s page
						</button>
						<button type="button" className="btn small tour-close" onClick={closeTour}>
							✕ Close tour
						</button>
					</span>
				</div>
			)}
			<TourGuard on={!!viewing} name={viewing ? viewing.name : ''} toast={toast}>
				<div className={'app' + (viewing ? ' tour' : '')}>
					<Sidebar syncStatus={syncStatus} />
					<main>
						{view !== 'dash' && <TopBar onSignOut={signOut} />}
						<section className="grp-view" aria-label="Content">
							{view === 'dash' ? (
								<div className={viewing ? 'view-only' : undefined}>
									<Dashboard onSignOut={signOut} />
								</div>
							) : view === 'team' ? (
								<TeamView />
							) : view === 'general' ? (
								<GeneralTasks />
							) : view === 'invoices' ? (
								isAdmin(shownMe) ? <Invoices /> : <p className="empty">Only the Super Admin keeps the invoices.</p>
							) : projects.length === 0 ? (
								<div className="col" style={{ maxWidth: 520 }}>
									<h2>Start with a project</h2>
									<p className="empty">Projects are added on the Dashboard (click GridRankers at the top left).</p>
								</div>
							) : view === 'board' ? (
								<MeetingMinutes />
							) : view === 'monthly' ? (
								<MonthlyTasks />
							) : view === 'plan' ? (
								<KeywordPlan />
							) : view === 'details' ? (
								<ProjectDetails />
							) : view === 'log' ? (
								<RecentActivities />
							) : (
								<p className="empty">This screen arrives in a later build step.</p>
							)}
						</section>
					</main>
				</div>
			</TourGuard>
			{toastView}
			{confirmView}
			<CompletionDialog open={!!completion} title={completion ? completion.title : ''} edit={!!(completion && completion.edit)} initial={completion ? completion.initial : null} onCancel={() => finishCompletion(null)} onSubmit={finishCompletion} />
		</PortalContext.Provider>
	);
}
