// Member completes → admin asks for a revision → member completes again → admin accepts (SPEC.md 6.4).
import { test, expect } from '@playwright/test';
import { LEAD, MAX, addMeetingTask, card, openProject, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

test('completion review round trip', async ({ page }) => {
	const noErrors = watchErrors(page);
	const title = 'Fix the H1 on /plumbers';

	await signIn(page, LEAD);
	await openProject(page, 'Acme Plumbing');
	await addMeetingTask(page, title, 'Max Member');
	await signOut(page);

	// Member completes: a completion note is required.
	await signIn(page, MAX);
	await openProject(page, 'Acme Plumbing');
	await card(page, title).getByRole('button', { name: 'Fixed' }).click();
	await page.getByRole('button', { name: 'Mark completed' }).click();
	await expect(page.getByText('Add a few words about what you completed.')).toBeVisible();
	await page.getByLabel('What you did').fill('Changed the H1 to include Springfield');
	await page.getByRole('button', { name: 'Mark completed' }).click();
	await page.getByText('Sent for review').waitFor();
	await signOut(page);

	// Super Admin asks for a revision from Needs your approval on My day.
	await signInOwner(page);
	const asks = page.locator('.md-card', { has: page.getByRole('heading', { name: 'Needs your approval' }) });
	const pending = asks.locator('.ap-item', { hasText: title });
	await pending.getByRole('button', { name: 'Send back' }).click();
	await page.getByLabel('What needs changing').fill('Add the city to the meta title too');
	await page.getByRole('button', { name: 'Request revision' }).click();
	await page.getByText('Revision requested').first().waitFor();
	await expect(asks.locator('.ap-item', { hasText: title })).toHaveCount(0);
	// The Super Admin's page (SPEC.md 7.6): the team and the admin settings, no own leave.
	await page.locator('.me-btn').click();
	await expect(page.locator('.top h1')).toHaveText('My page');
	await expect(page.locator('nav.ttabs').getByRole('tab')).toHaveText(['Calendar', 'Team', 'Leave', 'Profile settings', 'Admin settings', 'Recent Activity']);
	await expect(page.locator('nav.ttabs').getByRole('tab', { name: 'Calendar' })).toHaveAttribute('aria-selected', 'true');
	await page.locator('nav.ttabs').getByRole('tab', { name: 'Admin settings' }).click();
	// One page, the sections one below the other (SPEC.md 7.5).
	const stack = page.locator('.as-stack');
	for (const title of ['Days off', 'Automatic messages', 'Deleted projects', 'Export data']) await expect(stack).toContainText(title);
	await expect(stack.locator('.ma-card')).toHaveCount(0);
	// Members & access is all the Team tab has: search, filters and a ⋯ menu.
	await page.locator('nav.ttabs').getByRole('tab', { name: 'Team', exact: true }).click();
	const access = page.locator('.ma-card');
	await access.getByLabel('Search people').fill('max');
	await expect(access.locator('.ma-row:not(.ma-th)')).toHaveCount(1);
	await access.getByLabel('Search people').fill('');
	await access.getByRole('button', { name: /^Team Leaders/ }).click();
	await expect(access.locator('.ma-row:not(.ma-th)').first()).toContainText('Team Leader');
	await access.getByRole('button', { name: /^All/ }).click();
	await access.getByRole('button', { name: 'More for Max Member' }).click();
	await expect(access.locator('.ma-menu button')).toHaveText(['View their My day', 'Open their page', 'Set sign-in code', 'Change role', 'Remove from team']);
	if (process.env.SHOTS) await access.screenshot({ path: process.env.SHOTS + '/team-access.png' });
	// Team → someone's My day → their page → back to the Team tab.
	await page.locator('nav.ttabs').getByRole('tab', { name: 'Team' }).click();
	await access.getByRole('button', { name: 'More for Max Member' }).click();
	await access.getByRole('menuitem', { name: 'View their My day' }).click();
	await page.locator('.va-bar').getByRole('button', { name: 'Open Max Member’s page' }).click();
	await expect(page.locator('nav.ttabs').getByRole('tab', { name: 'Overview' })).toBeVisible();
	await page.getByRole('button', { name: '← All team members' }).click();
	await expect(page.locator('nav.ttabs').getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true');
	await signOutOwner(page);

	// Member sees the revision and completes again.
	await signIn(page, MAX);
	await openProject(page, 'Acme Plumbing');
	const mine = card(page, title);
	await expect(mine.locator('.rv')).toContainText('Add the city to the meta title too');
	await mine.getByRole('button', { name: 'Fixed' }).click();
	await page.getByLabel('What you did').fill('Meta title updated too');
	await page.getByRole('button', { name: 'Mark completed' }).click();
	await page.getByText('Sent for review').waitFor();
	await signOut(page);

	// Super Admin accepts in Details.
	await signInOwner(page);
	await openProject(page, 'Acme Plumbing');
	await card(page, title).getByRole('button', { name: 'Details' }).click();
	await page.locator('.dt-racts').getByRole('button', { name: 'Accept' }).click();
	await page.getByText('Accepted', { exact: true }).first().waitFor();
	await expect(page.locator('.dt-racts').getByRole('button', { name: 'Request revision' })).toBeVisible();
	await page.getByRole('button', { name: 'Close' }).click();
	await expect(card(page, title).locator('.seg [aria-pressed=true]')).toHaveText('Fixed');
	await signOutOwner(page);

	// The member sees the acceptance.
	await signIn(page, MAX);
	await openProject(page, 'Acme Plumbing');
	await expect(card(page, title).locator('.rv')).toHaveCount(0);
	await expect(card(page, title).locator('.seg [aria-pressed=true]')).toHaveText('Fixed');
	// The name chip opens your own page (SPEC.md 7.6): no dashboard or task list, and no project
	// highlighted in the sidebar.
	await page.locator('.me-btn').click();
	await expect(page.locator('.ph-card')).toContainText('Max Member');
	await expect(page.locator('.top h1')).toHaveText('My page');
	await expect(page.getByRole('tab', { name: 'Meeting Minutes' })).toHaveCount(0);
	await expect(page.locator('nav.ttabs').getByRole('tab')).toHaveText(['My leave', 'Calendar', 'Settings', 'Recent Activities']);
	await expect(page.locator('aside .pick[aria-current="true"]')).toHaveCount(0);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/mypage.png' });
	await expect(page.getByRole('button', { name: 'Team', exact: true })).toHaveCount(0);
	noErrors();
});
