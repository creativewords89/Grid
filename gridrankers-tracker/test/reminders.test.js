import { describe, expect, it } from 'vitest';
import { dueReminder, markFired } from '../src/core/reminders.js';
import * as T from '../src/core/tracker.js';

const at = (hm, day = '2026-10-29') => Date.parse(`${day}T${hm}:00Z`);
const schedule = [
	{ date: '2026-10-29', working: true, reason: null, label: '', start: '09:00', end: '17:00' },
	{ date: '2026-10-30', working: false, reason: 'weekly', label: 'Friday', start: '09:00', end: '17:00' },
	{ date: '2026-10-31', working: false, reason: 'leave', label: 'Leave', start: '09:00', end: '17:00' },
];
const due = (hm, more = {}, day) => dueReminder({ schedule, nowMs: at(hm, day), running: false, online: true, ...more });

describe('reminders', () => {
	it('start your timer: 5 minutes after the start, then every 15 minutes', () => {
		expect(due('08:59')).toBeNull();
		expect(due('09:04')).toBeNull();
		expect(due('09:05').kind).toBe('start');
		expect(due('09:05').title).toMatch(/start your timer/);
		const fired = markFired({}, 'start', at('09:05'));
		expect(due('09:15', { fired })).toBeNull();
		expect(due('09:20', { fired }).kind).toBe('start');
		expect(due('10:00', { running: true })).toBeNull();
	});

	it('offline: every 15 minutes, even with the timer running', () => {
		expect(due('11:00', { running: true, online: false }).kind).toBe('offline');
		const fired = markFired({}, 'offline', at('11:00'));
		expect(due('11:10', { running: true, online: false, fired })).toBeNull();
		expect(due('11:15', { running: true, online: false, fired }).kind).toBe('offline');
	});

	it('the end of the day: at the end, and once 30 minutes later if the timer still runs', () => {
		expect(due('17:00').kind).toBe('end');
		let fired = markFired({}, 'end', at('17:00'));
		expect(due('17:10', { fired, running: true })).toBeNull();
		expect(due('17:30', { fired })).toBeNull();
		expect(due('17:30', { fired, running: true }).kind).toBe('end2');
		fired = markFired(fired, 'end2', at('17:30'));
		expect(due('17:40', { fired, running: true })).toBeNull();
		expect(due('18:00', { fired, running: true })).toBeNull();
	});

	it('never on a day off, on leave, or a day the schedule doesn’t know', () => {
		expect(due('10:00', {}, '2026-10-30')).toBeNull();
		expect(due('10:00', {}, '2026-10-31')).toBeNull();
		expect(due('10:00', {}, '2026-11-02')).toBeNull();
	});

	it('Snooze 15 min holds every reminder', () => {
		expect(due('10:00', { snoozeUntil: at('10:15') })).toBeNull();
		expect(due('10:15', { snoozeUntil: at('10:15') }).kind).toBe('start');
	});
});

describe('away', () => {
	const base = T.signedIn(T.emptyState('https://p.example'), { member: { id: 'm1', name: 'Max' }, tasks: { projects: [], tasks: [] }, schedule });
	const none = { ref_kind: 'none', label: 'No task' };

	it('Keep: the time away stays and counts as idle', () => {
		let s = T.start(base, none, at('10:00'), 'A'.repeat(26));
		s = T.away(s, at('10:20'), 'idle');
		s = T.back(s, at('10:34'));
		s = T.resolveAway(s, 'keep', at('10:40'));
		expect(T.running(s).id).toBe('A'.repeat(26));
		expect(T.running(s).idle_seconds).toBe(14 * 60);
		expect(s.prompts.away).toBeUndefined();
	});

	it('Discard: ends when the person left and starts again when they came back', () => {
		let s = T.start(base, none, at('10:00'), 'A'.repeat(26));
		s = T.away(s, at('10:20'), 'sleep', at('11:00'));
		s = T.resolveAway(s, 'discard', at('11:02'));
		expect(s.entries['A'.repeat(26)].ended_at).toBe('2026-10-29 10:20:00');
		expect(T.running(s).started_at).toBe('2026-10-29 11:00:00');
		expect(T.running(s).label).toBe('No task');
	});

	it('asks once per time away, and never without a timer', () => {
		expect(T.away(base, at('10:00'), 'idle').prompts.away).toBeUndefined();
		let s = T.away(T.start(base, none, at('10:00'), 'A'.repeat(26)), at('10:20'), 'idle');
		expect(T.away(s, at('10:30'), 'idle').prompts.away.fromMs).toBe(at('10:20'));
	});
});
