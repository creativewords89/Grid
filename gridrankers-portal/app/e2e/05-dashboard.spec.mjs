// Dashboard (SPEC.md 7.0): landing page, status tabs, clean cards with a ⋯ menu, adding
// (Super Admin / Team Leader only), deleting and restoring a project (Team → Settings);
// Recent Activities is per project (7.4).
import { test, expect } from '@playwright/test';
import { LEAD, MAX, addMeetingTask, apiCall, card, openProject, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

test('dashboard, project lifecycle and per-project Recent Activities', async ({ page }) => {
	const noErrors = watchErrors(page);
	const pd = (name) => page.locator('.pd-card', { hasText: name });
	const tab = (name) => page.locator('.pd-tabs').getByRole('tab', { name: new RegExp(`^${name}`) });
	const menu = async (name, item) => {
		await page.getByRole('button', { name: `Options for ${name}` }).click();
		await page.getByRole('menuitem', { name: item }).click();
	};

	// Team Leader lands on the Dashboard (Active tab) and adds a paused project starting on day 15.
	await signIn(page, LEAD);
	await expect(page.locator('.top h1')).toHaveText('Dashboard');
	await expect(tab('Active')).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByLabel('New project name')).toHaveCount(0);
	await page.getByRole('button', { name: '+ New project' }).click();
	const dlg = page.locator('dialog[open]');
	await dlg.getByLabel('Project name').fill('Harbor Hotel');
	await dlg.getByLabel('Cycle start day').selectOption('15');
	await dlg.getByLabel('Status', { exact: true }).selectOption('paused');
	await dlg.getByRole('button', { name: 'Add project' }).click();
	await page.getByText('Harbor Hotel added').waitFor();
	await expect(pd('Harbor Hotel')).toHaveCount(0);

	await tab('Paused').click();
	await expect(pd('Harbor Hotel').locator('.pd-cycle')).toContainText('Day 15');
	await expect(pd('Harbor Hotel')).toContainText('0/6');
	await expect(pd('Harbor Hotel')).toContainText('On track');

	await menu('Harbor Hotel', 'Move to Active');
	await page.getByText('Harbor Hotel moved to Active').waitFor();
	await expect(pd('Harbor Hotel')).toHaveCount(0);
	await tab('Active').click();
	await expect(pd('Harbor Hotel')).toBeVisible();

	// A card opens the project; GridRankers goes back to the Dashboard.
	await pd('Harbor Hotel').getByRole('button', { name: 'Open Harbor Hotel' }).click();
	await expect(page.locator('.top h1')).toHaveText('Harbor Hotel');
	await addMeetingTask(page, 'Fix booking widget', 'Max Member');
	await page.getByRole('button', { name: /GridRankers/ }).click();
	await expect(page.locator('.top h1')).toHaveText('Dashboard');
	await expect(pd('Harbor Hotel')).toContainText('1 open task');

	// Recent Activities: a table for the selected project, its deleted tasks behind a button.
	await openProject(page, 'Acme Plumbing');
	await addMeetingTask(page, 'Acme only task', 'Max Member');
	await card(page, 'Acme only task').getByRole('button', { name: 'Delete Acme only task' }).click();
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	await page.getByText('Task deleted').waitFor();
	await page.getByRole('tab', { name: 'Recent Activities' }).click();
	const rows = page.locator('.ra-row:not(.ra-headrow)');
	await expect(rows.first()).toContainText('Acme only task');
	await expect(rows.first()).toContainText('Deleted');
	await page.getByRole('button', { name: 'Added' }).click();
	for (const tag of await rows.locator('.lg-tag').allTextContents()) expect(tag).toBe('Added');
	await page.getByRole('button', { name: 'All', exact: true }).click();
	await page.getByRole('button', { name: /Recently deleted/ }).click();
	await expect(page.locator('dialog[open]')).toContainText('Acme only task');
	await page.locator('dialog[open]').getByRole('button', { name: 'Close' }).click();

	await openProject(page, 'Harbor Hotel');
	await page.getByRole('tab', { name: 'Recent Activities' }).click();
	await expect(page.locator('.ra-table')).toContainText('Fix booking widget');
	await expect(page.locator('.ra-table').getByText('Acme only task')).toHaveCount(0);
	await page.getByRole('button', { name: /Recently deleted/ }).click();
	await expect(page.locator('dialog[open]')).toContainText('Nothing deleted in the last 30 days.');
	await page.locator('dialog[open]').getByRole('button', { name: 'Close' }).click();
	await signOut(page);

	// Team Members land on the Dashboard but cannot add projects (UI and server).
	await signIn(page, MAX);
	await expect(page.locator('.top h1')).toHaveText('Dashboard');
	await expect(page.getByRole('button', { name: '+ New project' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Options for Harbor Hotel' })).toHaveCount(0);
	expect((await apiCall(page, 'POST', 'projects', { name: 'Sneaky Co' })).status).toBe(403);
	await signOut(page);

	// Super Admin deletes the project; it is restorable (with its task) from Team → Settings.
	await signInOwner(page);
	await expect(page.locator('.top h1')).toHaveText('Dashboard');
	await menu('Harbor Hotel', 'Delete project');
	await page.locator('dialog[open]').getByRole('button', { name: 'Delete project' }).click();
	await page.getByText('Harbor Hotel deleted').waitFor();
	await expect(pd('Harbor Hotel')).toHaveCount(0);
	await expect(page.getByText('Deleted projects')).toHaveCount(0);

	await page.locator('.me-btn').click();
	await page.locator('nav.ttabs').getByRole('tab', { name: 'Settings' }).click();
	const trash = page.locator('.tr-card', { hasText: 'Deleted projects' });
	await trash.locator('li', { hasText: 'Harbor Hotel' }).getByRole('button', { name: 'Restore' }).click();
	await page.getByText('restored with its tasks').waitFor();
	await page.getByRole('button', { name: /GridRankers/ }).click();
	await expect(pd('Harbor Hotel')).toBeVisible();
	await expect(pd('Harbor Hotel')).toContainText('1 open task');
	await openProject(page, 'Harbor Hotel');
	await expect(card(page, 'Fix booking widget')).toBeVisible();
	await signOutOwner(page);
	noErrors();
});
