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
	await expect(page.locator('.as-nav button')).toHaveText(['Members & access', 'Days off', 'Automatic messages', 'Deleted projects', 'Export all data']);
	await expect(page.locator('.as-pane')).toContainText('Members & access');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/mypage-admin.png' });
	// Team → someone's page → back to the Team tab.
	await page.locator('nav.ttabs').getByRole('tab', { name: 'Team' }).click();
	await page.getByRole('button', { name: 'Open Max Member' }).click();
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
