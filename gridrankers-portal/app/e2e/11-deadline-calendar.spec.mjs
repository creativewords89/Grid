// Deadline calendar (SPEC.md 6.3, 6.4): Specific date and Range open a calendar; monthly tasks
// pick days of the cycle the same way.
import { test, expect } from '@playwright/test';
import { LEAD, apiCall, card, openProject, signIn, watchErrors } from './helpers.mjs';

const pad = (n) => String(n).padStart(2, '0');

test('pick deadlines on a calendar', async ({ page }) => {
	const noErrors = watchErrors(page);
	const dlg = page.locator('dialog[open]');
	const day = (n) => dlg.locator('.dp-day:not(.out)', { hasText: new RegExp(`^${n}$`) });
	const now = new Date();
	const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
	const ym = `${next.getFullYear()}-${pad(next.getMonth() + 1)}`;

	await signIn(page, LEAD);
	await openProject(page, 'Bright Dental');

	// The options, in order.
	await page.getByRole('button', { name: 'Add task', exact: true }).click();
	await expect(dlg.locator('.dl-opts label')).toHaveText(['No deadline', 'Weekly', 'Bi-weekly', 'Monthly', 'Specific date', 'Range']);

	// Specific date: a calendar opens; pick the 10th of next month.
	await dlg.getByLabel('What needs to change').fill('Launch landing page');
	await dlg.locator('.dl-opts').getByText('Specific date').click();
	await expect(dlg.locator('.dp')).toBeVisible();
	// Today is marked when it opens.
	await expect(dlg.locator('.dp-day[aria-current="date"]')).toHaveCount(1);
	await expect(dlg.locator('.dp-day.today')).toHaveAttribute('title', 'Today');
	if (process.env.SHOTS) await dlg.locator('.dp').screenshot({ path: process.env.SHOTS + '/cal-today.png' });
	await dlg.getByRole('button', { name: 'Next month' }).click();
	await day(10).click();
	// Picked: the calendar folds into one line; Change opens it again with the day picked.
	await expect(dlg.locator('.dp')).toHaveCount(0);
	await expect(dlg.locator('.dp-chosen')).toContainText('Due');
	await dlg.locator('.dp-chosen').getByRole('button', { name: 'Change' }).click();
	await expect(day(10)).toHaveAttribute('aria-pressed', 'true');
	await day(10).click();
	await expect(dlg.locator('.dp')).toHaveCount(0);
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Task added').waitFor();

	// Range: first click the start, then the end (days 1 to 5 of next month).
	await page.getByRole('button', { name: 'Add task', exact: true }).click();
	await dlg.getByLabel('What needs to change').fill('Fix citations');
	await dlg.locator('.dl-opts').getByText('Range').click();
	await dlg.getByRole('button', { name: 'Next month' }).click();
	await day(1).click();
	await expect(dlg.locator('.dp-foot')).toContainText('now pick the last day');
	await day(5).click();
	await expect(dlg.locator('.dp')).toHaveCount(0);
	await expect(dlg.locator('.dp-chosen')).toContainText('(5 days)');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/cal-range.png' });
	await dlg.locator('.dp-chosen').getByRole('button', { name: 'Change' }).click();
	await expect(dlg.locator('.dp-day.in')).toHaveCount(3);
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Task added').waitFor();

	const tasks = (await apiCall(page, 'GET', 'meeting-tasks')).json;
	expect(tasks.find((t) => t.title === 'Launch landing page').deadline).toMatchObject({ type: 'date', date: `${ym}-10` });
	expect(tasks.find((t) => t.title === 'Fix citations').deadline).toMatchObject({ type: 'dates', from: `${ym}-01`, to: `${ym}-05` });
	await expect(card(page, 'Fix citations')).toContainText('(5 days)');

	// Monthly task: days 1 to 5 of each cycle.
	await page.getByRole('tab', { name: 'Monthly Tasks' }).click();
	await page.getByRole('button', { name: 'Add monthly task' }).click();
	await page.getByLabel('Task', { exact: true }).fill('Early-cycle audit');
	await expect(dlg.locator('.dl-opts label')).toHaveText(['No deadline', 'Weekly', 'Bi-weekly', 'Monthly', 'Specific date', 'Range']);
	await dlg.locator('.dl-opts').getByText('Range').click();
	await dlg.getByRole('button', { name: 'Day 1', exact: true }).click();
	await dlg.getByRole('button', { name: 'Day 5', exact: true }).click();
	await expect(dlg.locator('.dp-chosen')).toContainText('between day 1 and day 5');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/cal-days.png' });
	// Nobody responsible: not saved (SPEC.md 6.11).
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await expect(dlg.getByRole('alert')).toHaveText('A monthly task needs at least one person responsible.');
	await dlg.locator('.pk-row', { hasText: 'Max Member' }).click();
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await expect(dlg).toHaveCount(0);
	const monthly = (await apiCall(page, 'GET', 'monthly-tasks')).json.find((t) => t.title === 'Early-cycle audit');
	expect(monthly).toMatchObject({ due_mode: 'dates', due_from_day: 1, due_day: 5 });

	// Each deadline option has its own coloured tag on the cards (SPEC.md 7.3).
	const tag = page.locator('article.mcard', { hasText: 'Early-cycle audit' }).locator('.freq');
	await expect(tag).toHaveText('Range');
	await expect(tag).toHaveClass(/dlt-dates/);
	await expect(page.locator('article.mcard', { hasText: 'GBP Posts' }).locator('.freq')).toHaveClass(/dlt-monthly/);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/tags.png' });
	noErrors();
});
