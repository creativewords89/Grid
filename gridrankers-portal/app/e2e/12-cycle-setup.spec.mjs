// New cycle setup (SPEC.md 6.11): when a project starts a new cycle, a Team Leader assigns every
// monthly task and reviews last cycle within 3 days; feedback reaches the people responsible.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, showStrip, signIn, signOut, watchErrors } from './helpers.mjs';

test('assign and review a new cycle', async ({ page }) => {
	const noErrors = watchErrors(page);
	const box = (title) => page.locator('.md-card', { has: page.getByRole('heading', { name: title }) });
	const dlg = page.locator('dialog[open]');

	await signIn(page, LEAD);
	const setup = box('New cycle setup').locator('.cs-proj', { hasText: 'Cycle Co' });
	// Cycle blogs has Max; Cycle pages (and any standard tasks grp_daily added) have nobody yet.
	await expect(setup).toContainText(/Assign monthly tasks · 1 of \d+ have people/);
	await expect(setup).toContainText('Review last cycle · 0 of 2 reviewed');
	await expect(setup.locator('.mp-flag')).toContainText('Due');
	await showStrip(page, 'New cycle for Cycle Co.');

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
	await expect(dlg.locator('.cs-sum')).toContainText('2 of 2 reviewed');
	await dlg.getByRole('button', { name: 'Close' }).last().click();
	await expect(setup).toContainText('Review last cycle · 2 of 2 reviewed');

	// Assign everything left: done.
	const cycleCoId = (await apiCall(page, 'GET', 'projects')).json.find((p) => p.name === 'Cycle Co').id;
	const monthly = (await apiCall(page, 'GET', 'monthly-tasks')).json.filter((t) => t.project_id === cycleCoId);
	const pages = monthly.find((t) => t.title === 'Cycle pages');
	for (const t of monthly.filter((x) => !(x.assignees || []).length)) {
		expect((await apiCall(page, 'PATCH', `monthly-tasks/${t.id}`, { assignees: [{ id: 'tm_nia', n: 1 }] })).status).toBe(200);
	}
	await expect(setup.locator('.mp-flag')).toHaveText('Done', { timeout: 15000 });
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/cycle-box.png' });
	await expect(page.locator('.md-strip', { hasText: 'Cycle Co' })).toHaveCount(0);

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
