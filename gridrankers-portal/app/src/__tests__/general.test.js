import { describe, expect, it } from 'vitest';
import { generalTasks } from '../components/general/GeneralTasks.jsx';
import { myProjects } from '../lib/day.js';
import { feedOf } from '../lib/feed.js';
import { pendingReviews } from '../lib/reviews.js';
import { emptyData } from '../lib/store.js';
import { GENERAL, boardOf, homeName, isGeneral, liveTask } from '../lib/tasks.js';

const TODAY = '2026-10-06';
const NOW = Date.parse('2026-10-06T12:00:00Z');
const MAX = { id: 'max', name: 'Max', role: 'member', active: 1 };
const LEE = { id: 'lee', name: 'Lee', role: 'lead', active: 1 };

function fixture() {
	const d = emptyData();
	d.members = { max: MAX, lee: LEE };
	d.projects = { p: { id: 'p', name: 'Acme', state: 'active', cycle_day: 1, cycle_set: 1 } };
	const t = (id, title, extra) => ({ id, title, status: 'todo', priority: 'normal', target: 1, assignees: [{ id: 'max', n: 1 }], created_by: 'lee', created_at: '2026-10-06 09:00:00', ...extra });
	d.meeting_tasks = {
		g1: t('g1', 'Renew domain', { project_id: GENERAL, priority: 'urgent' }),
		g2: t('g2', 'Team photo', { project_id: GENERAL, status: 'done', done_at: '2026-10-05 10:00:00' }),
		p1: t('p1', 'Fix H1', { project_id: 'p' }),
		gone: t('gone', 'Old', { project_id: 'deleted' }),
	};
	return d;
}

describe('General tasks (SPEC.md 6.13)', () => {
	it('knows a General task from a project task', () => {
		const d = fixture();
		expect(isGeneral(d.meeting_tasks.g1)).toBe(true);
		expect(isGeneral(d.meeting_tasks.p1)).toBe(false);
		expect([liveTask(d, d.meeting_tasks.g1), liveTask(d, d.meeting_tasks.p1), liveTask(d, d.meeting_tasks.gone)]).toEqual([true, true, false]);
		expect([homeName(d, d.meeting_tasks.g1), homeName(d, d.meeting_tasks.p1)]).toEqual(['General tasks', 'Acme']);
		expect([boardOf(d.meeting_tasks.g1), boardOf(d.meeting_tasks.p1)]).toEqual(['general', 'board']);
	});

	it('the board lists General tasks only, open (most urgent) first', () => {
		expect(generalTasks(fixture()).map((t) => t.id)).toEqual(['g1', 'g2']);
	});

	it('My day shows them as their own group', () => {
		const groups = myProjects(fixture(), MAX, TODAY);
		const general = groups.find((g) => g.project.general);
		expect(general.project.name).toBe('General tasks');
		expect(general.tasks.map((t) => t.title)).toEqual(['Renew domain']);
		expect(groups.find((g) => g.project.id === 'p').tasks.map((t) => t.title)).toEqual(['Fix H1']);
	});

	it('new ones and reviews reach people, and open the General board', () => {
		const d = fixture();
		const item = feedOf(d, MAX, TODAY, NOW).find((f) => f.key === 'new:g1');
		expect(item).toMatchObject({ title: 'New general task: “Renew domain”', open: { project_id: '', tab: 'general' } });
		d.meeting_tasks.g1.review = { state: 'pending', submittedBy: 'max', submittedAt: '2026-10-06 10:00:00' };
		expect(pendingReviews(d).map((r) => [r.id, r.tab, r.where])).toEqual([['g1', 'general', 'General task']]);
	});
});
