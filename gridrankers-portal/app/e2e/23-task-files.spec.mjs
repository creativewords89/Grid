// Files added with a task (SPEC.md 6.17): a Team Member attaches a brief when adding a meeting task;
// the card shows 📎 1 and Details lists it; a Team Leader adds a monthly task with a file too.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, card, openProject, signIn, signOut, watchErrors } from './helpers.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('files added with a task', async ({ page }) => {
	const noErrors = watchErrors(page);
	const title = `Homepage hero ${Date.now()}`;
	const dlg = page.locator('dialog[open]').last();

	await signIn(page, MAX);
	await openProject(page, 'Acme Plumbing');
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await page.getByRole('button', { name: 'Add task', exact: true }).click();
	await dlg.getByLabel('What needs to change').fill(title);
	await dlg.getByLabel('Task attachments').setInputFiles([
		{ name: 'hero-mockup.png', mimeType: 'image/png', buffer: PNG },
		{ name: 'copy.txt', mimeType: 'text/plain', buffer: Buffer.from('New headline: 24/7 plumbers in Dhaka') },
	]);
	await expect(dlg.locator('.att-field .sf-row')).toHaveCount(2);
	await dlg.getByRole('button', { name: 'Remove copy.txt' }).click();
	await expect(dlg.locator('.att-field .sf-row')).toHaveText([/hero-mockup\.png/]);
	await dlg.locator('.pk2-list').getByText('Max Member').click();
	if (process.env.SHOTS) await dlg.screenshot({ path: process.env.SHOTS + '/task-files.png' });
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Task added').waitFor();

	await expect(card(page, title).locator('.att-chip')).toHaveText('📎 1');
	await card(page, title).getByRole('button', { name: 'Details' }).click();
	const details = page.locator('dialog[open]');
	const files = details.locator('.dt-sec', { has: page.getByRole('heading', { name: 'Attachments' }) });
	await expect(files.locator('.sf-row')).toContainText('hero-mockup.png');
	await expect(files.getByRole('button', { name: 'Download hero-mockup.png' })).toBeVisible();
	await page.keyboard.press('Escape');
	await signOut(page);

	// A monthly task with a file.
	await signIn(page, LEAD);
	await openProject(page, 'Acme Plumbing');
	await page.getByRole('tab', { name: 'Monthly Tasks' }).click();
	await page.getByRole('button', { name: 'Add monthly task' }).click();
	const monthly = `Citations ${Date.now()}`;
	await dlg.getByLabel('Task', { exact: true }).fill(monthly);
	await dlg.locator('.pk-row', { hasText: 'Max Member' }).click();
	await dlg.getByLabel('Task attachments').setInputFiles({ name: 'sites.txt', mimeType: 'text/plain', buffer: Buffer.from('yelp, yellowpages') });
	await expect(dlg.locator('.att-field .sf-row')).toContainText('sites.txt');
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Monthly task added').waitFor();
	await expect(page.locator('article.mcard', { hasText: monthly }).locator('.att-chip')).toHaveText('📎 1');
	await signOut(page);
	noErrors();
});
