// Hand-ins per step (SPEC.md 6.16, design SH-2B).
import { describe, expect, it } from 'vitest';
import { asksHandin, canHandIn, cleanLink, cleanSteps, handinBody, handinCount, linkName, missingHandins, stepRows, stepsError } from '../lib/steps.js';

const MAX = { id: 'max', name: 'Max Member', role: 'member' };
const NIA = { id: 'nia', name: 'Nia Member', role: 'member' };
const LEE = { id: 'lee', name: 'Lee Lead', role: 'lead' };
const ITEMS = [
	{ id: 'draft', label: 'Article draft', kind: 'file', required: true },
	{ id: 'doc', label: 'Google Doc link', kind: 'link', required: true },
	{ id: 'cover', label: 'Cover image ideas', kind: 'image', required: false },
];
const WRITE = { id: 'w', name: 'Write', member: 'max', handin: ITEMS };
const EDIT = { id: 'e', name: 'Edit', member: 'nia' };
const FILE = { id: 'f1', mime: 'application/pdf', name: 'draft.pdf', size: 10 };

describe('the checklist in the task dialog', () => {
	it('keeps named items and drops blank ones', () => {
		const rows = [{ ...WRITE, handin: [...ITEMS, { id: 'x', label: '  ', kind: 'file', required: true }] }, EDIT];
		const out = cleanSteps(rows);
		expect(out[0].handin.map((it) => it.id)).toEqual(['draft', 'doc', 'cover']);
		expect(out[0].handin[2]).toEqual({ id: 'cover', label: 'Cover image ideas', kind: 'image', required: false });
		expect(out[1].handin).toBeUndefined();
	});

	it('allows 10 items and refuses 11', () => {
		const many = (n) => Array.from({ length: n }, (_, i) => ({ id: 'h' + i, label: 'File ' + i, kind: 'file', required: false }));
		expect(stepsError([{ ...WRITE, handin: many(10) }, EDIT])).toBe('');
		expect(stepsError([{ ...WRITE, handin: many(11) }, EDIT])).toBe('“Write”: A step can ask for at most 10 things to hand in.');
	});
});

describe('the Hand in window', () => {
	it('counts what is in and the required items left', () => {
		expect(handinCount(WRITE, null)).toMatchObject({ got: 0, total: 3, left: 2, text: '0 of 3 · 2 required left' });
		const handins = { w: { draft: { files: [FILE], links: [] }, cover: { files: [], links: [{ url: 'https://pinterest.com/x' }] } } };
		expect(handinCount(WRITE, handins).text).toBe('2 of 3 · 1 required left');
		expect(missingHandins(WRITE, handins).map((it) => it.id)).toEqual(['doc']);
		handins.w.doc = { links: [{ url: 'https://docs.google.com/document/d/1' }] };
		expect(handinCount(WRITE, handins).text).toBe('3 of 3');
	});

	it('opens when the step is completed, or on the +1 that completes it', () => {
		const [row] = stepRows({ target: 2, steps: [WRITE, EDIT] }, { w: { n: 1 } });
		expect(asksHandin(row, 'done')).toBe(true);
		expect(asksHandin(row, 'doing')).toBe(false);
		expect(asksHandin(row, 1)).toBe(true);
		const [first] = stepRows({ target: 2, steps: [WRITE, EDIT] }, null);
		expect(asksHandin(first, 1)).toBe(false);
		expect(asksHandin(stepRows({ target: 1, steps: [EDIT, WRITE] }, null)[0], 'done')).toBe(false);
	});

	it('sends file ids and links', () => {
		expect(handinBody({ draft: { files: [FILE], links: [] }, doc: { files: [], links: [{ url: 'https://figma.com/file/a', name: 'Figma' }] } })).toEqual({
			draft: { files: ['f1'], links: [] },
			doc: { files: [], links: [{ url: 'https://figma.com/file/a', name: 'Figma' }] },
		});
	});

	it('names pasted links and refuses ones that are not http(s)', () => {
		expect(linkName('https://www.figma.com/file/abc/BMW-hero')).toBe('Figma');
		expect(linkName('https://docs.google.com/document/d/1')).toBe('Google Doc');
		expect(linkName('https://docs.google.com/spreadsheets/d/1')).toBe('Google Sheet');
		expect(linkName('https://drive.google.com/drive/folders/1')).toBe('Google Drive');
		expect(linkName('https://example.com/a')).toBe('example.com');
		expect(cleanLink('figma.com/file/a')).toBe('https://figma.com/file/a');
		expect(cleanLink('javascript:alert(1)')).toBe('');
		expect(cleanLink('not a link')).toBe('');
	});
});

describe('who may hand in', () => {
	const [write] = stepRows({ target: 1, steps: [WRITE, EDIT] }, null);
	it('is the step’s person or a leader, never on completed work', () => {
		expect(canHandIn(MAX, write, 'doing')).toBe(true);
		expect(canHandIn(NIA, write, 'doing')).toBe(false);
		expect(canHandIn(LEE, write, 'doing')).toBe(true);
		expect(canHandIn(LEE, write, 'done')).toBe(false);
		expect(canHandIn(NIA, stepRows({ target: 1, steps: [WRITE, EDIT] }, null)[1], 'doing')).toBe(false);
	});
});
