// Who's out today → See all (SPEC.md 6.10): with more than 3 people out, the box shows faces and
// counts (or one line when everyone is off); See all lists everyone out, with search.
import { test, expect } from '@playwright/test';
import { apiCall, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

const NAMES = ['Alamin Hossen', 'Homayun Kabir', 'Lutor Rahman', 'Rajon Ahmed', 'Shakil Khan'];

test('see everyone who is out today', async ({ page }) => {
	const noErrors = watchErrors(page);
	const box = page.locator('.md-card', { has: page.getByRole('heading', { name: 'Who’s out today' }) });
	const dlg = page.locator('dialog[open]');

	// Super Admin: five more people, each with today as their own weekly day off.
	await signInOwner(page);
	const today = new Date().getDay();
	for (const name of NAMES) {
		const m = await apiCall(page, 'POST', 'members', { name });
		expect(m.status).toBe(201);
		expect((await apiCall(page, 'PUT', 'days-off/weekly', { weekdays: [today], member: m.json.id })).status).toBe(200);
	}
	await signOutOwner(page);
	await signIn(page, 'NIACODE11');

	await box.getByRole('button', { name: /See all/ }).click();
	await expect(dlg.getByRole('heading', { name: 'Who’s out today' })).toBeVisible();
	for (const name of NAMES) await expect(dlg.locator('li', { hasText: name })).toContainText('Day off');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/wo-all.png' });

	await dlg.getByLabel('Search people').fill('raj');
	await expect(dlg.locator('li')).toHaveCount(1);
	await expect(dlg.locator('li')).toContainText('Rajon Ahmed');
	await expect(dlg.locator('.ld-foot')).toContainText('1 person');
	await dlg.getByLabel('Search people').fill('zzz');
	await expect(dlg).toContainText('Nobody matches “zzz”.');

	await dlg.getByRole('button', { name: 'Close' }).first().click();
	await expect(dlg).toHaveCount(0);
	await signOut(page);
	noErrors();
});
