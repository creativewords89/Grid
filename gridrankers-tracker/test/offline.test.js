import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/core/api.js';
import { createController } from '../src/core/controller.js';
import { createStore } from '../src/core/store.js';
import * as T from '../src/core/tracker.js';

const NOW = Date.parse('2026-10-29T09:00:00Z');
const min = (n) => n * 60000;
const base = () => T.signedIn(T.emptyState('https://p.example'), { member: { id: 'm1', name: 'Max' }, tasks: { projects: [], tasks: [] }, schedule: [] });
const none = { ref_kind: 'none', label: 'No task' };

describe('heartbeat and crash recovery', () => {
	it('asks after a gap, not after a short one', () => {
		const s = T.start(base(), none, NOW, 'A'.repeat(26));
		expect(T.checkCrash(s, NOW + min(1)).prompts.crash).toBeUndefined();
		expect(T.checkCrash(T.heartbeat(s, NOW + min(10)), NOW + min(11)).prompts.crash).toBeUndefined();
		expect(T.checkCrash(s, NOW + min(5)).prompts.crash).toEqual({ atMs: NOW });
	});

	it('Keep until: stops at the last heartbeat', () => {
		let s = T.heartbeat(T.start(base(), none, NOW, 'A'.repeat(26)), NOW + min(20));
		s = T.resolveCrash(T.checkCrash(s, NOW + min(90)), 'keep', NOW + min(90));
		expect(s.timer).toBeNull();
		expect(s.entries['A'.repeat(26)].ended_at).toBe('2026-10-29 09:20:00');
		expect(s.prompts.crash).toBeUndefined();
	});

	it('Discard: forgets it, or ends it at once when the portal has it', () => {
		let s = T.resolveCrash(T.checkCrash(T.start(base(), none, NOW, 'A'.repeat(26)), NOW + min(90)), 'discard', NOW + min(90));
		expect(s.entries).toEqual({});
		s = T.start(base(), none, NOW, 'B'.repeat(26));
		s = T.applyResults(s, [{ id: 'B'.repeat(26), status: 'saved', entry: {} }], T.pending(s));
		s = T.resolveCrash(T.checkCrash(s, NOW + min(90)), 'discard', NOW + min(90));
		expect(s.entries['B'.repeat(26)].ended_at).toBe('2026-10-29 09:00:01');
		expect(T.pending(s)).toHaveLength(1);
	});

	it('Keep running: carries on', () => {
		const s = T.resolveCrash(T.checkCrash(T.start(base(), none, NOW, 'A'.repeat(26)), NOW + min(90)), 'running', NOW + min(90));
		expect(T.running(s).id).toBe('A'.repeat(26));
		expect(s.timer.heartbeatMs).toBe(NOW + min(90));
	});

	it('waits 5 s, 15 s, 1 min, then 5 min between failed uploads', () => {
		expect([1, 2, 3, 4, 9].map(T.retryDelayMs)).toEqual([5000, 15000, 60000, 300000, 300000]);
	});
});

describe('controller offline', () => {
	function setup() {
		const portal = { online: true, batches: [] };
		const createApi = () => ({
			signIn: async () => ({ token: 't'.repeat(64), member: { id: 'm1', name: 'Max' }, tasks: { projects: [], tasks: [] }, schedule: [], timer: null }),
			signOut: async () => {},
			batch: async (entries) => {
				if (!portal.online) throw new ApiError(0, 'offline', 'offline');
				portal.batches.push(entries.length);
				return { results: entries.map((e) => ({ id: e.id, status: 'saved', entry: e })) };
			},
			timer: async () => {
				if (!portal.online) throw new ApiError(0, 'offline', 'offline');
				return { timer: null, now: new Date(clock).toISOString().slice(0, 19).replace('T', ' ') };
			},
			schedule: async () => ({ schedule: [] }),
			tasks: async () => ({ projects: [], tasks: [] }),
		});
		let clock = NOW;
		let token = null;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grt-'));
		const make = () => createController({ store: createStore(dir), loadToken: () => token, saveToken: (t) => (token = t), device: {}, createApi, now: () => clock });
		return { portal, make, tick: (ms) => (clock += ms) };
	}

	it('uploads hundreds of entries in batches of 200, then says "Synced N entries"', async () => {
		const { portal, make, tick } = setup();
		const ctl = make();
		await ctl.signIn('https://p.example', 'MAXCODE11');
		portal.online = false;
		for (let i = 0; i < 450; i++) {
			ctl.start(none);
			tick(1000);
		}
		ctl.stop();
		await ctl.sync();
		expect(ctl.view().waiting).toBe(450);
		expect(ctl.nextSyncMs()).toBeLessThanOrEqual(15000);

		portal.online = true;
		await ctl.sync();
		expect(portal.batches).toEqual([200, 200, 50]);
		expect(ctl.view().flash).toEqual({ n: 450, atMs: expect.any(Number) });
		expect(ctl.nextSyncMs()).toBe(60000);
	});

	it('asks about a timer left running when it starts again much later', async () => {
		const { make, tick } = setup();
		const ctl = make();
		await ctl.signIn('https://p.example', 'MAXCODE11');
		ctl.start(none);
		tick(30000);
		ctl.heartbeat();
		tick(3 * 3600000);

		const again = make();
		expect(again.view().prompts.crash.atMs).toBe(NOW + 30000);
		again.answer('crash', 'keep');
		expect(again.view().running).toBeNull();
		expect(again.view().prompts.crash).toBeUndefined();
	});
});
