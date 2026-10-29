// Against a real portal (the plugin's e2e WordPress site): sign in with a code, track offline, upload,
// and see the portal's answers. Runs only with TRACKER_LIVE_URL and TRACKER_LIVE_CODE set, e.g.
//   TRACKER_LIVE_URL=http://127.0.0.1:8090 TRACKER_LIVE_CODE=MAXCODE11 npx vitest run test/live.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClient } from '../src/core/api.js';
import { createController } from '../src/core/controller.js';
import { createStore } from '../src/core/store.js';

const url = process.env.TRACKER_LIVE_URL;
const code = process.env.TRACKER_LIVE_CODE;

describe.skipIf(!url || !code)('live portal', () => {
	it('signs in, tracks offline, uploads once and follows the portal', async () => {
		let token = null;
		let online = true;
		const createApi = (opts) =>
			createClient({
				...opts,
				fetchImpl: (u, init) => (online ? fetch(u, init) : Promise.reject(new Error('offline'))),
			});
		const ctl = createController({
			store: createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'grt-live-'))),
			loadToken: () => token,
			saveToken: (t) => (token = t),
			device: { device_name: 'Live test', platform: process.platform, app_version: 'test' },
			createApi,
		});

		await expect(ctl.signIn(url, 'NOT-A-CODE')).rejects.toThrow("That code doesn't match anyone.");
		await ctl.signIn(url, code);
		const v = ctl.view();
		expect(v.signedIn).toBe(true);
		expect(v.workDay.minutes).toBeGreaterThan(0);
		expect(v.choices.some((c) => c.label === 'No task')).toBe(true);
		if (v.running) ctl.stop();
		await ctl.sync();

		// Offline: start and stop on this computer only.
		online = false;
		ctl.start(v.choices.find((c) => c.label === 'No task'));
		await new Promise((r) => setTimeout(r, 2100));
		ctl.stop();
		await ctl.sync();
		expect(ctl.view().sync.online).toBe(false);
		expect(ctl.view().waiting).toBe(1);

		// Back online: uploaded, and the portal has it.
		online = true;
		await ctl.sync();
		expect(ctl.view().waiting).toBe(0);
		expect(ctl.view().attention).toEqual([]);
		const client = createClient({ server: url, getToken: () => token });
		const today = await client.timer();
		expect(today.timer).toBeNull();

		// A timer started here is running on the portal; stopped from "another place", it stops here.
		ctl.start(v.choices.find((c) => c.label === 'No task'));
		await ctl.sync();
		expect((await client.timer()).timer.id).toBe(ctl.view().running.id);

		const old = token;
		await ctl.signOut();
		expect(ctl.view().signedIn).toBe(false);
		expect(ctl.view().waiting).toBe(0);
		await expect(createClient({ server: url, getToken: () => old }).timer()).rejects.toMatchObject({ signedOut: true });
	});
});
