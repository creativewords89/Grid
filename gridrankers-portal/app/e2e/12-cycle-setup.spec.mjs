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
	// Mark all read clears the rest but never the reminder (opening the bell clears nothing).
	const markAll = box('Notifications').getByRole('button', { name: 'Mark all read' });
	if (await markAll.count()) await markAll.click();
	await expect(markAll).toHaveCount(0);
	await expect(reminder).toBeVisible();

	// Review last cycle: feedback on the short one, "Looks good" on the other.
	await setup.getByRole('button', { name: 'Review last cycle' }).click();
	const blogs = dlg.getByRole('list', { name: 'Monthly tasks' }).locator('.cs-row', { hasText: 'Cycle blogs' });
	await expect(blogs.locator('.cs-count')).toContainText('1 / 2');
	await blogs.getByRole('button', { name: 'Send feedback' }).click();
	await blogs.getByLabel('Feedback on Cycle blogs').fill('Only 1 of 2 blogs went out. Plan the second one early this cycle.');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/cycle-review.png' });
	await blogs.getByRole('button', { name: 'Send to Max Member' }).click();
	await page.getByText('Feedback sent').first().waitFor();
	await expect(blogs).toContainText('Feedback sent');
	const pagesRow = dlg.getByRole('list', { name: 'Monthly tasks' }).locator('.cs-row', { hasText: 'Cycle pages' });
	await pagesRow.getByRole('button', { name: 'Looks good' }).click();
	await expect(pagesRow).toContainText('Looks good');
	// Meeting minutes: the open one is reviewed like the rest.
	const photos = dlg.getByRole('list', { name: 'Meeting minutes' }).locator('.cs-row', { hasText: 'Cycle photos' });
	await expect(photos).toContainText('Open');
	await photos.getByRole('button', { name: 'Looks good' }).click();
	await expect(photos).toContainText('Looks good');
	await expect(dlg.locator('.cs-sum')).toContainText('3 of 3 reviewed');

	// Unfinished (design CO-1A): everything stays in last cycle unless moved. Cycle blogs (1 of 2)
	// moves as a catch-up task; the open meeting task moves with a new deadline.
	const unfinished = dlg.getByRole('list', { name: 'Unfinished' });
	const blogsLeft = unfinished.locator('.cs-row', { hasText: 'Cycle blogs' });
	await expect(blogsLeft).toContainText('1 not done');
	await expect(blogsLeft.getByRole('button', { name: /^Leave in / })).toHaveAttribute('aria-pressed', 'true');
	await blogsLeft.getByRole('button', { name: /^Move to / }).click();
	await expect(blogsLeft.locator('.cs-move-txt')).toContainText(/A catch-up task “Cycle blogs — 1 left from \w{3}” for Max/);
	if (process.env.SHOTS) await dlg.screenshot({ path: process.env.SHOTS + '/cycle-unfinished.png' });
	await blogsLeft.getByRole('button', { name: 'Move', exact: true }).click();
	await page.getByText(/^Moved to \w{3}: “Cycle blogs — 1 left from/).first().waitFor();
	await expect(blogsLeft).toContainText(/↪ Moved to \w{3}/);
	const photosLeft = unfinished.locator('.cs-row', { hasText: 'Cycle photos' });
	await photosLeft.getByRole('button', { name: /^Move to / }).click();
	await photosLeft.getByRole('button', { name: 'Move', exact: true }).click();
	await expect(photosLeft).toContainText(/↪ Moved to \w{3} · due/);
	await expect(blogsLeft.getByRole('button', { name: /^Move to / })).toHaveCount(0);
	await dlg.getByRole('button', { name: 'Close' }).last().click();
	await expect(setup).toContainText('Review monthly tasks · 2 of 2 reviewed');
	await expect(setup).toContainText('Review meeting minutes · 1 of 1 reviewed');
	await expect(reminder).toContainText(/New cycle for Cycle Co — \d+ unassigned · 3 days left/);

	// The catch-up task is on Meeting Minutes with its tag.
	await openProject(page, 'Cycle Co');
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await expect(page.locator('article.mcard', { hasText: 'Cycle blogs — 1 left from' }).locator('.carried-tag')).toHaveText(/↪ Catch-up from \w{3}/);
	await expect(page.locator('article.mcard', { hasText: 'Cycle photos' }).locator('.carried-tag')).toHaveText(/↪ Moved from \w{3}/);

	// The Monthly Tasks tab says what has nobody yet.
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
