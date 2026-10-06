// Submission files, editing and comments (SPEC.md 6.6, designs SF-A / SF-B).
import { describe, expect, it } from 'vitest';
import { bellItems } from '../lib/feed.js';
import { canComment, canEditSubmission, commentBell, commentsOf } from '../lib/comments.js';
import { fileBadge, fileSize, linksOf } from '../lib/files.js';
import { emptyData } from '../lib/store.js';
import { submission } from '../components/meeting/useTaskActions.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const max = { id: 'max', name: 'Max', role: 'member', active: 1 };
const sam = { id: 'sam', name: 'Sam', role: 'member', active: 1 };
const lee = { id: 'lee', name: 'Lee', role: 'lead', active: 1 };

function data() {
	const d = emptyData();
	d.members = { max, sam, lee };
	d.projects = { p: { id: 'p', name: 'Acme', state: 'active' } };
	d.meeting_tasks = {
		t: { id: 't', project_id: 'p', title: 'Add citations', status: 'done', assignees: [{ id: 'max' }], completion: { note: 'Ten added', by: 'max', at: '2026-10-12T09:00:00Z' }, review: { state: 'pending', submittedBy: 'max' } },
	};
	d.comments = {
		c1: { id: 'c1', ref_kind: 'item', ref_id: 't', body: 'Add the Yelp screenshot', created_by: 'lee', created_at: '2026-10-12 10:00:00' },
		c0: { id: 'c0', ref_kind: 'item', ref_id: 't', body: 'Done', created_by: 'max', created_at: '2026-10-12 09:30:00' },
		old: { id: 'old', ref_kind: 'item', ref_id: 't', body: 'Old', created_by: 'lee', created_at: '2026-09-01 10:00:00' },
		gone: { id: 'gone', ref_kind: 'item', ref_id: 't', body: '', created_by: 'lee', created_at: '2026-10-12 11:00:00', deleted_at: '2026-10-12 11:05:00' },
	};
	return d;
}

describe('submission files', () => {
	it('sizes, badges and links', () => {
		expect(fileSize(512)).toBe('512 B');
		expect(fileSize(42 * 1024)).toBe('42 KB');
		expect(fileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
		expect(fileBadge({ name: 'citations.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toEqual({ label: 'XLSX', tone: 'xls' });
		expect(fileBadge({ name: 'yelp.png', mime: 'image/png' }).tone).toBe('img');
		expect(linksOf({ link: 'https://a.example' })).toEqual(['https://a.example']);
		expect(linksOf({ links: ['https://a.example', 'https://b.example'], link: 'https://a.example' })).toHaveLength(2);
		expect(linksOf(null)).toEqual([]);
	});

	it('sends only the fields the server takes', () => {
		expect(submission({ note: 'Done', links: [], files: ['f1'], fileMeta: [{ id: 'f1' }], comment: '' })).toEqual({ note: 'Done', links: [], files: ['f1'], comment: '' });
		expect(submission({ note: 'Done', links: [], files: [], comment: '', reviewer: 'sam' }).reviewer).toBe('sam');
	});
});

describe('editing and comments', () => {
	it('who may edit a submission', () => {
		const c = { by: 'max' };
		expect(canEditSubmission(max, c)).toBe(true);
		expect(canEditSubmission(sam, c)).toBe(false);
		expect(canEditSubmission(lee, c)).toBe(true);
		expect(canEditSubmission(max, null)).toBe(false);
	});

	it('who may comment', () => {
		const d = data();
		const t = d.meeting_tasks.t;
		expect(canComment(max, t, t)).toBe(true);
		expect(canComment(sam, t, t)).toBe(false);
		expect(canComment(lee, t, t)).toBe(true);
		expect(canComment(sam, t, { ...t, review: { state: 'pending', reviewer: 'sam' } })).toBe(true);
	});

	it('comments in order, and the bell for the people on the task', () => {
		const d = data();
		expect(commentsOf(d, 'item', 't').map((c) => c.id)).toEqual(['old', 'c0', 'c1', 'gone']);
		expect(commentBell(d, max, NOW).map((b) => b.text)).toEqual(['Lee commented on “Add citations”']);
		expect(commentBell(d, sam, NOW)).toEqual([]);
		expect(commentBell(d, lee, NOW).map((b) => b.key)).toEqual(['cm:c0'], 'Lee commented there');
		expect(bellItems(d, max, '2026-10-12', NOW).some((b) => b.key === 'cm:c1')).toBe(true);
	});
});
