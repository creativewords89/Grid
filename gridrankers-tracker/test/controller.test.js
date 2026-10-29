import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/core/api.js';
import { createController } from '../src/core/controller.js';
import { createStore } from '../src/core/store.js';

// A fake portal: remembers entries by id like the server (saved once, then "exists").
function fakePortal() {
	const portal = { online: true, revoked: false, entries: {}, running: null, calls: [] };
	portal.createApi = () => {
		const guard = (name) => {
			portal.calls.push(name);
			if (!portal.online) throw new ApiError(0, 'offline', 'offline');
			if (portal.revoked && name !== 'signIn') throw new ApiError(401, 'grp_unauthorized', 'Sign in again.');
		};
		return {
			signIn: async (code) => {
				guard('signIn');
				if (code !== 'MAXCODE11') throw new ApiError(401, 'grp_invalid_code', "That code doesn't match anyone.");
				portal.revoked = false;
				return { token: 't'.repeat(64), member: { id: 'm1', name: 'Max' }, work_day: { start: '09:00', end: '17:00', minutes: 480 }, schedule: [], tasks: { projects: [], tasks: [] }, timer: null };
			},
			signOut: async () => guard('signOut'),
			batch: async (entries) => {
				guard('batch');
				return {
					results: entries.map((e) => {
						const known = portal.entries[e.id];
						portal.entries[e.id] = { ...e };
						portal.running = e.ended_at ? (portal.running === e.id ? null : portal.running) : e.id;
						return { id: e.id, status: known && known.ended_at === e.ended_at ? 'exists' : 'saved', entry: e };
					}),
				};
			},
			timer: async () => (guard('timer'), { timer: portal.running ? portal.entries[portal.running] : null, now: new Date().toISOString().slice(0, 19).replace('T', ' ') }),
			schedule: async () => (guard('schedule'), { work_day: { start: '09:00', end: '17:00', minutes: 480 }, schedule: [] }),
			tasks: async () => (guard('tasks'), { projects: [], tasks: [] }),
		};
	};
	return portal;
}

function setup(portal, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grt-'))) {
	let token = null;
	let clock = Date.parse('2026-10-29T09:00:00Z');
	const ctl = createController({
		store: createStore(dir),
		loadToken: () => token,
		saveToken: (t) => (token = t),
		device: { device_name: 'Laptop', platform: 'linux', app_version: '1.0.0' },
		createApi: portal.createApi,
		now: () => clock,
	});
	return { ctl, dir, tick: (ms) => (clock += ms), token: () => token };
}

describe('controller', () => {
	it('signs in with the code and keeps the token', async () => {
		const portal = fakePortal();
		const { ctl, token } = setup(portal);
		await expect(ctl.signIn('https://p.example', 'NOPE')).rejects.toThrow("That code doesn't match anyone.");
		await ctl.signIn('https://p.example', 'MAXCODE11');
		expect(ctl.view().signedIn).toBe(true);
		expect(token()).toBe('t'.repeat(64));
	});

	it('never loses time offline and uploads it once when back', async () => {
		const portal = fakePortal();
		const { ctl, tick } = setup(portal);
		await ctl.signIn('https://p.example', 'MAXCODE11');
		portal.online = false;

		ctl.start(ctl.view().choices[0]);
		tick(30 * 60000);
		ctl.stop();
		await ctl.sync();
		expect(ctl.view().sync.online).toBe(false);
		expect(ctl.view().waiting).toBe(1);
		expect(Object.keys(portal.entries)).toHaveLength(0);

		portal.online = true;
		await ctl.sync();
		expect(Object.keys(portal.entries)).toHaveLength(1);
		expect(ctl.view().waiting).toBe(0);
		const before = portal.calls.length;
		await ctl.sync();
		expect(portal.calls.slice(before)).not.toContain('batch');
	});

	it('survives a restart: what is waiting is still there', async () => {
		const portal = fakePortal();
		const first = setup(portal);
		await first.ctl.signIn('https://p.example', 'MAXCODE11');
		portal.online = false;
		first.ctl.start(first.ctl.view().choices[0]);
		first.tick(60000);
		first.ctl.stop();

		const again = createController({ store: createStore(first.dir), loadToken: () => 't'.repeat(64), saveToken: () => {}, device: {}, createApi: portal.createApi });
		expect(again.view().waiting).toBe(1);
		portal.online = true;
		await again.sync();
		expect(Object.keys(portal.entries)).toHaveLength(1);
	});

	it('a revoked token signs out and keeps unsent time', async () => {
		const portal = fakePortal();
		const { ctl, tick } = setup(portal);
		await ctl.signIn('https://p.example', 'MAXCODE11');
		portal.revoked = true;
		ctl.start(ctl.view().choices[0]);
		tick(60000);
		await ctl.sync();
		expect(ctl.view().signedIn).toBe(false);
		expect(ctl.view().signedOut).toBe(true);
		expect(ctl.view().running).toBeNull();

		await ctl.signIn('https://p.example', 'MAXCODE11');
		await ctl.sync();
		expect(Object.values(portal.entries)[0].ended_at).not.toBeNull();
	});

	it('moves a signed-out app from the first build’s address to the tracker’s portal', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grt-'));
		createStore(dir).save({ server: 'https://portal.gridrankers.com' });
		const ctl = createController({ store: createStore(dir), loadToken: () => null, saveToken: () => {}, device: {}, createApi: fakePortal().createApi });
		expect(ctl.view().server).toBe('https://tracker.gridrankers.com');
	});
});
