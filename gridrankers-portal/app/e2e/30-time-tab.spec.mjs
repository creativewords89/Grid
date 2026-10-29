// The Time tab (SPEC.md 6.21, step 98): Lee opens Max's time, changes and deletes an entry (Undo
// brings it back), sets when Max's day starts and signs Max's computer out; Max sees his own time
// and can't change another day's; the Super Admin sets when the team's day starts.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, openTeam, signIn, signInOwner, signOut, watchErrors } from './helpers.mjs';

const utc = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');

test('time tab: entries, working day and computers', async ({ page }) => {
	const noErrors = watchErrors(page);

	// Max: an hour tracked yesterday and his desktop app signed in.
	await signIn(page, MAX);
	const y = await apiCall(page, 'POST', 'time-entries/batch', {
		entries: [{ id: 'E2EYESTERDAY000000000001', started_at: utc(26 * 3600000), ended_at: utc(25 * 3600000), note: 'Citations' }],
	});
	expect(y.json.results[0].status).toBe('saved');
	expect((await apiCall(page, 'POST', 'auth/device', { code: MAX, device_name: 'Max’s laptop', platform: 'win32', app_version: '1.0.0' })).status).toBe(200);

	// His own Time tab: yesterday's entry can't be changed by him.
	await page.locator('.me-btn').first().click();
	await page.getByRole('tab', { name: 'My time' }).click();
	const yesterday = page.locator('.tt-row', { hasText: 'Citations' });
	await expect(yesterday).toBeVisible();
	await expect(yesterday.getByRole('button', { name: 'Edit' })).toHaveCount(0);
	await expect(page.locator('.tt-dev')).toContainText('Max’s laptop');
	await expect(page.locator('.tt-start')).toContainText('the team’s');
	await expect(page.getByLabel('Day starts at')).toHaveCount(0);
	await signOut(page);

	// Lee: Max's Time tab — edit, delete with Undo, working day, Revoke.
	await signIn(page, LEAD);
	await openTeam(page, 'Team');
	// A name opens a tour; the tour bar opens the person's page.
	await page.getByRole('button', { name: 'Max Member' }).first().click();
	await page.getByRole('button', { name: 'Open Max’s page' }).click();
	await page.getByRole('tab', { name: 'Time', exact: true }).click();
	const row = page.locator('.tt-row', { hasText: 'Citations' });
	await row.getByRole('button', { name: 'Edit' }).click();
	// Half an hour from its start.
	const [h, m] = (await page.locator('.tt-edit').getByLabel('Start', { exact: true }).inputValue()).split(':').map(Number);
	const end = h * 60 + m + 30;
	await page.locator('.tt-edit').getByLabel('End', { exact: true }).fill(`${String(Math.floor(end / 60) % 24).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`);
	await page.locator('.tt-edit').getByRole('button', { name: 'Save', exact: true }).click();
	await expect(row.locator('.tt-dur')).toHaveText('30:00');

	await row.getByRole('button', { name: 'Delete' }).click();
	await expect(page.locator('.tt-row', { hasText: 'Citations' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.locator('.tt-row', { hasText: 'Citations' })).toBeVisible();

	await page.getByLabel('Day starts at').fill('10:00');
	await page.locator('.tt-start').getByRole('button', { name: 'Save' }).click();
	await expect(page.locator('.tt-start')).toContainText('Starts at 10:00 (their own)');

	await page.locator('.tt-dev').getByRole('button', { name: 'Revoke' }).click();
	await expect(page.locator('.tt-dev')).toContainText('Not signed in on any computer.');
	await signOut(page);

	// The Super Admin: when the team's day starts.
	await signInOwner(page);
	await openTeam(page, 'Admin settings');
	await page.getByLabel('Team day starts at').fill('08:30');
	await page.locator('.tt-start').getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('The working day starts at 08:30')).toBeVisible();

	noErrors();
});
