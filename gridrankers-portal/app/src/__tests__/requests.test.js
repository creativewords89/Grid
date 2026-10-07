// Client requests (SPEC.md 6.15, designs DP-B and DP-G).
import { describe, expect, it } from 'vitest';
import { allReminders } from '../lib/cycleSetup.js';
import { bellItems, feedOf } from '../lib/feed.js';
import { canDeleteRequest, chaseReminders, openCount, openSummary, requestBell, requestsOf, threadOf, whenText } from '../lib/requests.js';
import { emptyData } from '../lib/store.js';

const TODAY = '2026-10-10';
const NOW = Date.parse('2026-10-10T12:00:00Z');
const ADA = { id: 'ada', name: 'Ada', role: 'admin', active: 1 };
const LEE = { id: 'lee', name: 'Lee', role: 'lead', active: 1 };
const MAX = { id: 'max', name: 'Max', role: 'member', active: 1 };
const NIA = { id: 'nia', name: 'Nia', role: 'member', active: 1 };

const req = (id, extra = {}) => ({ id, project_id: 'a', title: id, kind: 'images', details: '', status: 'needed', asked_at: null, asked_by: null, created_by: 'max', created_at: '2026-10-01 09:00:00', updated_at: '2026-10-01 09:00:00', ...extra });
const msg = (id, request, at, extra = {}) => ({ id, request_id: request, project_id: 'a', body: 'hi', files: [], from_client: 0, via: null, event: null, created_by: 'max', created_at: at, deleted_at: null, ...extra });

function data() {
	const d = emptyData();
	d.members = { ada: ADA, lee: LEE, max: MAX, nia: NIA };
	d.projects = { a: { id: 'a', name: 'Acme', state: 'active', cycle_day: 1 } };
	d.client_requests = {
		photos: req('photos', { title: 'New GBP images', status: 'received', updated_at: '2026-10-06 10:00:00' }),
		privacy: req('privacy', { title: 'Privacy Policy page', kind: 'page', status: 'asked', asked_at: '2026-10-06 08:00:00', asked_by: 'nia', created_by: 'nia', updated_at: '2026-10-06 08:00:00' }),
		hours: req('hours', { title: 'Holiday hours', kind: 'info', created_at: '2026-10-10 08:00:00', updated_at: '2026-10-10 08:00:00' }),
		old: req('old', { title: 'Logo', status: 'done', updated_at: '2026-10-09 08:00:00' }),
	};
	d.request_messages = {
		m1: msg('m1', 'photos', '2026-10-02 09:00:00', { event: 'asked', via: 'email', body: '', created_by: 'lee' }),
		m2: msg('m2', 'photos', '2026-10-06 09:00:00', { from_client: 1, created_by: 'lee', body: 'Here they are', files: [{ id: 'f1', name: 'a.jpg', mime: 'image/jpeg', size: 1 }, { id: 'f2', name: 'b.pdf', mime: 'application/pdf', size: 1 }] }),
		m3: msg('m3', 'photos', '2026-10-06 09:00:00', { event: 'received', body: '', created_by: 'lee' }),
		m4: msg('m4', 'photos', '2026-10-07 09:00:00', { created_by: 'max', body: 'Using job 1–3' }),
		m5: msg('m5', 'privacy', '2026-10-06 08:00:00', { event: 'asked', body: '', created_by: 'nia' }),
	};
	return d;
}

describe('the list', () => {
	it('shows open requests first, newest change first, with files and messages', () => {
		const rows = requestsOf(data(), 'a');
		expect(rows.map((r) => r.id)).toEqual(['hours', 'photos', 'privacy', 'old']);
		const photos = rows.find((r) => r.id === 'photos');
		expect(photos).toMatchObject({ files: 2, messages: 2, last: '2026-10-07 09:00:00' });
		expect(threadOf(data(), 'photos').map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
		expect(openCount(data(), 'a')).toBe(3);
	});

	it('says when, and sums up what is open for the Overview', () => {
		expect(whenText('2026-10-10 08:00:00', TODAY)).toBe('Today');
		expect(whenText('2026-10-09', TODAY)).toBe('Yesterday');
		expect(whenText('2026-10-06', TODAY)).toBe('4 days ago');
		expect(whenText('2026-09-02', TODAY)).toBe('Sep 2');
		expect(openSummary(data(), 'a', TODAY)).toEqual({ count: 3, text: 'Privacy Policy page asked 4 days ago · 1 received to check' });
		const d = data();
		d.client_requests = {};
		expect(openSummary(d, 'a', TODAY)).toBeNull();
	});

	it('lets whoever added it, or the Super Admin, delete a request', () => {
		const r = data().client_requests.privacy;
		expect(canDeleteRequest(NIA, r)).toBe(true);
		expect(canDeleteRequest(ADA, r)).toBe(true);
		expect(canDeleteRequest(LEE, r)).toBe(false);
		expect(canDeleteRequest(MAX, r)).toBe(false);
	});
});

describe('chase reminder', () => {
	it('comes 3 days after Asked client, for the asker and the Team Leaders, until the status changes', () => {
		const d = data();
		const titles = (who, today = TODAY) => chaseReminders(d, who, today).map((r) => r.title);
		expect(titles(NIA)).toEqual(['Acme: chase the client — “Privacy Policy page” asked 4 days ago']);
		expect(titles(LEE)).toHaveLength(1);
		expect(titles(MAX)).toEqual([]);
		expect(titles(ADA)).toEqual([]);
		expect(titles(NIA, '2026-10-08')).toEqual([], 'only 2 days');
		expect(chaseReminders(d, NIA, TODAY)[0]).toMatchObject({ key: 'chase:privacy:2026-10-10', kind: 'chase', ok: 'Open request', request: 'privacy' });
		// With the other "until it's done" reminders, on the bell too.
		expect(allReminders(d, NIA, TODAY).map((r) => r.kind)).toContain('chase');
		expect(bellItems(d, NIA, TODAY, NOW).find((i) => i.key === 'chase:privacy:2026-10-10')).toMatchObject({ sticky: true, unread: true });
		d.client_requests.privacy.status = 'received';
		expect(titles(NIA)).toEqual([]);
	});
});

describe('notifications', () => {
	it('go to the person who added it and everyone who wrote in it, never for your own', () => {
		const d = data();
		// Max added "New GBP images": Lee pasted what the client sent.
		expect(requestBell(d, MAX, NOW).map((i) => [i.key, i.text])).toEqual([['rq:m2', 'Acme: the client sent “New GBP images”']]);
		// Lee wrote in it: hears about Max's message, not his own or the status lines.
		expect(requestBell(d, LEE, NOW).map((i) => [i.key, i.text, i.sub])).toEqual([['rq:m4', 'Max wrote on “New GBP images”', 'Using job 1–3']]);
		// Nia isn't in it.
		expect(requestBell(d, NIA, NOW)).toEqual([]);
		// Marked done by someone else.
		d.request_messages.m6 = msg('m6', 'photos', '2026-10-09 09:00:00', { event: 'done', body: '', created_by: 'lee' });
		expect(requestBell(d, MAX, NOW).map((i) => i.text)).toContain('Lee marked “New GBP images” done');
		// Older than 7 days: gone.
		expect(requestBell(d, MAX, Date.parse('2026-10-20T12:00:00Z'))).toEqual([]);
	});

	it('are in the Notifications box and open the request on Details', () => {
		const item = feedOf(data(), MAX, TODAY, NOW).find((i) => i.key === 'rq:m2');
		expect(item).toMatchObject({ cat: 'message', tone: 'amber', open: { project_id: 'a', tab: 'details', request: 'photos' } });
		expect(bellItems(data(), MAX, TODAY, NOW).some((i) => i.key === 'rq:m2' && i.unread)).toBe(true);
	});
});
