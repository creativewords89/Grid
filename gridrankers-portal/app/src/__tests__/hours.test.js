import { describe, expect, it } from 'vitest';
import { hoursPeople, weekHours } from '../lib/hours.js';
import { hostOf, isTracker, mainMark, trackerElsewhere } from '../lib/site.js';

const members = {
	a: { id: 'a', name: 'Ada', role: 'admin', active: 1 },
	l: { id: 'l', name: 'Lee', role: 'lead', active: 1 },
	l2: { id: 'l2', name: 'Liv', role: 'lead', active: 1 },
	m: { id: 'm', name: 'Max', role: 'member', active: 1 },
	o: { id: 'o', name: 'Olu', role: 'member', active: 0 },
};

describe('tracker portal hours', () => {
	it('shows who each role may see', () => {
		expect(hoursPeople(members, members.a).map((p) => p.id)).toEqual(['l', 'l2', 'm']);
		expect(hoursPeople(members, members.l).map((p) => p.id)).toEqual(['l', 'm']);
		expect(hoursPeople(members, members.m).map((p) => p.id)).toEqual(['m']);
	});

	it('adds a week per person and day with what is not on the main portal', () => {
		const entries = [
			{ member_id: 'm', day: '2026-10-28', seconds: 3600, main_synced_at: '2026-10-28 10:00:00', updated_at: '2026-10-28 10:00:00' },
			{ member_id: 'm', day: '2026-10-29', seconds: 1800, main_synced_at: null, updated_at: '2026-10-29 10:00:00' },
			{ member_id: 'm', day: '2026-10-29', seconds: 900, main_error: 'Report sent', main_synced_at: '2026-10-29 10:00:00', updated_at: '2026-10-29 10:00:00' },
			{ member_id: 'm', day: '2026-10-29', seconds: 600, deleted_at: '2026-10-29 11:00:00' },
			{ member_id: 'm', day: '2026-10-01', seconds: 600 },
		];
		const { days, rows } = weekHours(entries, [members.m], '2026-10-29');
		expect(days[0]).toBe('2026-10-23');
		expect(rows[0].days['2026-10-28']).toBe(60);
		expect(rows[0].days['2026-10-29']).toBe(45);
		expect(rows[0].total).toBe(105);
		expect(rows[0].waiting).toBe(1);
		expect(rows[0].refused).toBe(1);
	});
});

describe('sites', () => {
	it('reads the page config', () => {
		expect(isTracker({ site: { part: 'tracker' } })).toBe(true);
		expect(isTracker({ site: { part: 'main' } })).toBe(false);
		expect(isTracker({})).toBe(false);
		expect(trackerElsewhere({ site: { part: 'main', trackerUrl: 'https://tracker.gridrankers.com' } })).toBe('https://tracker.gridrankers.com');
		expect(trackerElsewhere({ site: { part: 'main', trackerUrl: '' } })).toBe('');
		expect(hostOf('https://bot.gridrankers.com/')).toBe('bot.gridrankers.com');
	});

	it('marks entries not on the main portal', () => {
		expect(mainMark({ main_synced_at: '2026-10-29 10:00:00', updated_at: '2026-10-29 10:00:00' }, 'bot')).toBeNull();
		expect(mainMark({ main_synced_at: null }, 'bot').text).toBe('Not on bot yet');
		expect(mainMark({ main_error: 'Report sent' }, 'bot')).toEqual({ kind: 'refused', text: 'Not on bot: Report sent' });
	});
});
