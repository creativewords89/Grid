// The desktop app (SPEC.md 6.21): sign in with the code, start a timer on No task, stop it, sign out.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.env.TRACKER_LIVE_URL;
const code = process.env.TRACKER_LIVE_CODE;

test.skip(!url || !code, 'needs TRACKER_LIVE_URL and TRACKER_LIVE_CODE');

test('sign in, start and stop the timer, sign out', async () => {
	const app = await electron.launch({
		args: [...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), '.'],
		cwd: path.resolve(import.meta.dirname, '..'),
		env: { ...process.env, GRT_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'grt-e2e-')) },
	});
	const win = await app.firstWindow();

	await expect(win.getByRole('heading', { name: 'GridRankers Tracker' })).toBeVisible();
	await win.getByRole('button', { name: 'Another portal address?' }).click();
	await win.getByLabel('Portal address').fill(url);
	await win.getByLabel('Your code').fill('WRONG123');
	await win.getByRole('button', { name: 'Sign in' }).click();
	await expect(win.getByRole('alert')).toHaveText("That code doesn't match anyone.");
	await win.getByLabel('Your code').fill(code);
	await win.getByRole('button', { name: 'Sign in' }).click();

	await expect(win.getByRole('status')).toContainText('Online');
	const stop = win.getByRole('button', { name: 'Stop', exact: true });
	if (await stop.isVisible()) await stop.click();
	await win.getByRole('button', { name: /^No task/ }).click();
	await expect(win.getByLabel('Timer running')).toHaveText(/^0:0\d$/);
	await win.waitForTimeout(1500);
	await stop.click();
	await expect(win.getByText('No timer running.', { exact: false })).toBeVisible();
	await expect(win.getByRole('status')).toHaveText('Online');

	await win.getByRole('button', { name: 'Sign out' }).click();
	await expect(win.getByLabel('Your code')).toBeVisible();
	await app.close();
});
