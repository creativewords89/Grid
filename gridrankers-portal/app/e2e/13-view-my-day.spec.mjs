// Viewing someone's My day (SPEC.md 7.0): a Team card opens that person's My day, view only. The
// Super Admin views Team Leaders and Team Members; a Team Leader views Team Members and leaders.
import { test, expect } from '@playwright/test';
import { LEAD, openTeam, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

test('view someone’s My day, view only', async ({ page }) => {
	const noErrors = watchErrors(page);
	const bar = page.locator('.va-bar');
	const teamTab = page.locator('nav.ttabs').getByRole('tab', { name: 'Team', exact: true });

	// Super Admin → Team → Max's card: his My day.
	await signInOwner(page);
	await openTeam(page);
	await page.getByRole('button', { name: 'Open Max Member' }).click();
	await expect(bar).toContainText('Viewing Max Member’s My day');
	await expect(bar).toContainText('view only');
	await expect(page.locator('.md-top h1')).toHaveText(/, Max Member$/);
	await expect(page.getByRole('heading', { name: 'My projects' })).toBeVisible();
	// Nothing to act with as Max.
	await expect(page.getByRole('button', { name: '+ Log work' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Request day leave' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/view-as.png' });
	// Back → the Team tab.
	await bar.getByRole('button', { name: '← Back' }).click();
	await expect(bar).toHaveCount(0);
	await expect(teamTab).toHaveAttribute('aria-selected', 'true');

	// His full page is one click away from the bar.
	await page.getByRole('button', { name: 'Open Max Member' }).click();
	await bar.getByRole('button', { name: 'Open Max Member’s page' }).click();
	await expect(bar).toHaveCount(0);
	await expect(page.locator('nav.ttabs').getByRole('tab', { name: 'Overview' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'View their My day' })).toBeVisible();

	// A Team Leader's My day, too; going anywhere else ends it.
	await page.getByRole('button', { name: '← All team members' }).click();
	await page.getByRole('button', { name: 'Open Lee Lead' }).click();
	await expect(bar).toContainText('Viewing Lee Lead’s My day');
	await expect(page.getByRole('button', { name: 'Send notice' })).toHaveCount(0);
	await page.locator('aside .side-link', { hasText: 'My day' }).click();
	await expect(bar).toHaveCount(0);
	await expect(page.locator('.md-top h1')).toHaveText(/, Grid Owner$/);
	await signOutOwner(page);

	// Team Leader: a member's card opens their My day; the Super Admin's card opens their page only.
	await signIn(page, LEAD);
	await openTeam(page);
	await page.getByRole('button', { name: 'Open Max Member' }).click();
	await expect(bar).toContainText('Viewing Max Member’s My day');
	await bar.getByRole('button', { name: '← Back' }).click();
	// Members & access on the Team tab: a leader can set a member's code, not change roles or remove.
	await page.locator('.ma-card').getByRole('button', { name: 'More for Max Member' }).click();
	await expect(page.locator('.ma-menu button')).toHaveText(['View their My day', 'Open their page', 'Set sign-in code']);
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Open Grid Owner' }).first().click();
	await expect(bar).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'View their My day' })).toHaveCount(0);
	await signOut(page);
	noErrors();
});
