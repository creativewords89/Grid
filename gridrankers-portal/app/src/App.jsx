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

const VIEW_KEY = 'grp:view';
const PROJECT_KEY = 'grp:project';

const remember = (key, value) => {
	try {
		window.localStorage.setItem(key, value || '');
	} catch (e) {
		/* private mode: not remembered */
	}
};
const recall = (key) => {
	try {
		return window.localStorage.getItem(key) || '';
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
	const [view, setViewState] = useState(recall(VIEW_KEY) || 'board');
	const [project, setProjectState] = useState(recall(PROJECT_KEY));
	const [search, setSearch] = useState('');
	const [toast, toastView] = useToasts();
	const [confirm, confirmView] = useConfirm();

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

	// Keep "me" fresh from synced member rows (role or name changes).
	const me = auth.me && data.members[auth.me.id] ? { ...auth.me, ...data.members[auth.me.id], role: auth.me.role } : auth.me;

	const setView = (v) => {
		setViewState(v);
		remember(VIEW_KEY, v);
	};
	const setProject = (id) => {
		setProjectState(id);
		remember(PROJECT_KEY, id);
		if (view === 'team') setView('board');
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
		if (config.isWpAdmin) window.location.reload();
	};

	if (auth.status === 'loading') {
		return <div className="auth-gate" aria-busy="true" />;
	}
	if (auth.status === 'setup') {
		return <Setup api={api} defaultName={config.wpUserName} onDone={(member) => setAuth({ status: 'signedIn', me: member })} />;
	}
	if (auth.status !== 'signedIn') {
		return <SignIn api={api} loginUrl={config.loginUrl} onSignedIn={(member) => setAuth({ status: 'signedIn', me: member })} />;
	}

	const ctx = { api, data, dispatch, me, view, setView, project, setProject, search, setSearch, toast, confirm, config };

	return (
		<PortalContext.Provider value={ctx}>
			<div className="app">
				<Sidebar syncStatus={syncStatus} />
				<main>
					<TopBar onSignOut={signOut} />
					<section className="grp-view" aria-label="Content">
						{projects.length === 0 ? (
							<p className="empty">No projects yet. Add your first project in the sidebar.</p>
						) : (
							<p className="empty">This screen arrives in a later build step.</p>
						)}
					</section>
				</main>
			</div>
			{toastView}
			{confirmView}
		</PortalContext.Provider>
	);
}
