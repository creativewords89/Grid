// Notifications on My day (SPEC.md 6.10, design NF-A): new tasks and other news in one box with
// filters, unread dots, Mark all read and pages; Who's out and Day leave share the Today card; the
// left and right columns end at the same line.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

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
	await expect(box.locator('.nf-item', { hasText: String(stamp) }).first()).toContainText('New task: “Feed task');
	// No descriptions in the box: titles only.
	await expect(box.locator('.nf-sub')).toHaveCount(0);
	await expect(box.locator('.nf-pages')).toContainText(/1–6 of \d+/);
	// The bell shows the same news (SPEC.md 6.9): its count and its list.
	await expect(page.locator('.md-bell-btn .md-badge')).toBeVisible();
	await page.getByRole('button', { name: /Notifications, \d+ new/ }).click();
	await expect(page.locator('.md-pop').getByText(`New task: “Feed task 7 ${stamp}”`)).toBeVisible();
	await page.locator('.md-bell-btn').click();
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
	const title = (await first.locator('.nf-top b').innerText()).match(/“(.+)”/)[1];
	await first.getByRole('button', { name: 'Open task ›' }).click();
	await expect(page.locator('article.mcard', { hasText: title })).toBeVisible();

	// Max asks for sick leave; it waits for the Team Leader at the top of Notifications (design NF-C).
	const day = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
	expect((await apiCall(page, 'POST', 'leave', { type: 'sick', from: day, to: day, reason: 'Check-up ' + stamp })).status).toBe(201);
	await signOut(page);

	await signIn(page, LEAD);
	await expect(page.getByRole('heading', { name: 'Needs your approval' })).toHaveCount(0);
	const wait = box.locator('.nf-wait');
	await expect(wait.getByRole('heading', { name: /Waiting for you · \d+/ })).toBeVisible();
	await expect(box.locator('.nf-chips').getByRole('button', { name: /^To approve \d+/ })).toBeVisible();
	await box.locator('.nf-chips').getByRole('button', { name: /^To approve/ }).click();
	const req = box.locator('.nf-wait .ap-item', { hasText: 'Max Member asks for sick leave' }).first();
	await expect(req).toBeVisible();
	await expect(req.getByRole('button', { name: 'Approve' })).toBeVisible();
	// The request rings the leader's bell too.
	await page.locator('.md-bell-btn').click();
	await expect(page.locator('.md-pop').getByText(/Max Member asks for sick leave/).first()).toBeVisible();
	await page.locator('.md-bell-btn').click();
	// A Team Leader's Today card: Who's out and Day leave.
	await expect(page.locator('section.md-today h2')).toHaveText(['Who’s out today', 'Day leave']);
	await signOut(page);

	// The Super Admin: the same, and the Today card has only Who's out.
	await signInOwner(page);
	await expect(page.getByRole('heading', { name: 'Needs your approval' })).toHaveCount(0);
	await expect(page.locator('section.md-today h2')).toHaveText(['Who’s out today']);
	await box.locator('.nf-chips').getByRole('button', { name: /^To approve/ }).click();
	await expect(box.locator('.nf-wait .ap-item', { hasText: 'Max Member asks for sick leave' }).first()).toBeVisible();
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/notif-admin.png', fullPage: true });
	await signOutOwner(page);
	noErrors();
});
