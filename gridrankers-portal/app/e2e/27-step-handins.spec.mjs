// Hand-ins per step (SPEC.md 6.16, design SH-2B): a Team Leader gives Write a checklist (a file, a
// Figma link, optional images). Max can't finish Write until the required items are in: the Hand in
// window has one slot per item, "2 of 3", and Finish turns on when they're in. Lee then sees Write's
// files on the card and in Details.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, card, openProject, signIn, signOut, watchErrors } from './helpers.mjs';

test('hand-ins per step', async ({ page }) => {
	const noErrors = watchErrors(page);
	const title = `BMW content ${Date.now()}`;
	const dlg = page.locator('dialog[open]').last();
	const step = () => card(page, title).locator('.stpc');
	const status = (name) => page.getByRole('group', { name: `Status of ${name}` });

	// Team Leader: Write (Max) → Edit (Lee); 📎 Hand-in on Write with three items.
	await signIn(page, LEAD);
	await openProject(page, 'Acme Plumbing');
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await page.getByRole('button', { name: 'Add task', exact: true }).click();
	await dlg.getByLabel('What needs to change').fill(title);
	await dlg.getByRole('group', { name: 'Who does it' }).getByRole('button', { name: 'Steps in order' }).click();
	await dlg.getByLabel('Who does step 1').selectOption({ label: 'Max Member' });
	await dlg.getByLabel('Who does step 2').selectOption({ label: 'Lee Lead' });
	await dlg.getByRole('button', { name: 'Hand-in for step 1' }).click();
	const list = dlg.getByRole('group', { name: 'Hand-in for step 1' });
	for (let i = 0; i < 3; i++) await list.getByRole('button', { name: '+ Add an item' }).click();
	await list.getByLabel('Hand-in 1 of step 1').fill('Article draft');
	await list.getByLabel('Hand-in 2 of step 1').fill('Figma design');
	await list.getByLabel('Kind of hand-in 2').selectOption('link');
	await list.getByLabel('Hand-in 3 of step 1').fill('Cover image ideas');
	await list.getByLabel('Kind of hand-in 3').selectOption('image');
	await list.locator('.hi-req').nth(2).click();
	await expect(list.locator('.hi-req').nth(2)).toHaveText('Optional');
	if (process.env.SHOTS) await dlg.screenshot({ path: process.env.SHOTS + '/handin-setup.png' });
	await list.getByRole('button', { name: 'Done' }).click();
	await expect(dlg.getByRole('button', { name: 'Hand-in for step 1' })).toHaveText('📎 3');
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Task added').waitFor();
	// No hand-in button on the card: it shows on Completed and in Details.
	await expect(step().locator('.hi-btn')).toHaveCount(0);
	await signOut(page);

	// Max: Completed on Write opens Hand in "Write"; Finish waits for the two required items.
	await signIn(page, MAX);
	await openProject(page, 'Acme Plumbing');
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await status('Write').getByRole('button', { name: 'Completed' }).click();
	await expect(dlg.getByRole('heading', { name: 'Hand in “Write”' })).toBeVisible();
	await expect(dlg.locator('.hi-count')).toHaveText('0 of 3 · 2 required left');
	await expect(dlg.getByRole('button', { name: 'Finish Write' })).toBeDisabled();
	await dlg.getByLabel('Upload for Article draft').setInputFiles({ name: 'bmw-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('BMW service in Dhaka') });
	await expect(dlg.getByRole('region', { name: 'Article draft' })).toContainText('bmw-draft.txt');
	await expect(dlg.locator('.hi-count')).toHaveText('1 of 3 · 1 required left');
	await dlg.getByLabel('Link for Figma design').fill('javascript:alert(1)');
	await dlg.getByLabel('Link for Figma design').press('Enter');
	await expect(dlg.getByRole('alert').filter({ hasText: 'https://' })).toBeVisible();
	await dlg.getByLabel('Link for Figma design').fill('https://www.figma.com/file/abc/BMW-hero');
	await dlg.getByLabel('Link for Figma design').press('Enter');
	await expect(dlg.getByRole('region', { name: 'Figma design' })).toContainText('Figma');
	await expect(dlg.locator('.hi-count')).toHaveText('2 of 3');
	if (process.env.SHOTS) await dlg.screenshot({ path: process.env.SHOTS + '/handin-window.png' });
	await dlg.getByRole('button', { name: 'Finish Write' }).click();
	await page.getByText('Write: completed — Edit is next').waitFor();
	await expect(step().locator('.stpc-badge')).toHaveText(/Step 2 of 2/i);
	await signOut(page);

	// Lee: the card shows what Write handed in; Details lists it under Write.
	await signIn(page, LEAD);
	await openProject(page, 'Acme Plumbing');
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await expect(step().locator('.hi-from')).toContainText('From Write:');
	await expect(step().locator('.hi-from .hi-chip')).toHaveCount(2);
	await expect(step().locator('.hi-from a.hi-chip')).toHaveAttribute('href', 'https://www.figma.com/file/abc/BMW-hero');
	if (process.env.SHOTS) await card(page, title).screenshot({ path: process.env.SHOTS + '/handin-card.png' });
	await card(page, title).getByRole('button', { name: 'Details' }).click();
	const details = page.locator('dialog[open]');
	const write = details.locator('.stp-row').nth(0);
	await expect(write.locator('.hi-btn')).toHaveText('📎 Hand in · 2 of 3');
	await expect(write.locator('.hi-chip').nth(0)).toContainText('Article draft: bmw-draft.txt');
	await expect(write.locator('.hi-chip').nth(1)).toContainText('Figma design: Figma');
	if (process.env.SHOTS) await details.screenshot({ path: process.env.SHOTS + '/handin-details.png' });
	await page.keyboard.press('Escape');
	await signOut(page);
	noErrors();
});
