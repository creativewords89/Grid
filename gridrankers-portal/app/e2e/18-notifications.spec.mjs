// Notifications on My day (SPEC.md 6.10, design NF-A): new tasks and other news in one box with
// filters, unread dots, Mark all read and pages; Who's out and Day leave share the Today card; the
// left and right columns end at the same line.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, signIn, signOut, watchErrors } from './helpers.mjs';

test('notifications feed', async ({ page }) => {
	const noErrors = watchErrors(page);
	const stamp = Date.now();
	const box = page.locator('section.nf');

	await signIn(page, LEAD);
	const project = (await apiCall(page, 'GET', 'projects')).json.find((p) => p.name === 'Bright Dental');
	const max = (await apiCall(page, 'GET', 'members')).json.find((m) => m.name === 'Max Member');
	for (let i = 1; i <= 7; i++) {
		expect((await apiCall(page, 'POST', 'meeting-tasks', { project_id: project.id, title: `Feed task ${i} ${stamp}`, assignees: [{ id: max.id }] })).status).toBe(201);
	}
	await signOut(page);

	await signIn(page, MAX);
	await expect(box.getByRole('heading', { name: 'Notifications' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Notices' })).toHaveCount(0);
	// The seven new tasks are the newest news: the first page shows six of them, unread.
	await expect(box.locator('.nf-item')).toHaveCount(6);
	await expect(box.locator('.nf-item.new', { hasText: String(stamp) })).toHaveCount(6);
	await expect(box.locator('.nf-item', { hasText: String(stamp) }).first()).toContainText('New task for you');
	await expect(box.locator('.nf-pages')).toContainText(/1–6 of \d+/);
	await box.getByRole('button', { name: 'Next page' }).click();
	await expect(box.locator('.nf-pages')).toContainText(/7–/);
	await box.getByRole('button', { name: /^Leave/ }).click();
	await expect(box.locator('.nf-item', { hasText: 'Feed task' })).toHaveCount(0);
	await box.getByRole('button', { name: /^All/ }).click();

	// Who's out and Day leave share one card under it; the two columns end together.
	const today = page.locator('section.md-today');
	await expect(today.getByRole('heading', { name: 'Who’s out today' })).toBeVisible();
	await expect(today.getByRole('heading', { name: 'Day leave' })).toBeVisible();
	const cols = page.locator('.md-grid > .md-col');
	const [l, r] = [await cols.nth(0).boundingBox(), await cols.nth(1).boundingBox()];
	expect(Math.abs(l.y + l.height - (r.y + r.height))).toBeLessThan(2);
	const lastLeft = await cols.nth(0).locator('> .md-card').last().boundingBox();
	const lastRight = await cols.nth(1).locator('> .md-card').last().boundingBox();
	expect(Math.abs(lastLeft.y + lastLeft.height - (lastRight.y + lastRight.height))).toBeLessThan(2);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/notifications.png', fullPage: true });

	// Mark all read, then Open task goes to the task on its board.
	await box.getByRole('button', { name: 'Mark all read' }).click();
	await expect(box.locator('.nf-item.new')).toHaveCount(0);
	await expect(box.locator('.nf-new')).toHaveCount(0);
	const first = box.locator('.nf-item', { hasText: String(stamp) }).first();
	const title = (await first.locator('.nf-sub').innerText()).match(/“(.+)”/)[1];
	await first.getByRole('button', { name: 'Open task ›' }).click();
	await expect(page.locator('article.mcard', { hasText: title })).toBeVisible();
	await signOut(page);
	noErrors();
});
