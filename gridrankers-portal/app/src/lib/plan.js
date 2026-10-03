// A project's Details tab and keyword checklist (SPEC.md 6.12). The server checks again.
import { cycleRange } from './cycles.js';
import { rowsOf } from './store.js';

// Same as GRP_REST_Plan::DEFAULT_COLUMNS.
export const DEFAULT_COLUMNS = [
	{ id: 'c1', name: 'On-page' },
	{ id: 'c2', name: 'Content' },
	{ id: 'c3', name: 'Internal links' },
	{ id: 'c4', name: 'Backlinks' },
];

export const columnsOf = (project) => (project && Array.isArray(project.kw_columns) && project.kw_columns.length ? project.kw_columns : DEFAULT_COLUMNS);

export const sectionsOf = (project) => (project && project.details && Array.isArray(project.details.sections) ? project.details.sections : []);

// Same as GRP_REST_Plan::link_kind(): Google Sheets, Docs, Drive, or other.
export function linkKind(url) {
	let u;
	try {
		u = new URL(String(url || '').trim());
	} catch (e) {
		return 'other';
	}
	const host = u.hostname.toLowerCase();
	if (host === 'docs.google.com' && u.pathname.startsWith('/spreadsheets')) return 'sheet';
	if (host === 'docs.google.com' && u.pathname.startsWith('/document')) return 'doc';
	if (host === 'drive.google.com') return 'drive';
	return 'other';
}

// Only http(s) links are kept (the server refuses the rest).
export const isWebUrl = (url) => /^https?:\/\/[^/\s]+/i.test(String(url || '').trim());

export const LINK_LABEL = { sheet: 'Google Sheet', doc: 'Google Doc', drive: 'Google Drive folder', other: 'Link' };

export const keywordsOf = (data, projectId) =>
	rowsOf(data, 'keywords')
		.filter((k) => k.project_id === projectId)
		.sort((a, b) => (a.position || 0) - (b.position || 0) || String(a.created_at).localeCompare(String(b.created_at)));

// Ticked columns of a keyword (only the project's current columns count).
export const doneOf = (kw, columns) => columns.filter((c) => kw.checks && kw.checks[c.id]).length;

// This cycle (deadline up to its end), Next cycle (up to the next one's end), or Later (no
// deadline, or further away).
export function groupOf(kw, project, today) {
	if (!kw.deadline) return 'later';
	const cur = cycleRange(project, 0, today);
	const next = cycleRange(project, 1, today);
	if (cur && kw.deadline <= cur.end) return 'this';
	if (next && kw.deadline <= next.end) return 'next';
	return 'later';
}

// The deadline a keyword gets when dropped into a group: the end of that cycle, or none.
export function deadlineFor(group, project, today) {
	if (group === 'this') return cycleRange(project, 0, today).end;
	if (group === 'next') return cycleRange(project, 1, today).end;
	return '';
}

// Late: the deadline has passed and not every box is ticked.
export const isLate = (kw, columns, today) => !!kw.deadline && kw.deadline < today && doneOf(kw, columns) < columns.length;

// Several keywords pasted at once: one per line (or comma / tab separated), blanks dropped.
export const splitKeywords = (text) =>
	String(text || '')
		.split(/[\n\r\t,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
