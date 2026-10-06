// General tasks (SPEC.md 6.13, designs GT-A, GT-B, GT-C): work that isn't part of any project.
// A Team Leader adds one from the General tasks board; the Team Member on it sees it on the board,
// on My day (its own group) and in Notifications, and works on it; a leader moves it to a project.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, card, signIn, signOut, watchErrors } from './helpers.mjs';

test('general tasks', async ({ page }) => {
	const noErrors = watchErrors(page);
	const title = 'Renew domain ' + Date.now();
	const side = page.locator('aside .side-link', { hasText: 'General tasks' });
	const dlg = page.locator('dialog[open]');

	// Team Leader: sidebar → General tasks → + Add task (Where is already General).
	await signIn(page, LEAD);
	await side.click();
	await expect(page.locator('.top h1')).toHaveText('General tasks');
	await expect(page.locator('.top .tabs')).toHaveCount(0);
	await page.getByRole('button', { name: 'Add general task' }).click();
	await expect(dlg.getByLabel('Where')).toHaveValue('__general');
	await dlg.getByLabel('What needs to change').fill(title);
	await dlg.locator('.pk2-list').getByText('Max Member').click();
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Task added').waitFor();
	await expect(card(page, title)).toBeVisible();
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/general.png' });
	await signOut(page);

	// Max: My day shows it as its own group, Notifications says so; on the board, no Add.
	await signIn(page, MAX);
	const group = page.locator('.mp-box.mp-gen');
	await expect(group.locator('.mp-name')).toHaveText('General tasks');
	await expect(group).toContainText('no project');
	await expect(group).toContainText(title);
	await expect(page.locator('section.nf .nf-item', { hasText: `New general task: “${title}”` })).toBeVisible();
	await expect(side.locator('.side-pill')).toBeVisible();
	await group.locator('.mp-name').click();
	await expect(page.locator('.top h1')).toHaveText('General tasks');
	await expect(page.getByRole('button', { name: 'Add general task' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Mine' }).click();
	const mine = card(page, title);
	await mine.getByRole('button', { name: 'In progress' }).click();
	await expect(mine.locator('.seg button[aria-pressed="true"]')).toHaveText('In progress');
	await signOut(page);

	// Team Leader: Recent Activities lists it; Edit → Where moves it into a project.
	await signIn(page, LEAD);
	await side.click();
	await page.locator('.gt-tabs').getByRole('tab', { name: 'Recent Activities' }).click();
	await expect(page.locator('.ra-table')).toContainText(title);
	await page.locator('.gt-tabs').getByRole('tab', { name: 'Tasks' }).click();
	await card(page, title).getByRole('button', { name: 'Edit' }).click();
	await dlg.getByLabel('Where').selectOption({ label: 'Acme Plumbing' });
	await dlg.getByRole('button', { name: 'Save changes' }).click();
	await page.getByText('Changes saved').waitFor();
	await expect(card(page, title)).toHaveCount(0);
	await signOut(page);
	noErrors();
});
