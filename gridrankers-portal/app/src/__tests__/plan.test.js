import { describe, expect, it } from 'vitest';
import { approvals } from '../lib/day.js';
import { DEFAULT_COLUMNS, askOf, columnsOf, deadlineFor, doneOf, groupOf, isLate, isWebUrl, keywordsOf, linkKind, sectionsOf, splitKeywords, untickRequests } from '../lib/plan.js';
import { emptyData } from '../lib/store.js';

// Cycles start on day 5: Oct 5 – Nov 4, then Nov 5 – Dec 4.
const P = { id: 'p', name: 'Acme', state: 'active', cycle_day: 5, cycle_set: 1, created_at: '2026-01-01 00:00:00' };
const TODAY = '2026-10-14';

describe('Details (SPEC.md 6.12)', () => {
	it('tells the link kind from the address', () => {
		expect(linkKind('https://docs.google.com/spreadsheets/d/1/edit#gid=0')).toBe('sheet');
		expect(linkKind('https://docs.google.com/document/d/1/edit')).toBe('doc');
		expect(linkKind('https://drive.google.com/drive/folders/1')).toBe('drive');
		expect(linkKind('https://acme.com/wp-admin')).toBe('other');
		expect(linkKind('not a link')).toBe('other');
	});
	it('only keeps web links', () => {
		expect(isWebUrl('https://acme.com')).toBe(true);
		expect(isWebUrl('javascript:alert(1)')).toBe(false);
		expect(isWebUrl('acme.com')).toBe(false);
	});
	it('has no sections until someone adds one', () => {
		expect(sectionsOf(P)).toEqual([]);
		expect(sectionsOf({ ...P, details: { sections: [{ id: 'a', title: 'About', text: '', links: [] }] } })).toHaveLength(1);
	});
});

describe('Keyword checklist (SPEC.md 6.12)', () => {
	const cols = DEFAULT_COLUMNS;
	it('uses the default columns until the project sets its own', () => {
		expect(columnsOf(P).map((c) => c.name)).toEqual(['On-page', 'Content', 'Internal links', 'Backlinks']);
		expect(columnsOf({ ...P, kw_columns: [{ id: 'x', name: 'GBP' }] })).toEqual([{ id: 'x', name: 'GBP' }]);
	});
	it('groups by deadline: this cycle, next cycle, later', () => {
		expect(groupOf({ deadline: '2026-11-04' }, P, TODAY)).toBe('this');
		expect(groupOf({ deadline: '2026-10-01' }, P, TODAY)).toBe('this');
		expect(groupOf({ deadline: '2026-11-05' }, P, TODAY)).toBe('next');
		expect(groupOf({ deadline: '2026-12-04' }, P, TODAY)).toBe('next');
		expect(groupOf({ deadline: '2026-12-05' }, P, TODAY)).toBe('later');
		expect(groupOf({ deadline: null }, P, TODAY)).toBe('later');
	});
	it('a drop sets the deadline to the end of that cycle', () => {
		expect(deadlineFor('this', P, TODAY)).toBe('2026-11-04');
		expect(deadlineFor('next', P, TODAY)).toBe('2026-12-04');
		expect(deadlineFor('later', P, TODAY)).toBe('');
	});
	it('counts ticks of the current columns and flags late keywords', () => {
		const kw = { deadline: '2026-10-12', checks: { c1: { by: 'm' }, c2: { by: 'm' }, gone: { by: 'm' } } };
		expect(doneOf(kw, cols)).toBe(2);
		expect(isLate(kw, cols, TODAY)).toBe(true);
		expect(isLate({ ...kw, checks: { c1: 1, c2: 1, c3: 1, c4: 1 } }, cols, TODAY)).toBe(false);
		expect(isLate({ ...kw, deadline: TODAY }, cols, TODAY)).toBe(false);
		expect(isLate({ ...kw, deadline: null }, cols, TODAY)).toBe(false);
	});
	it('lists a project’s keywords in order and splits pasted lists', () => {
		const d = emptyData();
		d.keywords = { a: { id: 'a', project_id: 'p', keyword: 'b', position: 2 }, b: { id: 'b', project_id: 'p', keyword: 'a', position: 1 }, c: { id: 'c', project_id: 'q', keyword: 'c', position: 0 } };
		expect(keywordsOf(d, 'p').map((k) => k.id)).toEqual(['b', 'a']);
		expect(splitKeywords('one\r\n two \n\n three\tfour, five')).toEqual(['one', 'two', 'three', 'four', 'five']);
	});

	it('requests to untick reach Team Leaders and the Super Admin only', () => {
		const d = emptyData();
		d.members = { max: { id: 'max', name: 'Max', role: 'member', active: 1 }, lee: { id: 'lee', name: 'Lee', role: 'lead', active: 1 } };
		d.projects = { p: P };
		d.keywords = { k: { id: 'k', project_id: 'p', keyword: 'kw', checks: { c1: { by: 'max', at: '2026-10-10 10:00:00', ask: { by: 'max', at: '2026-10-11 10:00:00', note: 'oops' } }, c2: { by: 'max' } } } };
		expect(askOf(d.keywords.k, { id: 'c1' }).note).toBe('oops');
		expect(askOf(d.keywords.k, { id: 'c2' })).toBeNull();
		expect(untickRequests(d).map((r) => [r.id, r.col.name, r.who.name])).toEqual([['k:c1', 'On-page', 'Max']]);
		expect(approvals(d, d.members.lee).filter((i) => i.kind === 'untick')).toHaveLength(1);
		expect(approvals(d, d.members.max).filter((i) => i.kind === 'untick')).toHaveLength(0);
	});
});
