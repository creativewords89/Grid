// Weekly tasks follow the project cycle (SPEC.md 6.2): the week bar and the week boxes count
// weeks from the project's start day (4 weeks in a normal cycle).
import { test, expect } from '@playwright/test';
import { LEAD, openProject, openProjectsTab, signIn, watchErrors } from './helpers.mjs';
import { activeWeek, cycleRange, weeksOf } from '../src/lib/cycles.js';

test('weekly tasks use cycle weeks', async ({ page }) => {
	const noErrors = watchErrors(page);
	await signIn(page, LEAD);

	await openProjectsTab(page);
	await page.getByRole('button', { name: '+ New project' }).click();
	const dlg = page.locator('dialog[open]');
	await dlg.getByLabel('Project name').fill('Mid Month Co');
	await dlg.getByLabel('Cycle start day').selectOption('15');
	await dlg.getByRole('button', { name: 'Add project' }).click();
	await page.locator('.pj-row', { hasText: 'Mid Month Co' }).waitFor();

	await openProject(page, 'Mid Month Co');
	await page.getByRole('tab', { name: 'Monthly Tasks' }).click();
	await page.getByRole('button', { name: 'Add monthly task' }).click();
	await page.getByLabel('Task', { exact: true }).fill('Weekly social post');
	await page.locator('.dl-opts').getByText('Weekly', { exact: true }).click();
	await page.locator('dialog[open] .pk-row', { hasText: 'Max Member' }).click();
	await page.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Weekly social post').first().waitFor();

	// Expected weeks from the same date maths the app uses (unit-tested separately).
	const project = { cycle_day: 15 };
	const today = await page.evaluate(() => {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	});
	const weeks = weeksOf(project, 0, today);
	const aw = activeWeek(project, 0, today);
	expect(cycleRange(project, 0, today).day).toBe(15);
	expect(weeks).toHaveLength(4);

	await page.locator('.mfilters').getByRole('button', { name: 'Weekly', exact: true }).click();
	await expect(page.locator('.wk-inline')).toContainText(`Week ${aw + 1} of 4`);
	const box = page.locator('article.mcard', { hasText: 'Weekly social post' }).locator('.weeks .wk');
	await expect(box).toHaveCount(4);
	// Dates formatted by the browser, as the app does.
	const labels = await page.evaluate((ws) => ws.map((w) => [w.start, w.end].map((s) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })).join('–')), weeks);
	await expect(box.nth(0)).toHaveAttribute('title', new RegExp(`^Week 1 · ${labels[0]}`));
	await expect(box.nth(3)).toHaveAttribute('title', new RegExp(`^Week 4 · ${labels[3]}`));
	noErrors();
});
