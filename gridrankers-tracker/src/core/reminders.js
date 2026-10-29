// Reminders (SPEC.md 6.21): only during the working day of a working day in the person's schedule —
// never on a day off or approved leave — worked out from the saved schedule, so they are right offline.
//   - no timer running: 5 minutes after the start, then every 15 minutes;
//   - offline: every 15 minutes ("your time is saved");
//   - the end of the day: at the end, and once 30 minutes later if the timer still runs.
// Every reminder can be snoozed for 15 minutes; they can't be turned off.

import { fmtTime, hhmm, localDay, localMinutes } from './clock.js';

export const EVERY_MS = 15 * 60 * 1000;
export const SNOOZE_MS = 15 * 60 * 1000;

// Today's line of the schedule, or null (no line: nothing is known about today, so no reminders).
export const todayOf = (schedule, nowMs) => (schedule || []).find((d) => d.date === localDay(nowMs)) || null;

// The reminder due now, or null. `fired` holds when each kind last went off.
export function dueReminder({ schedule, nowMs, running, online, snoozeUntil = 0, fired = {} }) {
	const today = todayOf(schedule, nowMs);
	if (!today || !today.working || nowMs < snoozeUntil) return null;
	const start = hhmm(today.start);
	const end = hhmm(today.end);
	const m = localMinutes(nowMs);
	const day = today.date;
	const since = (kind) => nowMs - ((fired[kind] && fired[kind].day === day && fired[kind].atMs) || 0);
	const time = fmtTime(nowMs);

	if (m >= end && m < end + 45) {
		if (!fired.end || fired.end.day !== day) {
			return { kind: 'end', title: `It’s ${time} — stop your timer and send your daily report`, body: 'Your working day is over. Send today’s report on the portal.' };
		}
		if (running && m >= end + 30 && (!fired.end2 || fired.end2.day !== day)) {
			return { kind: 'end2', title: 'Your timer is still running', body: `It’s ${time} — stop it if you’re done for the day.` };
		}
		return null;
	}
	if (m < start || m >= end) return null;

	if (!running && m >= start + 5 && since('start') >= EVERY_MS) {
		return { kind: 'start', title: `It’s ${time} — start your timer`, body: 'Pick what you’re working on in GridRankers Tracker.' };
	}
	if (online === false && since('offline') >= EVERY_MS) {
		return { kind: 'offline', title: 'Tracker isn’t connected', body: 'Your time is saved on this computer — check your internet.' };
	}
	return null;
}

// Records that a reminder went off.
export function markFired(fired, kind, nowMs) {
	return { ...fired, [kind]: { day: localDay(nowMs), atMs: nowMs } };
}
