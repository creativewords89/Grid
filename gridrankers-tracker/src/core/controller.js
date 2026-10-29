// The tracker without Electron: state, the file it lives in, the portal API. main.js wires it to the
// window, the tray and the operating system; tests drive it with a fake API.

import { createClient, DEFAULT_SERVER } from './api.js';
import { fromUtc, localDay } from './clock.js';
import { dueReminder, markFired, SNOOZE_MS } from './reminders.js';
import * as S from './shots.js';
import * as T from './tracker.js';

// Schedule and tasks are refreshed this often while online.
export const REFRESH_MS = 5 * 60 * 1000;

// Screenshots uploaded per sync (the rest go next time).
export const SHOTS_PER_SYNC = 10;

// `readShot(file)` → the picture's bytes (or null when gone) and `removeShot(file)` deletes it: the
// screenshots waiting to upload are files on this computer (SPEC.md 6.23).
export function createController({ store, loadToken, saveToken, device, createApi = createClient, now = () => Date.now(), onChange = () => {}, readShot = () => null, removeShot = () => {} }) {
	let state = { ...T.emptyState(DEFAULT_SERVER), ...(store.load(null) || {}) };
	// A timer left running by a crash, a power cut or a killed app: ask what to do with it.
	state = T.checkCrash(state, now());
	let token = loadToken() || null;
	// The first build (1.0.3) pointed at portal.gridrankers.com; the tracker's portal is DEFAULT_SERVER.
	if (!token && state.server === 'https://portal.gridrankers.com') state = { ...state, server: DEFAULT_SERVER };
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
		set(S.withEvery(T.signedIn(base, res), res.screenshots));
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
		if (!state.member || (state.profileMissing || []).length) return state;
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
			await uploadShots(client);
			const t0 = now();
			const timer = await client.timer();
			const offset = Math.round((t0 - fromUtc(timer.now)) / 1000);
			state = T.adoptServerTimer({ ...state, clockOffset: Math.abs(offset) > 5 ? offset : 0 }, timer.timer, now());
			if (refresh || now() - lastRefresh > REFRESH_MS) {
				const [schedule, tasks] = await Promise.all([client.schedule(14), client.tasks()]);
				lastRefresh = now();
				state = T.withProfile(S.withEvery({ ...state, workDay: schedule.work_day, schedule: schedule.schedule, tasks }, schedule.screenshots), schedule.profile_missing);
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

	// Screenshots whose entry is on the portal go up; one whose entry is gone (discarded) is dropped.
	// Offline or signed out stops the sync as for entries.
	async function uploadShots(client) {
		const queue = (state.shots && state.shots.queue) || {};
		Object.values(queue)
			.filter((s) => !state.entries[s.entryId])
			.forEach((s) => answeredShot(s.id, 'gone'));
		for (const shot of S.ready(state).slice(0, SHOTS_PER_SYNC)) {
			const bytes = readShot(shot.file);
			if (!bytes) {
				answeredShot(shot.id, 'gone');
				continue;
			}
			let outcome;
			try {
				outcome = (await client.uploadShot(shot.entryId, { id: shot.id, takenAt: shot.takenAt, bytes })).status;
			} catch (e) {
				if (e.offline || e.signedOut) throw e;
				outcome = e.code === 'grp_screenshots_off' ? 'off' : e.status === 404 ? 'gone' : 'refused';
			}
			answeredShot(shot.id, outcome);
		}
	}
	function answeredShot(id, outcome) {
		const res = S.answered(state, id, outcome);
		state = res.state;
		if (res.remove) removeShot(res.remove);
	}

	// Every few seconds while a timer runs: a screenshot to take now, if any (`{id, entryId, takenAt}`).
	function shotDue() {
		const res = S.due(state, now());
		const plan = (st) => JSON.stringify(st.shots ? st.shots.plan : null);
		if (plan(res.state) !== plan(state)) set(res.state);
		return res.take;
	}

	// The screenshot was taken and saved: it waits to upload.
	function addShot(take, file) {
		set(S.queued(state, take, file));
		sync();
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
		if (prompt === 'away') set(T.resolveAway(state, choice, now()));
		if (prompt === 'shots') set(S.noticeOk(state));
		sync();
		return state;
	}

	// Every 30 s: asks when the person has been idle 10 minutes with a timer running, and returns the
	// reminder to show now, if any (it is recorded, and shown in the window until the next one).
	function tick({ idleSeconds = 0 } = {}) {
		const nowMs = now();
		if (state.timer && idleSeconds >= T.IDLE_ASK_SECONDS && !state.prompts.away) set(T.away(state, nowMs - idleSeconds * 1000, 'idle'));
		else if (state.prompts.away && !state.prompts.away.toMs && idleSeconds < 60) set(T.back(state, nowMs - idleSeconds * 1000));
		const due = state.member ? dueReminder({ schedule: state.schedule, nowMs, running: !!state.timer, online: state.sync.online, snoozeUntil: state.snoozeUntil, fired: state.fired }) : null;
		if (!due) return null;
		set({ ...state, fired: markFired(state.fired, due.kind, nowMs), lastReminder: { ...due, atMs: nowMs } });
		return due;
	}

	// The computer goes to sleep / wakes up.
	function suspended() {
		set({ ...state, suspendedMs: now() });
	}
	function resumed() {
		const from = state.suspendedMs;
		if (from && state.timer && now() - from >= T.SLEEP_ASK_MS) set(T.away({ ...state, suspendedMs: null }, from, 'sleep', now()));
		else set({ ...state, suspendedMs: null });
		sync({ refresh: true });
	}

	// Snooze 15 min: no reminders until then.
	function snooze() {
		return set({ ...state, snoozeUntil: now() + SNOOZE_MS, lastReminder: null });
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
			screenshots: (state.shots && state.shots.every) || 0,
			profileMissing: state.profileMissing || [],
			shotsWaiting: Object.keys((state.shots && state.shots.queue) || {}).length,
			prompts: { ...state.prompts, shots: state.member && S.noticeDue(state) ? { every: state.shots.every } : undefined, crash: state.prompts.crash ? { ...state.prompts.crash, label: (T.running(state) || {}).label } : undefined, away: state.prompts.away ? { ...state.prompts.away, minutes: Math.max(1, Math.round(((state.prompts.away.toMs || nowMs) - state.prompts.away.fromMs) / 60000)) } : undefined },
			flash: state.sync.flash && now() - state.sync.flash.atMs < 10000 ? state.sync.flash : null,
			reminder: state.lastReminder && now() - state.lastReminder.atMs < 15 * 60 * 1000 && now() >= state.snoozeUntil ? state.lastReminder : null,
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
		tick,
		suspended,
		resumed,
		snooze,
		shotDue,
		addShot,
		nextSyncMs,
		view,
		hasToken: () => !!token,
	};
}
