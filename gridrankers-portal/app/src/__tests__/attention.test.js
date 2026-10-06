import { describe, expect, it } from 'vitest';
import { attentionOf, healthOf, teamOf } from '../lib/attention.js';
import { emptyData } from '../lib/store.js';

const TODAY = '2026-10-20';

function fixture() {
	const d = emptyData();
	d.members = { max: { id: 'max', name: 'Max', role: 'member', active: 1 }, nia: { id: 'nia', name: 'Nia', role: 'member', active: 1 }, old: { id: 'old', name: 'Old', role: 'member', active: 0 } };
	d.projects = { p: { id: 'p', name: 'Acme', state: 'active', cycle_day: 1, cycle_set: 1, created_at: '2026-10-01 09:00:00' } };
	d.meeting_tasks = {
		late: { id: 'late', project_id: 'p', title: 'Fix H1', status: 'todo', priority: 'normal', assignees: [{ id: 'max' }], deadline: { type: 'date', date: '2026-10-17' } },
		later: { id: 'later', project_id: 'p', title: 'Very late', status: 'doing', priority: 'normal', assignees: [{ id: 'old' }], deadline: { type: 'date', date: '2026-10-10' } },
		urgent: { id: 'urgent', project_id: 'p', title: 'Hot fix', status: 'todo', priority: 'urgent', assignees: [{ id: 'nia' }] },
		done: { id: 'done', project_id: 'p', title: 'Done one', status: 'done', priority: 'urgent', assignees: [{ id: 'nia' }], deadline: { type: 'date', date: '2026-10-01' } },
	};
	d.monthly_tasks = { m1: { id: 'm1', project_id: 'p', title: 'Citations', freq: 'monthly', due_mode: 'none', target: 1, assignees: [], created_at: '2026-10-01 09:00:00' } };
	return d;
}

describe('Projects tab: needs attention (design PJ-A4)', () => {
	it('lists what needs attention, most urgent first, with why', () => {
		const d = fixture();
		const reviews = [{ id: 'r1', project_id: 'p', title: 'GBP post', tab: 'monthly' }, { id: 'r2', project_id: 'q', title: 'Elsewhere', tab: 'board' }];
		const items = attentionOf(d.projects.p, d, reviews, TODAY, { done: false, late: 2, due: '2026-10-03' });
		expect(items.map((i) => [i.title, i.why, i.tone])).toEqual([
			['New cycle setup', '2 days overdue', 'red'],
			['Very late', 'overdue 10 days', 'red'],
			['Fix H1', 'overdue 3 days', 'red'],
			['Citations', 'nobody assigned', 'amber'],
			['Hot fix', 'urgent', 'amber'],
			['GBP post', 'to review', 'purple'],
		]);
		expect(items[1].open).toEqual({ tab: 'board', title: 'Very late' });
		expect(healthOf(items)).toBe('red');
	});

	it('is amber with only things to look at, green with nothing', () => {
		const d = fixture();
		delete d.meeting_tasks.late;
		delete d.meeting_tasks.later;
		const amber = attentionOf(d.projects.p, d, [], TODAY, { done: false, late: 0, due: '2026-10-22' });
		expect(amber[0]).toMatchObject({ title: 'New cycle setup', tone: 'amber' });
		expect(healthOf(amber)).toBe('amber');
		d.meeting_tasks = {};
		d.monthly_tasks.m1.assignees = [{ id: 'max' }];
		expect(attentionOf(d.projects.p, d, [], TODAY, { done: true })).toEqual([]);
		expect(healthOf([])).toBe('green');
	});

	it('paused projects are not asked to assign monthly tasks', () => {
		const d = fixture();
		d.projects.p.state = 'paused';
		expect(attentionOf(d.projects.p, d, [], TODAY).some((i) => i.why === 'nobody assigned')).toBe(false);
	});

	it('the team: active people on its monthly tasks and open meeting tasks', () => {
		expect(teamOf(fixture().projects.p, fixture()).map((m) => m.id)).toEqual(['max', 'nia']);
	});
});
