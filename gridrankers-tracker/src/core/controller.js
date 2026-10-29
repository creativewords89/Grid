// The tracker without Electron: state, the file it lives in, the portal API. main.js wires it to the
// window, the tray and the operating system; tests drive it with a fake API.

import { createClient, DEFAULT_SERVER } from './api.js';
import { fromUtc, localDay } from './clock.js';
import * as T from './tracker.js';

// Schedule and tasks are refreshed this often while online.
export const REFRESH_MS = 5 * 60 * 1000;

export function createController({ store, loadToken, saveToken, device, createApi = createClient, now = () => Date.now(), onChange = () => {} }) {
	let state = { ...T.emptyState(DEFAULT_SERVER), ...(store.load(null) || {}) };
	// A timer left running by a crash, a power cut or a killed app: ask what to do with it.
	state = T.checkCrash(state, now());
	let token = loadToken() || null;
	let tail = Promise.resolve();
	let queued = null;
	let lastRefresh = 0;

	const api = () => createApi({ server: state.server, getToken: () => token });
	const persist = () => {
		store.save(state);
		onChange(state);
	};
	const set = (next) => {
		state = next;
		persist();
		return state;
	};

	// Entries belong to the person who tracked them: only theirs are uploaded under their token.
	const mine = (s) => ({ ...s, entries: Object.fromEntries(Object.entries(s.entries).filter(([, e]) => !e.member_id || (s.member && e.member_id === s.member.id))) });

	async function signIn(server, code) {
		const client = createApi({ server, getToken: () => null });
		const res = await client.signIn(String(code || '').trim(), device);
		token = res.token;
		saveToken(token);
		lastRefresh = now();
		const base = { ...state, server, signedOut: false, sync: { ...state.sync, online: true, failures: 0, lastOkAt: now() } };
		set(T.signedIn(base, res));
		sync();
		return state;
	}

	async function signOut() {
		if (state.timer) set(T.stop(state, now()));
		// Send what is waiting (the stop included) while the token still works.
		await sync();
		try {
			if (token) await api().signOut();
		} catch (e) {
			// Offline: the token is forgotten here anyway; Revoke on the portal ends it there.
		}
		token = null;
		saveToken(null);
		return set({ ...state, member: null, signedOut: false });
	}

	function start(task) {
		if (!state.member) return state;
		const next = T.start(state, task, now());
		next.entries[next.timer.id] = { ...next.entries[next.timer.id], member_id: state.member.id };
		set(next);
		sync();
		return state;
	}

	function stop() {
		set(T.stop(state, now()));
		sync();
		return state;
	}

	// Uploads what is waiting, then asks the portal what is running and refreshes the schedule and tasks
	// every few minutes. One sync at a time, and at most one more waiting behind it (so a change made
	// during a sync is sent right after); offline it just records that and tries again later.
	function sync({ refresh = false } = {}) {
		if (!token || !state.member) return Promise.resolve(state);
		if (queued) {
			queued.refresh = queued.refresh || refresh;
			return queued.promise;
		}
		const job = { refresh };
		job.promise = tail.then(() => {
			queued = null;
			return token && state.member ? run(job.refresh) : state;
		});
		queued = job;
		tail = job.promise.catch(() => {});
		return job.promise;
	}

	async function run(refresh) {
		const client = api();
		const wasDown = state.sync.failures > 0 || state.sync.online === false;
		let uploaded = 0;
		try {
			// In batches of 200 until nothing is left (a refused entry waits for the person).
			for (let round = 0; round < 50; round++) {
				const sent = T.pending(mine(state)).slice(0, 200);
				if (!sent.length) break;
				const res = await client.batch(sent, state.clockOffset);
				state = T.applyResults(state, res.results, sent);
				uploaded += sent.length;
			}
			const t0 = now();
			const timer = await client.timer();
			const offset = Math.round((t0 - fromUtc(timer.now)) / 1000);
			state = T.adoptServerTimer({ ...state, clockOffset: Math.abs(offset) > 5 ? offset : 0 }, timer.timer, now());
			if (refresh || now() - lastRefresh > REFRESH_MS) {
				const [schedule, tasks] = await Promise.all([client.schedule(14), client.tasks()]);
				lastRefresh = now();
				state = { ...state, workDay: schedule.work_day, schedule: schedule.schedule, tasks };
			}
			// Back online after a while: "Synced N entries".
			const flash = wasDown && uploaded ? { n: uploaded, atMs: now() } : state.sync.flash;
			state = T.prune({ ...state, sync: { ...state.sync, online: true, failures: 0, lastOkAt: now(), lastSent: uploaded, error: null, flash } }, now());
		} catch (e) {
			if (e.signedOut) {
				// Revoked, a new code, removed: sign in again; time not sent yet stays here.
				token = null;
				saveToken(null);
				state = { ...T.stop(state, now()), member: null, signedOut: true };
			} else {
				state = { ...state, sync: { ...state.sync, online: e.offline ? false : state.sync.online, failures: state.sync.failures + 1, error: e.offline ? null : e.message } };
			}
		}
		persist();
		return state;
	}

	function dismiss(id) {
		return set(T.dismiss(state, id));
	}

	// Saved every 30 s while a timer runs.
	function heartbeat() {
		if (state.timer) set(T.heartbeat(state, now()));
		return state;
	}

	// The person's answer to a question the tracker asked.
	function answer(prompt, choice) {
		if (prompt === 'crash') set(T.resolveCrash(state, choice, now()));
		sync();
		return state;
	}

	// When to sync next: soon after a failure while something waits (5 s, 15 s, 1 min, 5 min), else in
	// a minute.
	function nextSyncMs() {
		const waiting = T.pending(mine(state)).length;
		return waiting && state.sync.failures ? T.retryDelayMs(state.sync.failures) : 60 * 1000;
	}

	// What the window and the tray show.
	function view() {
		const nowMs = now();
		const run = T.running(state);
		return {
			server: state.server,
			signedIn: !!(token && state.member),
			signedOut: !!state.signedOut,
			member: state.member,
			workDay: state.workDay,
			today: (state.schedule || []).find((d) => d.date === localDay(nowMs)) || null,
			choices: T.choices(state),
			recent: state.recent,
			running: run ? { ...run, startedMs: fromUtc(run.started_at) } : null,
			todaySeconds: Math.round(T.todaySeconds(state, nowMs)),
			waiting: T.pending(mine(state)).length,
			attention: T.attention(state),
			sync: state.sync,
			prompts: { ...state.prompts, crash: state.prompts.crash ? { ...state.prompts.crash, label: (T.running(state) || {}).label } : undefined },
			flash: state.sync.flash && now() - state.sync.flash.atMs < 10000 ? state.sync.flash : null,
			snoozeUntil: state.snoozeUntil,
		};
	}

	return {
		get state() {
			return state;
		},
		set,
		signIn,
		signOut,
		start,
		stop,
		sync,
		dismiss,
		heartbeat,
		answer,
		nextSyncMs,
		view,
		hasToken: () => !!token,
	};
}
