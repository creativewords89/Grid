// New cycle setup (SPEC.md 6.11): when a project starts a new cycle, a Team Leader assigns every
// monthly task and reviews last cycle's monthly and meeting tasks within 3 days; feedback reaches
// the people responsible; a reminder sits in Notifications and on the bell until it's done.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, openProject, showStrip, signIn, signOut, watchErrors } from './helpers.mjs';

test('assign and review a new cycle', async ({ page }) => {
	const noErrors = watchErrors(page);
	const box = (title) => page.locator('.md-card', { has: page.getByRole('heading', { name: title }) });
	const dlg = page.locator('dialog[open]');

	// A meeting task due last cycle (the cycle started today) and still open.
	await signIn(page, LEAD);
	const cycleCoId = (await apiCall(page, 'GET', 'projects')).json.find((p) => p.name === 'Cycle Co').id;
	const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
	expect((await apiCall(page, 'POST', 'meeting-tasks', { project_id: cycleCoId, title: 'Cycle photos', assignees: [{ id: 'tm_max', n: 1 }], deadline: { type: 'date', date: yesterday } })).status).toBe(201);
	await page.reload();
	const setup = box('New cycle setup').locator('.cs-proj', { hasText: 'Cycle Co' });
	// Cycle blogs has Max; Cycle pages (and any standard tasks grp_daily added) have nobody yet.
	await expect(setup).toContainText(/Assign monthly tasks · 1 of \d+ have people/);
	await expect(setup).toContainText('Review monthly tasks · 0 of 2 reviewed');
	await expect(setup).toContainText('Review meeting minutes · 0 of 1 reviewed');
	await expect(setup.locator('.mp-flag')).toContainText('3 days left');
	await showStrip(page, 'New cycle for Cycle Co.');

	// Today's reminder in Notifications and on the bell: no dismiss, and the bell keeps it new.
	const reminder = box('Notifications').locator('.nf-must-item', { hasText: 'Cycle Co' });
	await expect(reminder).toContainText(/New cycle for Cycle Co — \d+ unassigned, 3 to review · 3 days left/);
	await expect(reminder.getByRole('button')).toHaveText(['Open setup']);
	// Under the filter chips, not above them.
	const [chips, rem] = [await box('Notifications').locator('.nf-chips').boundingBox(), await reminder.boundingBox()];
	expect(rem.y).toBeGreaterThan(chips.y + chips.height - 1);
	await page.locator('.md-bell-btn').click();
	await expect(page.locator('.md-pop li.must', { hasText: 'New cycle for Cycle Co' })).toHaveClass(/new/);
	await page.locator('.md-bell-btn').click();
	await page.locator('.md-bell-btn').click();
	await expect(page.locator('.md-pop li.must.new', { hasText: 'New cycle for Cycle Co' })).toHaveCount(1);
	await page.locator('.md-bell-btn').click();
	await expect(box('Notifications').getByRole('button', { name: 'Mark all read' })).toHaveCount(0);

	// Review last cycle: feedback on the short one, "Looks good" on the other.
	await setup.getByRole('button', { name: 'Review last cycle' }).click();
	const blogs = dlg.locator('.cs-row', { hasText: 'Cycle blogs' });
	await expect(blogs.locator('.cs-count')).toContainText('1 / 2');
	await blogs.getByRole('button', { name: 'Send feedback' }).click();
	await blogs.getByLabel('Feedback on Cycle blogs').fill('Only 1 of 2 blogs went out. Plan the second one early this cycle.');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/cycle-review.png' });
	await blogs.getByRole('button', { name: 'Send to Max Member' }).click();
	await page.getByText('Feedback sent').first().waitFor();
	await expect(blogs).toContainText('Feedback sent');
	await dlg.locator('.cs-row', { hasText: 'Cycle pages' }).getByRole('button', { name: 'Looks good' }).click();
	await expect(dlg.locator('.cs-row', { hasText: 'Cycle pages' })).toContainText('Looks good');
	// Meeting minutes: the open one is carried over into this cycle.
	const photos = dlg.getByRole('list', { name: 'Meeting minutes' }).locator('.cs-row', { hasText: 'Cycle photos' });
	await expect(photos).toContainText('Open');
	await photos.getByRole('button', { name: 'Carry over' }).click();
	await photos.locator('.cs-carry').getByRole('button', { name: 'Carry over' }).click();
	await page.getByText(/^Carried over to /).first().waitFor();
	await expect(photos).toContainText('Carried over');
	await expect(dlg.locator('.cs-sum')).toContainText('3 of 3 reviewed');
	await dlg.getByRole('button', { name: 'Close' }).last().click();
	await expect(setup).toContainText('Review monthly tasks · 2 of 2 reviewed');
	await expect(setup).toContainText('Review meeting minutes · 1 of 1 reviewed');
	await expect(reminder).toContainText(/New cycle for Cycle Co — \d+ unassigned · 3 days left/);

	// The Monthly Tasks tab says what has nobody yet.
	await openProject(page, 'Cycle Co');
	await page.getByRole('tab', { name: 'Monthly Tasks' }).click();
	await expect(page.locator('.ua-banner')).toContainText(/\d+ monthly tasks? (has|have) nobody assigned\./);
	await page.getByRole('button', { name: 'My day' }).click();
	const monthly = (await apiCall(page, 'GET', 'monthly-tasks')).json.filter((t) => t.project_id === cycleCoId);
	const pages = monthly.find((t) => t.title === 'Cycle pages');
	for (const t of monthly.filter((x) => !(x.assignees || []).length)) {
		expect((await apiCall(page, 'PATCH', `monthly-tasks/${t.id}`, { assignees: [{ id: 'tm_nia', n: 1 }] })).status).toBe(200);
	}
	await expect(setup.locator('.mp-flag')).toHaveText('Done', { timeout: 15000 });
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/cycle-box.png' });
	await expect(page.locator('.md-strip', { hasText: 'Cycle Co' })).toHaveCount(0);
	// Done: the reminder goes away by itself.
	await expect(reminder).toHaveCount(0);
	await page.locator('.md-bell-btn').click();
	await expect(page.locator('.md-pop li.must', { hasText: 'Cycle Co' })).toHaveCount(0);
	await page.locator('.md-bell-btn').click();

	// A Team Member cannot review a cycle; Max got the feedback as a notice.
	await signOut(page);
	await signIn(page, MAX);
	const cycleCo = (await apiCall(page, 'GET', 'projects')).json.find((p) => p.name === 'Cycle Co');
	const refused = await apiCall(page, 'POST', `projects/${cycleCo.id}/cycle-review`, { task_id: pages.id, ok: true });
	expect(refused.status).toBe(403);
	await expect(box('Notifications')).toContainText('Feedback: Cycle blogs');
	await expect(page.getByRole('heading', { name: 'New cycle setup' })).toHaveCount(0);
	await signOut(page);
	noErrors();
});
