// Notices and the required profile (SPEC.md 6.10, section 3 Profile lock): a notice to chosen
// people reaches only them; an incomplete profile locks task work until it is filled in.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, showStrip, signIn, signOut, watchErrors } from './helpers.mjs';

test('private notices and the profile lock', async ({ page }) => {
	const noErrors = watchErrors(page);
	const box = (title) => page.locator('.md-card', { has: page.getByRole('heading', { name: title }) });
	const dlg = page.locator('dialog[open]');

	// Team Leader: a notice for Max only, and one for everyone.
	await signIn(page, LEAD);
	await page.getByRole('button', { name: 'Send notice' }).click();
	await dlg.getByRole('button', { name: 'Choose people' }).click();
	await dlg.getByLabel('Add a person').selectOption({ label: 'Max Member · Team Member' });
	await dlg.getByLabel('Title (optional)').fill('Acme report');
	await dlg.getByLabel('Message').fill('Please send the Acme ranking report by 3 PM.');
	await dlg.getByRole('button', { name: 'Send', exact: true }).click();
	await page.getByText('Notice sent').waitFor();
	await page.getByRole('button', { name: 'Send notice' }).click();
	await dlg.getByLabel('Message').fill('Office closes at 4 PM on Thursday.');
	await dlg.getByRole('button', { name: 'Send', exact: true }).click();
	await page.getByText('Notice sent').waitFor();
	await signOut(page);

	// Nia sees the notice for everyone, not Max's.
	await signIn(page, 'NIACODE11');
	await expect(box('Notices')).toContainText('Office closes at 4 PM');
	await expect(box('Notices')).not.toContainText('Acme report');
	const synced = (await apiCall(page, 'GET', 'sync')).json.changes.posts.map((p) => p.title);
	expect(synced).not.toContain('Acme report');
	await signOut(page);

	// Max sees it, then removes his location: reminder, locked tasks and a clear server answer.
	await signIn(page, MAX);
	const mine = box('Notices').locator('.nc-card', { hasText: 'Acme report' });
	await expect(mine).toContainText('To you');
	await expect(mine).toContainText('Lee Lead → you');

	await page.locator('.me-btn').click();
	await page.locator('nav.ttabs').getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Location (city) *').fill('');
	await page.getByRole('button', { name: 'Save profile' }).click();
	await page.getByText('Profile saved').waitFor();
	await expect(page.locator('.pf-warn')).toContainText('Missing: Location');

	await page.getByRole('button', { name: /GridRankers/ }).click();
	const reminder = page.locator('.md-strip', { hasText: 'Finish your profile to keep working.' });
	await expect(reminder).toContainText('Missing: Location');
	await expect(box('My projects')).toContainText('Your tasks are waiting');
	const project = (await apiCall(page, 'GET', 'projects')).json[0].id;
	const refused = await apiCall(page, 'POST', 'meeting-tasks', { project_id: project, title: 'Locked task' });
	expect(refused.status).toBe(403);
	expect(refused.json.code).toBe('grp_profile_incomplete');
	expect(refused.json.message).toContain('Location');

	// Complete profile → Settings → back to work.
	await (await showStrip(page, 'Finish your profile')).getByRole('button', { name: 'Complete profile' }).click();
	await page.getByLabel('Location (city) *').fill('Rangpur');
	await page.getByRole('button', { name: 'Save profile' }).click();
	await page.getByText('Profile saved').waitFor();
	await page.getByRole('button', { name: /GridRankers/ }).click();
	await expect(page.locator('.md-strip', { hasText: 'Finish your profile' })).toHaveCount(0);
	await expect(box('My projects')).not.toContainText('Your tasks are waiting');
	expect((await apiCall(page, 'POST', 'meeting-tasks', { project_id: project, title: 'Unlocked task' })).status).toBe(201);
	await signOut(page);
	noErrors();
});
