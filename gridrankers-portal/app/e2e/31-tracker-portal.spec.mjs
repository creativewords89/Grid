// The tracker portal and the main portal (SPEC.md 6.22, step 107): the Super Admin sets this site
// to Tracker portal and sees Hours with what isn't on the main portal yet, a person's Time with the
// mark, and no other screens; a code sign-in asks the main portal; set to Main portal and linked,
// Max's own time says where it is tracked.
import { test, expect } from '@playwright/test';
import { MAX, apiCall, signIn, signOut, watchErrors } from './helpers.mjs';

const utc = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
// A main portal nobody answers at (connection refused), so the test never leaves this computer.
const MAIN = 'http://127.0.0.1:9';

async function ownerToSettings(page) {
	await page.goto('/wp-login.php');
	await page.waitForLoadState('load');
	await page.waitForTimeout(400);
	await page.locator('#user_login').fill('owner');
	await page.locator('#user_pass').fill('owner-pass-123');
	await expect(page.locator('#user_pass')).toHaveValue('owner-pass-123');
	await page.locator('#wp-submit').click();
	await page.waitForURL(/wp-admin/);
	await page.goto('/wp-admin/admin.php?page=gridrankers-portal');
}

async function setPart(page, label, fields = {}) {
	await page.getByLabel(label).check();
	for (const [name, value] of Object.entries(fields)) await page.locator(`[name="${name}"]`).fill(value);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.locator('.notice').first().waitFor();
}

test('tracker portal: hours, marks, screenshots and the main portal', async ({ page, browser }) => {
	// 503: the main portal can't be reached to check a code (expected below).
	const noErrors = watchErrors(page, /401|403|503/);

	// On its own: Max tracks an hour yesterday.
	await signIn(page, MAX);
	const y = await apiCall(page, 'POST', 'time-entries/batch', {
		entries: [{ id: 'E2ETRACKER00000000000001', started_at: utc(29 * 3600000), ended_at: utc(28 * 3600000), note: 'Backlinks' }],
	});
	expect(y.json.results[0].status).toBe('saved');
	await signOut(page);
	// Max stays signed in on another computer (his session outlives the switch below).
	const maxContext = await browser.newContext();
	const maxPage = await maxContext.newPage();
	await signIn(maxPage, MAX);

	// The Super Admin makes this site the tracker portal.
	await ownerToSettings(page);
	await setPart(page, 'Tracker portal — copies profiles from the main portal', { main_url: MAIN, key: 'ab'.repeat(32) });
	await expect(page.locator('.notice').first()).toContainText('Can’t reach 127.0.0.1');

	// Hours: Max's hour, waiting for the main portal; no boards, projects or reports.
	await page.goto('/');
	await expect(page.getByRole('tab', { name: 'Hours' })).toBeVisible();
	await expect(page.locator('.trk-note')).toContainText('Profiles, leave and pay are on 127.0.0.1');
	// (Spec 30 left Max half an hour, sent before this site became the tracker portal.)
	const max = page.locator('.trk-table tr', { hasText: 'Max Member' });
	await expect(max).toContainText(/1h|1h 30m/);
	await expect(max).toContainText('waiting');
	await expect(page.getByText('Meeting Minutes')).toHaveCount(0);
	await expect(page.getByRole('tab', { name: 'My time' })).toHaveCount(0);

	// Max's Time: the entry, marked.
	await max.getByRole('button', { name: /Max Member/ }).click();
	await expect(page.locator('.tt-row', { hasText: 'Backlinks' })).toContainText('Not on 127.0.0.1:9 yet');
	await expect(page.locator('.tt-start')).toHaveCount(0);

	// Screenshots: the Super Admin turns them on; Max's desktop app sends one of his running timer.
	await page.getByRole('button', { name: '‹ Hours' }).click();
	await page.getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Screenshots').selectOption('10');
	await expect(page.getByText('A screenshot every 10 minutes while a timer runs')).toBeVisible();
	const started = await apiCall(maxPage, 'POST', 'timer/start', { note: 'On calls' });
	expect(started.status).toBe(200);
	const sent = await maxPage.evaluate(async (entryId) => {
		const cfg = window.GRP_CONFIG;
		const c = document.createElement('canvas');
		c.width = 320;
		c.height = 180;
		c.getContext('2d').fillRect(0, 0, 100, 100);
		const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
		const form = new FormData();
		form.append('id', 'E2ESHOT00000000000000001');
		form.append('taken_at', new Date().toISOString().slice(0, 19).replace('T', ' '));
		form.append('file', blob, 'shot.jpg');
		const res = await fetch(new URL(cfg.restRoot + `time-entries/${entryId}/screenshots`, location.href), { method: 'POST', credentials: 'same-origin', headers: { 'X-WP-Nonce': cfg.nonce }, body: form });
		return res.status;
	}, started.json.timer.id);
	expect(sent).toBe(201);
	await page.getByRole('tab', { name: 'Screenshots' }).click();
	await page.getByLabel('Person').selectOption({ label: 'Max Member' });
	const shot = page.locator('.shots-item');
	await expect(shot).toHaveCount(1);
	await expect(shot.locator('img')).toBeVisible();
	await shot.click();
	await page.locator('.shots-big').getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByText('No screenshots this day.')).toBeVisible();
	await apiCall(maxPage, 'POST', 'timer/stop');
	await maxContext.close();

	// A code sign-in asks the main portal.
	await page.context().clearCookies();
	await page.goto('/');
	await page.getByLabel('Your code').fill(MAX);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByText('Can’t reach 127.0.0.1 to check your code. Try again in a minute.')).toBeVisible();

	// The main portal, linked to tracker.gridrankers.com: time is tracked there.
	await ownerToSettings(page);
	await setPart(page, 'Main portal — profiles, reports and pay live here', { tracker_url: 'https://tracker.gridrankers.com' });
	await page.getByRole('button', { name: 'Make a link key' }).click();
	await expect(page.getByText('it is shown only once')).toBeVisible();
	await page.context().clearCookies();
	await signIn(page, MAX);
	await page.locator('.me-btn').first().click();
	await page.getByRole('tab', { name: 'My time' }).click();
	await expect(page.locator('.tt-elsewhere')).toContainText('Time is tracked on tracker.gridrankers.com');
	await expect(page.locator('.tt-row', { hasText: 'Backlinks' }).getByRole('button', { name: 'Edit' })).toHaveCount(0);
	await page.context().clearCookies();

	// Back on its own for the other specs.
	await ownerToSettings(page);
	await setPart(page, 'On its own');
	await expect(page.locator('.notice').first()).toContainText('works on its own');

	noErrors();
});
