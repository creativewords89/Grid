// Member completes → admin asks for a revision → member completes again → admin accepts (SPEC.md 6.4).
import { test, expect } from '@playwright/test';
import { LEAD, MAX, addMeetingTask, card, openProject, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

test('completion review round trip', async ({ page }) => {
	const noErrors = watchErrors(page);
	const title = 'Fix the H1 on /plumbers';

	await signIn(page, LEAD);
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

	// Super Admin asks for a revision from their review list.
	await signInOwner(page);
	await page.locator('.me-btn').click();
	await expect(page.getByText('Waiting for your review')).toBeVisible();
	const pending = page.locator('.rv-card', { hasText: title });
	await pending.getByRole('button', { name: 'Revise' }).click();
	await page.getByLabel('What needs changing').fill('Add the city to the meta title too');
	await page.getByRole('button', { name: 'Request revision' }).click();
	await page.getByText('Revision requested').first().waitFor();
	await expect(page.locator('.rv-card', { hasText: title })).toHaveCount(0);
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
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
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
	// Accepted work leaves "Reviews of your work" (it lists revisions and rejections).
	await page.locator('.me-btn').click();
	await expect(page.getByRole('tab', { name: 'My dashboard' })).toBeVisible();
	await expect(page.locator('.rv-mine li', { hasText: title })).toHaveCount(0);
	noErrors();
});
