import { describe, expect, it } from 'vitest';
import { addDays, canEditTime, canSetStart, elapsed, entryLabel, flagLabels, fmtClock, isTracked, localDate, localTime, runningOf, splitMinutes, toUtc } from '../lib/timer.js';

const data = {
	time_entries: {
		a: { id: 'a', member_id: 'm1', started_at: '2026-10-29 09:00:00', ended_at: '2026-10-29 10:00:00' },
		b: { id: 'b', member_id: 'm1', started_at: '2026-10-29 11:00:00', ended_at: null, ref_kind: 'item', ref_id: 't1' },
		c: { id: 'c', member_id: 'm2', started_at: '2026-10-29 11:00:00', ended_at: null, deleted_at: '2026-10-29 11:05:00' },
	},
	meeting_tasks: { t1: { id: 't1', title: 'Fix H1 tags' } },
	monthly_tasks: {},
	projects: { p1: { id: 'p1', name: 'Acme Plumbing' } },
};

describe('timer', () => {
	it('finds the running timer of a person, never a deleted one', () => {
		expect(runningOf(data, 'm1').id).toBe('b');
		expect(runningOf(data, 'm2')).toBeNull();
	});

	it('formats the clock', () => {
		expect(fmtClock(0)).toBe('0:00');
		expect(fmtClock(65)).toBe('1:05');
		expect(fmtClock(3909)).toBe('1:05:09');
	});

	it('counts seconds until now, or until the end', () => {
		expect(elapsed(data.time_entries.a, 0)).toBe(3600);
		expect(elapsed(data.time_entries.b, Date.parse('2026-10-29T11:30:00Z'))).toBe(1800);
	});

	it('names an entry by its task, its project, or No task', () => {
		expect(entryLabel(data.time_entries.b, data)).toBe('Fix H1 tags');
		expect(entryLabel({ ref_kind: 'none', project_id: 'p1' }, data)).toBe('Acme Plumbing');
		expect(entryLabel({ ref_kind: 'none' }, data)).toBe('No task');
	});

	it('splits a report into tracked and handwritten minutes', () => {
		const entries = [{ minutes: 60, source: 'tracked' }, { minutes: 30 }, { minutes: 15, source: 'hand' }];
		expect(isTracked(entries[0])).toBe(true);
		expect(isTracked(entries[1])).toBe(false);
		expect(splitMinutes(entries)).toEqual({ tracked: 60, hand: 45, total: 105 });
	});
});

describe('time tab', () => {
	const admin = { id: 'a', role: 'admin' };
	const lead = { id: 'l', role: 'lead' };
	const lead2 = { id: 'l2', role: 'lead' };
	const member = { id: 'm', role: 'member' };

	it('adds days', () => {
		expect(addDays('2026-10-29', -6)).toBe('2026-10-23');
		expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
	});

	it('mirrors who may change whose time', () => {
		const today = '2026-10-29';
		expect(canEditTime(member, member, { day: today }, today)).toBe(true);
		expect(canEditTime(member, member, { day: '2026-10-28' }, today)).toBe(false);
		expect(canEditTime(lead, member, { day: '2026-10-01' }, today)).toBe(true);
		expect(canEditTime(lead, lead2, { day: today }, today)).toBe(false);
		expect(canEditTime(admin, lead, { day: '2026-10-01' }, today)).toBe(true);
		expect(canEditTime(member, lead, { day: today }, today)).toBe(false);
	});

	it('mirrors who sets when a day starts', () => {
		expect(canSetStart(admin, lead)).toBe(true);
		expect(canSetStart(lead, member)).toBe(true);
		expect(canSetStart(lead, lead2)).toBe(false);
		expect(canSetStart(member, member)).toBe(false);
	});

	it('round-trips local times', () => {
		const utc = toUtc('2026-10-29', '09:30');
		expect(localTime(utc)).toBe('09:30');
		expect(localDate(utc)).toBe('2026-10-29');
	});

	it('labels flags', () => {
		expect(flagLabels({ flags: { day_off: true, clock_skew: 300 } })).toEqual(['Day off', 'Clock was off']);
		expect(flagLabels({})).toEqual([]);
	});
});
