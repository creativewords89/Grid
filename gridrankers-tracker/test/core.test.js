import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, cleanServer, createClient } from '../src/core/api.js';
import { fmtClock, fmtMinutes, fromUtc, toUtc } from '../src/core/clock.js';
import { ulid } from '../src/core/ids.js';
import { createStore } from '../src/core/store.js';
import * as T from '../src/core/tracker.js';

const NOW = Date.parse('2026-10-29T09:00:00Z');
const min = (n) => n * 60000;
const tasks = {
	projects: [{ id: 'p1', name: 'Acme Plumbing' }],
	tasks: [{ kind: 'item', id: 't1', title: 'Fix H1 tags', project_id: 'p1', project_name: 'Acme Plumbing', period_key: null }],
};
const signed = () => T.signedIn(T.emptyState('https://portal.example'), { member: { id: 'm1', name: 'Max' }, tasks, schedule: [], work_day: { start: '09:00', end: '17:00', minutes: 480 } });

describe('ids and clock', () => {
	it('makes 26-character time-ordered ids', () => {
		const a = ulid(NOW);
		const b = ulid(NOW + 1000);
		expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
	});

	it('round-trips UTC times and formats durations', () => {
		expect(toUtc(NOW)).toBe('2026-10-29 09:00:00');
		expect(fromUtc('2026-10-29 09:00:00')).toBe(NOW);
		expect(fmtClock(3909)).toBe('1:05:09');
		expect(fmtMinutes(90)).toBe('1h 30m');
	});
});

describe('api', () => {
	it('cleans the portal address', () => {
		expect(cleanServer('tracker.gridrankers.com/')).toBe('https://tracker.gridrankers.com');
		expect(cleanServer('')).toBe('https://tracker.gridrankers.com');
		expect(cleanServer('http://localhost:8090')).toBe('http://localhost:8090');
	});

	it('sends the device token as a bearer and no token on sign-in', async () => {
		const calls = [];
		const fetchImpl = async (url, init) => {
			calls.push({ url, init });
			return { ok: true, status: 200, text: async () => '{"ok":true}' };
		};
		const client = createClient({ server: 'https://p.example', getToken: () => 'abc', fetchImpl });
		await client.signIn('CODE1234', { device_name: 'Laptop' });
		await client.batch([{ id: 'x' }], 5);
		expect(calls[0].url).toBe('https://p.example/?rest_route=%2Fgr-portal%2Fv1%2Fauth%2Fdevice');
		expect(calls[0].init.headers.Authorization).toBeUndefined();
		expect(JSON.parse(calls[0].init.body)).toEqual({ code: 'CODE1234', device_name: 'Laptop' });
		expect(calls[1].init.headers.Authorization).toBe('Bearer abc');
		expect(JSON.parse(calls[1].init.body).clock_offset).toBe(5);
	});

	it('says so when the address has no tracker or isn’t a portal', async () => {
		const noRoute = createClient({ server: 'https://p.example', fetchImpl: async () => ({ ok: false, status: 404, text: async () => '{"code":"rest_no_route","message":"No route was found"}' }) });
		await expect(noRoute.signIn('CODE', {})).rejects.toMatchObject({ code: 'grp_no_tracker' });
		const html = createClient({ server: 'https://p.example', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<!doctype html><html></html>' }) });
		await expect(html.signIn('CODE', {})).rejects.toMatchObject({ code: 'grp_not_portal' });
	});

	it('tells offline from signed out', async () => {
		const offline = createClient({ server: 'https://p.example', fetchImpl: async () => Promise.reject(new Error('ENOTFOUND')) });
		await expect(offline.timer()).rejects.toMatchObject({ offline: true });
		const revoked = createClient({ server: 'https://p.example', fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"code":"grp_unauthorized","message":"Sign in again."}' }) });
		const err = await revoked.timer().catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.signedOut).toBe(true);
		expect(err.message).toBe('Sign in again.');
	});
});

describe('tracker state', () => {
	it('lists the tasks, No task and the projects', () => {
		expect(T.choices(signed()).map((c) => c.label)).toEqual(['Fix H1 tags', 'No task', 'Acme Plumbing']);
	});

	it('starts, switches and stops on this computer first', () => {
		const [task, none] = T.choices(signed());
		let s = T.start(signed(), task, NOW, 'A'.repeat(26));
		expect(T.running(s).label).toBe('Fix H1 tags');
		expect(T.running(s).ended_at).toBeNull();

		s = T.start(s, none, NOW + min(30), 'B'.repeat(26));
		expect(s.entries['A'.repeat(26)].ended_at).toBe('2026-10-29 09:30:00');
		expect(T.running(s).id).toBe('B'.repeat(26));
		expect(s.recent).toEqual(['none:', 'item:t1']);

		s = T.stop(s, NOW + min(45));
		expect(s.timer).toBeNull();
		expect(s.entries['B'.repeat(26)].ended_at).toBe('2026-10-29 09:45:00');
		expect(T.pending(s).map((e) => e.id)).toEqual(['A'.repeat(26), 'B'.repeat(26)]);
	});

	it('a stop right after a start still lasts a second', () => {
		let s = T.start(signed(), T.choices(signed())[0], NOW, 'C'.repeat(26));
		s = T.stop(s, NOW);
		expect(s.entries['C'.repeat(26)].ended_at).toBe('2026-10-29 09:00:01');
	});

	it('marks uploads from the answers: saved, already there, refused', () => {
		let s = T.start(signed(), T.choices(signed())[0], NOW, 'A'.repeat(26));
		s = T.start(s, T.choices(signed())[1], NOW + min(10), 'B'.repeat(26));
		s = T.stop(s, NOW + min(20));
		s = T.start(s, T.choices(signed())[1], NOW + min(30), 'C'.repeat(26));
		const sent = T.pending(s);
		s = T.applyResults(
			s,
			[
				{ id: 'A'.repeat(26), status: 'saved', entry: {} },
				{ id: 'B'.repeat(26), status: 'refused', code: 'grp_time_overlap', message: 'That time overlaps another entry of yours.' },
				{ id: 'C'.repeat(26), status: 'saved', entry: {} },
			],
			sent
		);
		expect(s.entries['A'.repeat(26)].synced).toBe('done');
		expect(T.attention(s).map((e) => e.error.code)).toEqual(['grp_time_overlap']);
		expect(s.entries['C'.repeat(26)].synced).toBe('running');
		expect(T.pending(s)).toEqual([]);

		s = T.stop(s, NOW + min(40));
		expect(T.pending(s).map((e) => e.id)).toEqual(['C'.repeat(26)]);
		s = T.dismiss(s, 'B'.repeat(26));
		expect(T.attention(s)).toEqual([]);
	});

	it('keeps the stop that happened while its running version was uploading', () => {
		let s = T.start(signed(), T.choices(signed())[0], NOW, 'A'.repeat(26));
		const sent = T.pending(s);
		s = T.stop(s, NOW + min(5));
		s = T.applyResults(s, [{ id: 'A'.repeat(26), status: 'saved', entry: { ended_at: null } }], sent);
		expect(s.entries['A'.repeat(26)].synced).toBe('running');
		expect(T.pending(s)[0].ended_at).toBe('2026-10-29 09:05:00');
	});

	it('follows the portal: a timer started there shows here; one stopped there stops here', () => {
		let s = T.adoptServerTimer(signed(), { id: 'W'.repeat(26), ref_kind: 'item', ref_id: 't1', started_at: '2026-10-29 08:00:00' }, NOW);
		expect(T.running(s).label).toBe('Fix H1 tags');
		expect(T.pending(s)).toEqual([]);
		s = T.adoptServerTimer(s, null, NOW + min(5));
		expect(s.timer).toBeNull();
	});

	it('a late answer from the portal never restarts a timer stopped here', () => {
		let s = T.adoptServerTimer(signed(), { id: 'W'.repeat(26), ref_kind: 'none', started_at: '2026-10-29 08:00:00' }, NOW);
		s = T.stop(s, NOW + min(1));
		s = T.adoptServerTimer(s, { id: 'W'.repeat(26), ref_kind: 'none', started_at: '2026-10-29 08:00:00' }, NOW + min(1));
		expect(s.timer).toBeNull();
		expect(T.pending(s).map((e) => e.id)).toEqual(['W'.repeat(26)]);
	});

	it('forgets uploaded entries after 14 days, never waiting ones', () => {
		let s = T.start(signed(), T.choices(signed())[0], NOW, 'A'.repeat(26));
		s = T.stop(s, NOW + min(5));
		s = T.start(s, T.choices(signed())[0], NOW + min(10), 'B'.repeat(26));
		s = T.stop(s, NOW + min(15));
		s = T.applyResults(s, [{ id: 'A'.repeat(26), status: 'saved', entry: {} }], T.pending(s));
		s = T.prune(s, NOW + 15 * 86400000);
		expect(Object.keys(s.entries)).toEqual(['B'.repeat(26)]);
	});
});

describe('store', () => {
	it('saves atomically and loads back', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grt-'));
		const store = createStore(dir);
		expect(store.load({ empty: true })).toEqual({ empty: true });
		store.save({ a: 1 });
		expect(store.load(null)).toEqual({ a: 1 });
		expect(fs.existsSync(store.file + '.tmp')).toBe(false);
		// A crash between writing and renaming leaves the new file as .tmp: it is still read.
		fs.renameSync(store.file, store.file + '.tmp');
		expect(store.load(null)).toEqual({ a: 1 });
	});
});
