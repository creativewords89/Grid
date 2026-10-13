import { describe, expect, it } from 'vitest';
import { after, asksBeforeSignOut, cleanLink, entryError, fmtMinutes, monthDays, projectName, seesTeamReports, shiftMonth, summary, teamCounts, toMinutes, writesReports } from '../lib/reports.js';

describe('daily reports (SPEC.md 6.18)', () => {
	it('formats and adds up time spent', () => {
		expect(fmtMinutes(45)).toBe('45m');
		expect(fmtMinutes(60)).toBe('1h');
		expect(fmtMinutes(90)).toBe('1h 30m');
		expect(toMinutes('1', '15')).toBe(75);
		expect(toMinutes('', '')).toBe(0);
		expect(toMinutes('30', '0')).toBe(1440);
		expect(summary([{ minutes: 120 }, { minutes: 30 }])).toBe('2 entries · 2h 30m');
		expect(summary([{ minutes: 15 }])).toBe('1 entry · 15m');
	});

	it('checks an entry before it is added', () => {
		expect(entryError({ title: ' ', minutes: 30 })).toBe('Write what you did.');
		expect(entryError({ title: 'Audit', minutes: 0 })).toBe('Add the time spent.');
		expect(entryError({ title: 'Audit', minutes: 30 })).toBe('');
	});

	it('accepts only http(s) links and names them by host', () => {
		expect(cleanLink('javascript:alert(1)')).toBeNull();
		expect(cleanLink('docs.google.com/x')).toBeNull();
		expect(cleanLink('https://docs.google.com/document/d/1')).toEqual({ url: 'https://docs.google.com/document/d/1', name: 'docs.google.com' });
		expect(cleanLink('https://loom.com/a', 'Walkthrough')).toEqual({ url: 'https://loom.com/a', name: 'Walkthrough' });
	});

	it('names an entry project', () => {
		const projects = { p1: { name: 'Acme Plumbing' } };
		expect(projectName('', projects)).toBe('');
		expect(projectName('office', projects)).toBe('Office');
		expect(projectName('p1', projects)).toBe('Acme Plumbing');
		expect(projectName('gone', projects)).toBe('Deleted project');
	});

	it('knows who writes and who reads the team', () => {
		expect(writesReports({ role: 'member' })).toBe(true);
		expect(writesReports({ role: 'lead' })).toBe(true);
		expect(writesReports({ role: 'admin' })).toBe(false);
		expect(seesTeamReports({ role: 'member' })).toBe(false);
		expect(seesTeamReports({ role: 'lead' })).toBe(true);
	});

	it('asks for the report before signing out on a working day only', () => {
		expect(asksBeforeSignOut({ writes: true, out_today: null, report: null })).toBe(true);
		expect(asksBeforeSignOut({ writes: true, out_today: null, report: { sent_at: '2026-10-13 12:00:00' } })).toBe(false);
		expect(asksBeforeSignOut({ writes: true, out_today: 'leave', report: null })).toBe(false);
		expect(asksBeforeSignOut({ writes: false, out_today: null, report: null })).toBe(false);
		expect(asksBeforeSignOut(null)).toBe(false);
	});

	it('shows the reminder from a time of day', () => {
		expect(after(new Date(2026, 9, 13, 16, 59), '17:00')).toBe(false);
		expect(after(new Date(2026, 9, 13, 17, 0), '17:00')).toBe(true);
	});

	it('lists a month for the day bar', () => {
		const days = monthDays('2026-10');
		expect(days).toHaveLength(31);
		expect(days[0]).toEqual({ day: '2026-10-01', n: 1, letter: 'T' });
		expect(days[4].letter).toBe('M');
		expect(monthDays('2028-02')).toHaveLength(29);
		expect(shiftMonth('2026-01', -1)).toBe('2025-12');
		expect(shiftMonth('2026-12', 1)).toBe('2027-01');
	});

	it('counts the team: sent, late, not sent', () => {
		const c = teamCounts([{ state: 'sent' }, { state: 'late' }, { state: 'not_sent' }, { state: 'leave' }, { state: 'none' }]);
		expect(c).toEqual({ owed: 3, sent: 2, late: 1, missing: 1 });
	});
});
