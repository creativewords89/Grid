import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/core/api.js';
import { createController } from '../src/core/controller.js';
import * as S from '../src/core/shots.js';
import { createStore } from '../src/core/store.js';

const NOW = Date.parse('2026-10-29T09:00:00Z');
const min = (n) => n * 60000;
const running = (every, noticeOk = every) => ({ timer: { id: 'E1', startedMs: NOW }, entries: { E1: { id: 'E1', synced: 'running' } }, shots: { ...S.emptyShots(), every, noticeOk } });

describe('screenshot planner', () => {
	it('takes one at a random moment in each period while a timer runs', () => {
		let st = running(10);
		const half = () => 0.5;
		let r = S.due(st, NOW, half);
		expect(r.take).toBeNull();
		expect(r.state.shots.plan.atMs).toBe(NOW + min(5));
		st = r.state;
		r = S.due(st, NOW + min(5), half);
		expect(r.take.entryId).toBe('E1');
		expect(r.take.takenAt).toBe('2026-10-29 09:05:00');
		st = r.state;
		expect(S.due(st, NOW + min(8), half).take).toBeNull();
		// The next period.
		r = S.due(st, NOW + min(10), half);
		expect(r.state.shots.plan.atMs).toBe(NOW + min(15));
		expect(S.due(r.state, NOW + min(15), half).take).not.toBeNull();
	});

	it('takes none without a timer, when off, or before the person has been told', () => {
		expect(S.due({ ...running(10), timer: null }, NOW + min(20)).take).toBeNull();
		expect(S.due(running(0), NOW + min(20)).take).toBeNull();
		const untold = running(10, 0);
		expect(S.noticeDue(untold)).toBe(true);
		expect(S.due(untold, NOW + min(20)).take).toBeNull();
		expect(S.noticeDue(S.noticeOk(untold))).toBe(false);
		// A new interval is told again.
		expect(S.noticeDue(S.withEvery(S.noticeOk(untold), 5))).toBe(true);
	});

	it('starts a new period when the timer switches', () => {
		const st = S.due(running(10), NOW, () => 0.9).state;
		const switched = { ...st, timer: { id: 'E2', startedMs: NOW + min(3) }, entries: { ...st.entries, E2: { id: 'E2', synced: 'none' } } };
		const r = S.due(switched, NOW + min(3), () => 0);
		expect(r.take.entryId).toBe('E2');
	});

	it('keeps screenshots until the portal has them, and gives up after a few refusals', () => {
		let st = S.queued(running(10), { id: 'S1', entryId: 'E1', takenAt: 'x' }, '/tmp/S1.jpg');
		expect(S.ready(st).map((s) => s.id)).toEqual(['S1']);
		let r = S.answered(st, 'S1', 'refused');
		expect(r.remove).toBeNull();
		st = r.state;
		for (let i = 1; i < S.MAX_TRIES - 1; i++) st = S.answered(st, 'S1', 'refused').state;
		r = S.answered(st, 'S1', 'refused');
		expect(r.remove).toBe('/tmp/S1.jpg');
		expect(r.state.shots.queue).toEqual({});
		// Not before its entry is on the portal.
		const waiting = S.queued({ ...running(10), entries: { E1: { id: 'E1', synced: 'none' } } }, { id: 'S2', entryId: 'E1', takenAt: 'x' }, '/tmp/S2.jpg');
		expect(S.ready(waiting)).toEqual([]);
	});
});

describe('controller with screenshots', () => {
	function setup() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grt-'));
		const files = {};
		const portal = { online: true, shots: [], every: 10, refuse: null };
		let clock = NOW;
		const api = () => ({
			signIn: async () => ({ token: 't'.repeat(64), member: { id: 'm1', name: 'Max' }, work_day: null, schedule: [], tasks: { projects: [], tasks: [] }, timer: null, screenshots: portal.every }),
			batch: async (entries) => {
				if (!portal.online) throw new ApiError(0, 'offline', 'offline');
				return { results: entries.map((e) => ({ id: e.id, status: 'saved', entry: e })) };
			},
			timer: async () => ({ timer: null, now: new Date(clock).toISOString().slice(0, 19).replace('T', ' ') }),
			schedule: async () => ({ work_day: null, schedule: [], screenshots: portal.every }),
			tasks: async () => ({ projects: [], tasks: [] }),
			uploadShot: async (entryId, shot) => {
				if (!portal.online) throw new ApiError(0, 'offline', 'offline');
				if (portal.refuse) throw new ApiError(409, portal.refuse, 'no');
				portal.shots.push({ entryId, ...shot });
				return { status: 'saved' };
			},
		});
		let token = null;
		const ctl = createController({
			store: createStore(dir),
			loadToken: () => token,
			saveToken: (t) => (token = t),
			device: {},
			createApi: api,
			now: () => clock,
			readShot: (f) => files[f] || null,
			removeShot: (f) => delete files[f],
		});
		return { ctl, portal, files, tick: (ms) => (clock += ms) };
	}

	it('tells the person once, then takes, keeps offline and uploads screenshots', async () => {
		const { ctl, portal, files, tick } = setup();
		await ctl.signIn('https://p.example', 'MAXCODE11');
		expect(ctl.view().screenshots).toBe(10);
		expect(ctl.view().prompts.shots).toEqual({ every: 10 });
		ctl.start(ctl.view().choices[0]);
		tick(min(11));
		expect(ctl.shotDue()).toBeNull();
		ctl.answer('shots', 'ok');
		expect(ctl.view().prompts.shots).toBeUndefined();

		portal.online = false;
		let take = null;
		for (let i = 0; i < 40 && !take; i++) {
			tick(15000);
			take = ctl.shotDue();
		}
		expect(take).not.toBeNull();
		files['/shots/a.jpg'] = new Uint8Array([1, 2, 3]);
		ctl.addShot(take, '/shots/a.jpg');
		await ctl.sync();
		expect(ctl.view().shotsWaiting).toBe(1);
		expect(portal.shots).toEqual([]);

		portal.online = true;
		await ctl.sync();
		await ctl.sync();
		expect(portal.shots.map((s) => s.id)).toEqual([take.id]);
		expect(ctl.view().shotsWaiting).toBe(0);
		expect(files).toEqual({});
	});

	it('drops screenshots when the portal turns them off', async () => {
		const { ctl, portal, files, tick } = setup();
		await ctl.signIn('https://p.example', 'MAXCODE11');
		ctl.answer('shots', 'ok');
		ctl.start(ctl.view().choices[0]);
		const entryId = ctl.view().running.id;
		await ctl.sync();
		files['/shots/b.jpg'] = new Uint8Array([1]);
		ctl.addShot({ id: 'S9', entryId, takenAt: '2026-10-29 09:01:00' }, '/shots/b.jpg');
		portal.refuse = 'grp_screenshots_off';
		tick(1000);
		await ctl.sync();
		expect(ctl.view().shotsWaiting).toBe(0);
		expect(files).toEqual({});
	});
});
