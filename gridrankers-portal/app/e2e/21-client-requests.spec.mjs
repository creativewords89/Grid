// Client requests (SPEC.md 6.15, designs DP-F, DP-B and DP-G): Details has Overview and Client
// requests; a Team Member asks the client, marks it asked; a Team Leader is reminded to chase an old
// one and pastes what the client sent (a photo); the asker is told, opens it and marks it done.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, openProject, signIn, signOut, watchErrors } from './helpers.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('client requests', async ({ page }) => {
	const noErrors = watchErrors(page);
	const top = (name) => page.locator('.tabs').getByRole('tab', { name, exact: true });
	const sub = (name) => page.locator('.pdx-tabs').getByRole('tab', { name });
	const thread = page.locator('.cr-thread');
	const box = page.locator('section.nf');

	// Team Member → Acme Plumbing → Details → Client requests → + Ask the client.
	await signIn(page, MAX);
	await openProject(page, 'Acme Plumbing');
	await top('Details').click();
	await expect(sub('Overview')).toHaveAttribute('aria-selected', 'true');
	await expect(page.locator('.pdx-open')).toHaveCount(0);
	await sub('Client requests').click();
	await expect(page.getByText('Nothing waiting on the client.')).toBeVisible();
	await page.getByRole('button', { name: '+ Ask the client' }).click();
	const dlg = page.locator('dialog[open]');
	await dlg.getByLabel('What do you need?').fill('New GBP images');
	await dlg.getByRole('button', { name: 'Images' }).click();
	await dlg.getByLabel(/Details for the team/).fill('Storefront, the team and 3 recent jobs.');
	await dlg.getByRole('button', { name: 'Add request' }).click();

	// It opens as a thread: the details are the first message; then marked as asked by email.
	await expect(thread.getByRole('heading', { name: 'New GBP images' })).toBeVisible();
	await expect(thread.locator('.cr-msg.mine')).toContainText('Storefront, the team and 3 recent jobs.');
	await expect(thread.getByLabel('Status')).toHaveValue('needed');
	await thread.getByRole('button', { name: 'Mark as asked' }).click();
	await expect(thread.locator('.cr-event')).toContainText('Status → Asked client · by email · Max Member');
	await expect(thread.getByLabel('Status')).toHaveValue('asked');
	await expect(sub('Client requests').locator('.pdx-count')).toHaveText('1');

	// Back to the list (DP-B): one open row; Overview points to it.
	await thread.getByRole('button', { name: '← Client requests' }).click();
	const row = page.locator('.cr-row', { hasText: 'New GBP images' });
	await expect(row).toContainText('Images');
	await expect(row).toContainText('Asked client');
	await expect(row).toContainText('Today');
	await sub('Overview').click();
	await expect(page.locator('.pdx-open')).toContainText('1 open client request');
	await page.locator('.pdx-open').getByRole('button', { name: 'Open Client requests →' }).click();
	await expect(sub('Client requests')).toHaveAttribute('aria-selected', 'true');
	await signOut(page);

	// Team Leader: Bright Dental's "Website login" was asked 4 days ago → chase reminder → its thread.
	await signIn(page, LEAD);
	const chase = box.locator('.nf-must-item', { hasText: 'Bright Dental: chase the client — “Website login” asked 4 days ago' });
	await expect(chase).toBeVisible();
	await chase.getByRole('button', { name: 'Open request' }).click();
	await expect(page.locator('.top h1')).toHaveText(/^Bright Dental/);
	await expect(thread.getByRole('heading', { name: 'Website login' })).toBeVisible();
	await expect(thread.locator('.cr-event')).toContainText('Status → Asked client · by email · Nia Member');

	// Acme: paste what the client sent, with a photo → amber bubble, Received.
	await openProject(page, 'Acme Plumbing');
	await top('Details').click();
	await sub('Client requests').click();
	await page.locator('.cr-row', { hasText: 'New GBP images' }).getByRole('button', { name: 'New GBP images' }).click();
	await expect(thread.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
	await thread.getByLabel('Files to attach').setInputFiles({ name: 'storefront.png', mimeType: 'image/png', buffer: PNG });
	await expect(thread.locator('.cr-compose .sf-row')).toContainText('storefront.png');
	await thread.getByLabel('Write a message').fill('Here is the storefront. Team photo next week.');
	await thread.getByLabel('This is from the client').check();
	await thread.getByRole('button', { name: 'Send' }).click();
	const fromClient = thread.locator('.cr-msg.client');
	await expect(fromClient.locator('.cr-tag')).toHaveText('From the client');
	await expect(fromClient).toContainText('Here is the storefront.');
	await expect(fromClient.getByRole('button', { name: 'Open storefront.png' }).locator('img')).toBeVisible();
	await expect(thread.getByLabel('Status')).toHaveValue('received');
	await expect(thread.locator('.cr-event').last()).toContainText('Status → Received · Lee Lead');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/client-thread.png' });
	await signOut(page);

	// The asker hears about it, opens it from Notifications and marks it done.
	await signIn(page, MAX);
	const news = box.locator('.nf-item', { hasText: 'Acme Plumbing: the client sent “New GBP images”' });
	await expect(news).toBeVisible();
	await news.getByRole('button', { name: 'Open request ›' }).click();
	await expect(thread.getByRole('heading', { name: 'New GBP images' })).toBeVisible();
	await thread.getByRole('button', { name: 'Mark done' }).click();
	await expect(thread.getByLabel('Status')).toHaveValue('done');
	await thread.getByRole('button', { name: '← Client requests' }).click();
	await expect(page.locator('.cr-row')).toHaveCount(0);
	await expect(sub('Client requests').locator('.pdx-count')).toHaveCount(0);
	await page.locator('.cr-filters').getByRole('button', { name: 'Done' }).click();
	await expect(page.locator('.cr-row', { hasText: 'New GBP images' })).toContainText('Done');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/client-requests.png' });

	// Whoever added it may delete it.
	await page.locator('.cr-row', { hasText: 'New GBP images' }).getByRole('button', { name: 'New GBP images' }).click();
	await thread.getByRole('button', { name: 'Delete', exact: true }).click();
	await page.locator('dialog[open]').getByRole('button', { name: 'Delete' }).click();
	await page.locator('.cr-filters').getByRole('button', { name: 'All' }).click();
	await expect(page.locator('.cr-row')).toHaveCount(0);
	await signOut(page);
	noErrors();
});
