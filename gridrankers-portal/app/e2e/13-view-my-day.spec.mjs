// Viewing someone's My day (SPEC.md 7.0): the Super Admin views a Team Leader's or a Team Member's
// My day, a Team Leader a Team Member's; view only.
import { test, expect } from '@playwright/test';
import { LEAD, openTeam, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

test('view someone’s My day, view only', async ({ page }) => {
	const noErrors = watchErrors(page);
	const bar = page.locator('.va-bar');

	// Super Admin → Team → Max → View their My day.
	await signInOwner(page);
	await openTeam(page);
	await page.getByRole('button', { name: 'Open Max Member' }).click();
	await page.getByRole('button', { name: 'View their My day' }).click();
	await expect(bar).toContainText('Viewing Max Member’s My day');
	await expect(bar).toContainText('view only');
	await expect(page.locator('.md-top h1')).toHaveText(/, Max Member$/);
	await expect(page.getByRole('heading', { name: 'My projects' })).toBeVisible();
	// Nothing to act with as Max.
	await expect(page.getByRole('button', { name: '+ Log work' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Request day leave' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/view-as.png' });
	await bar.getByRole('button', { name: '← Back to Max Member’s page' }).click();
	await expect(bar).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'View their My day' })).toBeVisible();

	// A Team Leader's My day, too.
	await page.getByRole('button', { name: '← All team members' }).click();
	await page.getByRole('button', { name: 'Open Lee Lead' }).click();
	await page.getByRole('button', { name: 'View their My day' }).click();
	await expect(bar).toContainText('Viewing Lee Lead’s My day');
	await expect(page.getByRole('button', { name: 'Send notice' })).toHaveCount(0);
	// Going anywhere else ends it.
	await page.locator('aside .side-link', { hasText: 'My day' }).click();
	await expect(bar).toHaveCount(0);
	await expect(page.locator('.md-top h1')).toHaveText(/, Grid Owner$/);
	await signOutOwner(page);

	// Team Leader: a member yes, the Super Admin no.
	await signIn(page, LEAD);
	await openTeam(page);
	await page.getByRole('button', { name: 'Open Max Member' }).click();
	await expect(page.getByRole('button', { name: 'View their My day' })).toBeVisible();
	await page.getByRole('button', { name: '← All team members' }).click();
	await page.getByRole('button', { name: 'Open Grid Owner' }).first().click();
	await expect(page.getByRole('button', { name: 'View their My day' })).toHaveCount(0);
	await signOut(page);
	noErrors();
});
