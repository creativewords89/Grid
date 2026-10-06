// Touring someone's portal, view only (SPEC.md 7.0, design VT-A). From My page → Team, the Super
// Admin tours anyone else and a Team Leader tours Team Members: the whole portal as they see it —
// My day, sidebar, project tabs, General tasks, their page — under a tour bar, with nothing that
// can be changed. ✕ Close tour goes back to your own My page → Team. Team Members tour nobody.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, openTeam, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

test('tour someone’s portal, view only', async ({ page }) => {
	const noErrors = watchErrors(page);
	const bar = page.locator('.tour-bar');
	const access = page.locator('.ma-card');
	const teamTab = page.locator('nav.ttabs').getByRole('tab', { name: 'Team', exact: true });
	const viewOnly = page.getByText('View only — you’re touring Max Member’s portal.').first();

	// Super Admin → Team → click Max: his My day, as he sees it.
	await signInOwner(page);
	await openTeam(page);
	await access.getByRole('button', { name: 'Open Max Member', exact: true }).click();
	await expect(bar).toContainText('Touring Max Member’s portal');
	await expect(bar).toContainText('Team Member');
	await expect(page.locator('.md-top h1')).toHaveText(/, Max Member$/);
	await expect(page.getByRole('button', { name: '+ Log work' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
	// His sidebar: no Invoices (that's the Super Admin's).
	await expect(page.locator('aside .side-link', { hasText: 'Invoices' })).toHaveCount(0);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/tour-day.png' });

	// Around the portal, still touring: a project's tabs, with nothing to change.
	await page.locator('aside button.pick', { hasText: 'Acme Plumbing' }).click();
	await expect(page.locator('.top h1')).toHaveText('Acme Plumbing');
	await expect(bar).toBeVisible();
	await expect(page.locator('.top .me-btn')).toContainText('Max Member');
	await page.getByRole('button', { name: 'Add task', exact: true }).click();
	await viewOnly.waitFor();
	await expect(page.locator('dialog[open]')).toHaveCount(0);
	await page.getByRole('tab', { name: 'Monthly Tasks' }).click();
	const status = page.locator('article.mcard .seg button', { hasText: 'In progress' }).first();
	await status.click({ force: true });
	await expect(status).toHaveAttribute('aria-pressed', 'false');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/tour-monthly.png' });
	await page.locator('aside .side-link', { hasText: 'General tasks' }).click();
	await expect(page.locator('.top h1')).toHaveText('General tasks');
	await expect(bar).toBeVisible();
	// His own page, from his name chip.
	await page.locator('.top .me-btn').click();
	await expect(page.locator('.top h1')).toHaveText('My page');
	await expect(page.locator('.grp-member')).toContainText('Max Member');
	await expect(teamTab).toHaveCount(0);

	// ✕ Close tour → back to your own My page, on Team.
	await bar.getByRole('button', { name: '✕ Close tour' }).click();
	await expect(bar).toHaveCount(0);
	await expect(teamTab).toHaveAttribute('aria-selected', 'true');
	await expect(page.locator('aside .side-link', { hasText: 'Invoices' })).toBeVisible();

	// A Team Leader too, from the row's Tour button.
	await access.getByRole('button', { name: 'Tour Lee Lead’s portal' }).click();
	await expect(bar).toContainText('Touring Lee Lead’s portal');
	await expect(page.locator('.md-top h1')).toHaveText(/, Lee Lead$/);
	await bar.getByRole('button', { name: '✕ Close tour' }).click();
	await expect(teamTab).toHaveAttribute('aria-selected', 'true');
	await signOutOwner(page);

	// Team Leader: Team Members only — no tour or page for the Super Admin.
	await signIn(page, LEAD);
	await openTeam(page);
	await expect(access.getByRole('button', { name: 'Tour Grid Owner’s portal' })).toHaveCount(0);
	await expect(access.getByRole('button', { name: 'Open Grid Owner', exact: true })).toHaveCount(0);
	await expect(access.getByRole('button', { name: 'More for Grid Owner' })).toHaveCount(0);
	expect((await apiCall(page, 'GET', 'members/tm_owner/tour')).status).toBe(403);
	await access.getByRole('button', { name: 'More for Max Member' }).click();
	await expect(page.locator('.ma-menu button')).toHaveText(['Tour their portal', 'Open their page', 'Set sign-in code']);
	await page.keyboard.press('Escape');
	await access.getByRole('button', { name: 'Tour Max Member’s portal' }).click();
	await expect(bar).toContainText('Touring Max Member’s portal');
	await bar.getByRole('button', { name: '✕ Close tour' }).click();
	await expect(teamTab).toHaveAttribute('aria-selected', 'true');
	await signOut(page);

	// Team Member: nobody else's portal or page.
	await signIn(page, MAX);
	expect((await apiCall(page, 'GET', 'members/tm_nia/tour')).status).toBe(403);
	await page.locator('.md-top .me-btn, .top .me-btn').first().click();
	await expect(teamTab).toHaveCount(0);
	await signOut(page);
	noErrors();
});
