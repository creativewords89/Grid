// Bi-weekly deadlines (SPEC.md 6.2–6.4): a two-week window for meeting tasks, and monthly tasks
// tracked per two-week period of the project cycle (W1–2, W3–4).
import { test, expect } from '@playwright/test';
import { LEAD, card, openProject, signIn, watchErrors } from './helpers.mjs';

test('bi-weekly meeting and monthly tasks', async ({ page }) => {
	const noErrors = watchErrors(page);
	await signIn(page, LEAD);
	await openProject(page, 'Bright Dental');

	// Meeting task: two weeks from this week's Monday.
	await page.getByRole('button', { name: 'Add task', exact: true }).click();
	await page.getByLabel('What needs to change').fill('Rewrite service pages');
	await page.locator('.dl-opts').getByText('Bi-weekly').click();
	await expect(page.locator('.dl-wk.on')).toContainText('from this week');
	await page.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Task added').waitFor();
	await expect(card(page, 'Rewrite service pages')).toContainText('· 2 weeks');

	// Monthly task repeating every two weeks of the cycle.
	await page.getByRole('tab', { name: 'Monthly Tasks' }).click();
	await page.getByRole('button', { name: 'Add monthly task' }).click();
	await page.getByLabel('Task', { exact: true }).fill('Fortnightly report');
	await page.locator('.dl-opts').getByText('Bi-weekly').click();
	await expect(page.getByText('Quantity per 2 weeks')).toBeVisible();
	await page.getByRole('button', { name: 'Save task' }).click();
	const task = page.locator('article.mcard', { hasText: 'Fortnightly report' });
	await expect(task.locator('.freq')).toHaveText('Bi-weekly');
	await expect(task).toContainText('Qty 1 per 2 weeks');
	await expect(task.locator('.weeks .wk')).toHaveText(['W1–2', 'W3–4']);

	await page.locator('.mfilters').getByRole('button', { name: 'Bi-weekly' }).click();
	await expect(page.locator('.wk-inline')).toContainText(/Weeks [13]–[24] of 4/);
	await expect(page.locator('article.mcard')).toHaveCount(1);

	// Completing it (a Team Leader fills in the form too; no review needed) counts for this two-week period only.
	await task.getByRole('button', { name: 'Completed' }).click();
	await page.getByLabel('What you did').fill('Report sent');
	await page.getByRole('button', { name: 'Complete', exact: true }).click();
	await expect(task.locator('.wk.wd')).toHaveCount(1);
	await expect(task.locator('.wk.wd')).toHaveClass(/cur/);
	noErrors();
});
