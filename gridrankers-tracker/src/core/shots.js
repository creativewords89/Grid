// Screenshots while a timer runs (SPEC.md 6.23): one at a random moment in each period of `every`
// minutes, only after the person has been told once, and kept on the computer until the portal has
// them. Pure functions over the tracker's state.

import { toUtc } from './clock.js';
import { ulid } from './ids.js';

// Tries before a screenshot the portal keeps refusing is dropped.
export const MAX_TRIES = 5;

// The portal's setting (minutes between screenshots; 0 = none), from sign-in or a refresh.
export function withEvery(state, every) {
	const n = [5, 10, 15, 30].includes(+every) ? +every : 0;
	return { ...state, shots: { ...emptyShots(), ...(state.shots || {}), every: n } };
}

export function emptyShots() {
	return { every: 0, noticeOk: 0, plan: null, queue: {} };
}

// The one-time notice is due: screenshots are on and the person hasn't said OK to this interval.
export const noticeDue = (state) => !!state.shots && state.shots.every > 0 && state.shots.noticeOk !== state.shots.every;

export function noticeOk(state) {
	return { ...state, shots: { ...state.shots, noticeOk: state.shots.every } };
}

// Whether a screenshot is due now. Returns `{state, take}` where take is `{id, entryId, takenAt}` or
// null. A new period starts when the timer starts (or switches) and every `every` minutes after.
export function due(state, nowMs, random = Math.random) {
	const shots = state.shots || emptyShots();
	if (!state.timer || !shots.every || noticeDue(state)) return { state, take: null };
	const everyMs = shots.every * 60000;
	let plan = shots.plan;
	if (!plan || plan.entryId !== state.timer.id || nowMs >= plan.endMs) {
		const startMs = plan && plan.entryId === state.timer.id ? Math.max(plan.endMs, nowMs - everyMs + 1) : Math.max(state.timer.startedMs, nowMs);
		plan = { entryId: state.timer.id, endMs: startMs + everyMs, atMs: startMs + Math.floor(random() * everyMs), taken: false };
	}
	let take = null;
	if (!plan.taken && nowMs >= plan.atMs) {
		take = { id: ulid(nowMs), entryId: plan.entryId, takenAt: toUtc(nowMs) };
		plan = { ...plan, taken: true };
	}
	return { state: { ...state, shots: { ...shots, plan } }, take };
}

// A screenshot taken and saved to `file`: waits to upload.
export function queued(state, take, file) {
	const shots = state.shots || emptyShots();
	return { ...state, shots: { ...shots, queue: { ...shots.queue, [take.id]: { ...take, file, tries: 0 } } } };
}

// Screenshots ready to upload: their entry is on the portal (sent at least once).
export function ready(state) {
	const queue = (state.shots && state.shots.queue) || {};
	return Object.values(queue).filter((s) => {
		const e = state.entries[s.entryId];
		return e && (e.synced === 'done' || e.synced === 'running');
	});
}

// The portal's answer: saved / already there → gone from the queue; refused → tried again later, and
// dropped after MAX_TRIES (or at once when screenshots are off or the entry is gone). Returns
// `{state, remove}` with the file to delete when it leaves the queue.
export function answered(state, id, outcome) {
	const queue = { ...state.shots.queue };
	const shot = queue[id];
	if (!shot) return { state, remove: null };
	const done = outcome === 'saved' || outcome === 'exists' || outcome === 'off' || outcome === 'gone' || shot.tries + 1 >= MAX_TRIES;
	if (done) delete queue[id];
	else queue[id] = { ...shot, tries: shot.tries + 1 };
	return { state: { ...state, shots: { ...state.shots, queue } }, remove: done ? shot.file : null };
}

// A deleted entry's screenshots (Discard) leave with it.
export function dropFor(state, entryIds) {
	const queue = { ...((state.shots && state.shots.queue) || {}) };
	const remove = [];
	Object.values(queue).forEach((s) => {
		if (entryIds.includes(s.entryId)) {
			remove.push(s.file);
			delete queue[s.id];
		}
	});
	return { state: { ...state, shots: { ...(state.shots || emptyShots()), queue } }, remove };
}
