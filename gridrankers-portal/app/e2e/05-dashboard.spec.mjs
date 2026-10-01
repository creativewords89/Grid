// Dashboard (SPEC.md 7.0): landing page, projects by status, adding (Super Admin / Team Leader
// only), status changes, deleting and restoring a project with its tasks; Recent Activities is
// per project (7.4).
import { test, expect } from '@playwright/test';
import { LEAD, MAX, addMeetingTask, apiCall, card, openProject, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

test('dashboard, project lifecycle and per-project Recent Activities', async ({ page }) => {
	const noErrors = watchErrors(page);
	const pd = (name) => page.locator('.pd-card', { hasText: name });

	// Team Leader lands on the Dashboard and adds a paused project starting on day 15.
	await signIn(page, LEAD);
	await expect(page.locator('.top h1')).toHaveText('Dashboard');
	await expect(page.getByLabel('New project name')).toHaveCount(0);
	await page.getByRole('button', { name: '+ New project' }).click();
	const dlg = page.locator('dialog[open]');
	await dlg.getByLabel('Project name').fill('Harbor Hotel');
	await dlg.getByLabel('Cycle start day').selectOption('15');
	await dlg.getByLabel('Status', { exact: true }).selectOption('paused');
	await dlg.getByRole('button', { name: 'Add project' }).click();
	await expect(pd('Harbor Hotel').locator('.pd-state')).toHaveText('Paused');
	await expect(pd('Harbor Hotel').locator('.pd-cycle')).toContainText('Starts day 15');
	await expect(pd('Harbor Hotel')).toContainText('0/6 monthly');

	await page.getByRole('tab', { name: /^Paused/ }).click();
	await expect(pd('Harbor Hotel')).toBeVisible();
	for (const state of await page.locator('.pd-card .pd-state').allTextContents()) expect(state).toBe('Paused');
	await page.getByRole('tab', { name: /^All/ }).click();

	await page.getByLabel('Status of Harbor Hotel').selectOption('active');
	await expect(pd('Harbor Hotel').locator('.pd-state')).toHaveText('Active');

	// A card opens the project; GridRankers goes back to the Dashboard.
	await pd('Harbor Hotel').getByRole('button', { name: 'Open Harbor Hotel' }).click();
	await expect(page.locator('.top h1')).toHaveText('Harbor Hotel');
	await addMeetingTask(page, 'Fix booking widget', 'Max Member');
	await page.getByRole('button', { name: /GridRankers/ }).click();
	await expect(page.locator('.top h1')).toHaveText('Dashboard');
	await expect(pd('Harbor Hotel')).toContainText('1 open');

	// Recent Activities only shows the selected project's deleted tasks.
	await openProject(page, 'Acme Plumbing');
	await addMeetingTask(page, 'Acme only task', 'Max Member');
	await card(page, 'Acme only task').getByRole('button', { name: 'Delete Acme only task' }).click();
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	await page.getByText('Task deleted').waitFor();
	await page.getByRole('tab', { name: 'Recent Activities' }).click();
	await expect(page.locator('.tr-card')).toContainText('Acme only task');
	await expect(page.locator('.log li').first()).toBeVisible();
	await expect(page.locator('.log .c')).toHaveCount(0);
	await openProject(page, 'Harbor Hotel');
	await page.getByRole('tab', { name: 'Recent Activities' }).click();
	await expect(page.locator('.log')).toContainText('Fix booking widget');
	await expect(page.getByText('Acme only task')).toHaveCount(0);
	await signOut(page);

	// Team Members land on the Dashboard but cannot add projects (UI and server).
	await signIn(page, MAX);
	await expect(page.locator('.top h1')).toHaveText('Dashboard');
	await expect(page.getByRole('button', { name: '+ New project' })).toHaveCount(0);
	await expect(page.getByLabel('Status of Harbor Hotel')).toHaveCount(0);
	expect((await apiCall(page, 'POST', 'projects', { name: 'Sneaky Co' })).status).toBe(403);
	await signOut(page);

	// Super Admin deletes the project, then restores it with its task.
	await signInOwner(page);
	await expect(page.locator('.top h1')).toHaveText('Dashboard');
	await pd('Harbor Hotel').getByRole('button', { name: 'Delete Harbor Hotel' }).click();
	await page.getByRole('button', { name: 'Delete project' }).click();
	await expect(pd('Harbor Hotel')).toHaveCount(0);
	const trash = page.locator('.tr-card', { hasText: 'Recently deleted projects' });
	await expect(trash).toContainText('Harbor Hotel');
	await trash.locator('li', { hasText: 'Harbor Hotel' }).getByRole('button', { name: 'Restore' }).click();
	await expect(pd('Harbor Hotel')).toBeVisible();
	await expect(pd('Harbor Hotel')).toContainText('1 open');
	await openProject(page, 'Harbor Hotel');
	await expect(card(page, 'Fix booking widget')).toBeVisible();
	await signOutOwner(page);
	noErrors();
});
