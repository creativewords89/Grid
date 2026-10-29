// The tracker's state on this computer (SPEC.md 6.21). Everything is written here first — starting,
// stopping, switching — and uploaded afterwards, so no time is lost when the portal can't be reached.
// Pure functions: each takes the state and returns the next one.

import { fromUtc, localDay, toUtc } from './clock.js';
import { ulid } from './ids.js';

// Uploaded entries are kept this long, then forgotten (the portal has them).
export const KEEP_DAYS = 14;

export function emptyState(server) {
	return {
		server,
		member: null,
		workDay: null,
		schedule: [],
		tasks: { projects: [], tasks: [] },
		timer: null,
		entries: {},
		recent: [],
		clockOffset: 0,
		sync: { online: null, failures: 0, lastOkAt: 0, lastSent: 0 },
		prompts: {},
		snoozeUntil: 0,
		fired: {},
	};
}

// What the portal answered on sign-in (or a refresh): the person, their working day, schedule and tasks.
export function signedIn(state, payload) {
	const next = {
		...state,
		member: payload.member || state.member,
		workDay: payload.work_day || state.workDay,
		schedule: payload.schedule || state.schedule,
		tasks: payload.tasks || state.tasks,
	};
	return payload.timer !== undefined ? adoptServerTimer(next, payload.timer, Date.now()) : next;
}

// A task as the timer shows it: `{key, ref_kind, ref_id, period_key, project_id, label, sub}`.
export function taskKey(t) {
	return t.ref_kind === 'none' ? `none:${t.project_id || ''}` : `${t.ref_kind}:${t.ref_id}`;
}

// The choices to track time on: the person's tasks, No task, then each project (No task).
export function choices(state) {
	const tasks = (state.tasks.tasks || []).map((t) => ({ ref_kind: t.kind, ref_id: t.id, period_key: t.period_key || null, project_id: t.project_id || null, label: t.title, sub: t.project_name || 'General task' }));
	const none = { ref_kind: 'none', ref_id: null, period_key: null, project_id: null, label: 'No task', sub: 'Office · anything else' };
	const projects = (state.tasks.projects || []).map((p) => ({ ref_kind: 'none', ref_id: null, period_key: null, project_id: p.id, label: p.name, sub: 'Project · no task' }));
	return [...tasks, none, ...projects].map((c) => ({ ...c, key: taskKey(c) }));
}

// Starts the timer on a task now; one already running stops at this moment.
export function start(state, task, nowMs, id = ulid(nowMs)) {
	let next = state.timer ? stop(state, nowMs) : state;
	const startedAt = toUtc(nowMs);
	const entry = {
		id,
		ref_kind: task.ref_kind || 'none',
		ref_id: task.ref_id || null,
		period_key: task.period_key || null,
		project_id: task.project_id || null,
		label: task.label || 'No task',
		started_at: startedAt,
		ended_at: null,
		idle_seconds: 0,
		synced: 'none',
		error: null,
	};
	const key = taskKey(entry);
	return {
		...next,
		timer: { id, startedMs: fromUtc(startedAt), heartbeatMs: nowMs },
		entries: { ...next.entries, [id]: entry },
		recent: [key, ...next.recent.filter((k) => k !== key)].slice(0, 5),
	};
}

// Stops the running timer at `atMs` (at least a second after it started).
export function stop(state, atMs, idleSeconds = 0) {
	if (!state.timer) return state;
	const entry = state.entries[state.timer.id];
	if (!entry) return { ...state, timer: null };
	const end = Math.max(atMs, fromUtc(entry.started_at) + 1000);
	return {
		...state,
		timer: null,
		entries: { ...state.entries, [entry.id]: { ...entry, ended_at: toUtc(end), idle_seconds: (entry.idle_seconds || 0) + Math.max(0, Math.round(idleSeconds)) } },
	};
}

// The running entry, or null.
export const running = (state) => (state.timer ? state.entries[state.timer.id] || null : null);

// Entries waiting to be uploaded: new ones, and running ones that have since stopped. Refused ones
// wait for the person (Needs attention).
export function pending(state) {
	return Object.values(state.entries)
		.filter((e) => !e.error && (e.synced === 'none' || (e.synced === 'running' && e.ended_at)))
		.sort((a, b) => a.started_at.localeCompare(b.started_at))
		.map((e) => ({
			id: e.id,
			ref_kind: e.ref_kind,
			ref_id: e.ref_id,
			period_key: e.period_key,
			project_id: e.project_id,
			started_at: e.started_at,
			ended_at: e.ended_at,
			idle_seconds: e.idle_seconds || 0,
		}));
}

// The portal's answer to a batch: saved / already there → uploaded; refused → Needs attention. An
// entry the portal has already stopped (from the portal, or after 12 hours) stops here too.
// `sent`: the entries as uploaded — one stopped here while its running version was on the way still
// has its stop to send.
export function applyResults(state, results, sent = []) {
	const sentById = Object.fromEntries(sent.map((e) => [e.id, e]));
	let next = { ...state, entries: { ...state.entries } };
	(results || []).forEach((r) => {
		const entry = next.entries[r.id];
		if (!entry) return;
		if (r.status === 'refused') {
			next.entries[r.id] = { ...entry, error: { code: r.code, message: r.message } };
			if (next.timer && next.timer.id === r.id) next = { ...next, timer: null };
			return;
		}
		const server = r.entry || {};
		const endedAt = entry.ended_at || server.ended_at || null;
		const sentEnd = sentById[r.id] ? sentById[r.id].ended_at : entry.ended_at;
		const done = !!(sentEnd || server.ended_at);
		next.entries[r.id] = { ...entry, ended_at: endedAt, synced: done ? 'done' : 'running', error: null };
		if (!entry.ended_at && server.ended_at && next.timer && next.timer.id === r.id) next = { ...next, timer: null };
	});
	return next;
}

// What the portal says is running (GET /timer, or the sign-in answer). A timer started on the portal
// or another computer shows here; one this computer uploaded as running but the portal has stopped,
// stops here.
export function adoptServerTimer(state, serverTimer, nowMs) {
	const local = running(state);
	// Stopped here and the stop not uploaded yet: the portal's answer is older than that.
	const known = serverTimer && state.entries[serverTimer.id];
	if (known && known.ended_at) return state;
	if (serverTimer && (!local || local.id !== serverTimer.id)) {
		if (local && local.synced === 'none') return state; // ours wins until it is uploaded
		const entry = {
			id: serverTimer.id,
			ref_kind: serverTimer.ref_kind || 'none',
			ref_id: serverTimer.ref_id || null,
			period_key: serverTimer.period_key || null,
			project_id: serverTimer.project_id || null,
			label: labelOf(state, serverTimer),
			started_at: serverTimer.started_at,
			ended_at: null,
			idle_seconds: 0,
			synced: 'running',
			error: null,
		};
		const base = local ? { ...state, entries: { ...state.entries, [local.id]: { ...local, ended_at: toUtc(nowMs), synced: 'done' } } } : state;
		return { ...base, timer: { id: entry.id, startedMs: fromUtc(entry.started_at), heartbeatMs: nowMs }, entries: { ...base.entries, [entry.id]: entry } };
	}
	if (!serverTimer && local && local.synced === 'running') {
		return { ...state, timer: null, entries: { ...state.entries, [local.id]: { ...local, ended_at: local.ended_at || toUtc(nowMs), synced: 'done' } } };
	}
	return state;
}

// A name for an entry: its task's title (from the task list), else its project, else "No task".
export function labelOf(state, e) {
	const found = choices(state).find((c) => c.key === taskKey(e));
	return found ? found.label : 'No task';
}

// Forgets uploaded entries older than KEEP_DAYS.
export function prune(state, nowMs) {
	const limit = nowMs - KEEP_DAYS * 86400000;
	const entries = Object.fromEntries(Object.entries(state.entries).filter(([, e]) => !(e.synced === 'done' && fromUtc(e.started_at) < limit)));
	return { ...state, entries };
}

// Entries the portal refused: shown under Needs attention, never dropped silently.
export const attention = (state) => Object.values(state.entries).filter((e) => e.error);

// The person dismisses a refused entry (it was wrong): it is forgotten.
export function dismiss(state, id) {
	const entries = { ...state.entries };
	delete entries[id];
	return { ...state, entries };
}

// Seconds tracked today on this computer (local day), the running timer included.
export function todaySeconds(state, nowMs) {
	const today = localDay(nowMs);
	return Object.values(state.entries)
		.filter((e) => !e.error && localDay(fromUtc(e.started_at)) === today)
		.reduce((s, e) => s + Math.max(0, ((e.ended_at ? fromUtc(e.ended_at) : nowMs) - fromUtc(e.started_at)) / 1000), 0);
}
