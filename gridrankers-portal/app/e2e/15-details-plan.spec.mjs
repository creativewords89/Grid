// Project Details and the keyword checklist (SPEC.md 6.12, designs PD-D and KP-C): leaders write
// the details and manage keywords; everyone opens links, ticks boxes and writes notes.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, openProject, signIn, signOut, watchErrors, waiting } from './helpers.mjs';

test('project details and keyword checklist', async ({ page }) => {
	const noErrors = watchErrors(page);
	const tab = (name) => page.locator('.tabs').getByRole('tab', { name, exact: true });
	const dlg = page.locator('dialog[open]');

	// Team Leader → Acme Plumbing → Details: an About section with a Sheet link.
	await signIn(page, LEAD);
	await openProject(page, 'Acme Plumbing');
	await tab('Details').click();
	await expect(page.getByText('No details yet')).toBeVisible();
	await page.getByRole('button', { name: '+ Add a section' }).click();
	await expect(page.getByLabel('Section title')).toHaveValue('About');
	await page.getByLabel('Description').fill('Family plumbing company in Dhaka and Gazipur.');
	await page.locator('.pdx-card.editing').getByRole('button', { name: '+ Add link' }).click();
	await page.getByLabel('Link address').fill('https://docs.google.com/spreadsheets/d/abc/edit');
	await expect(page.locator('.pdx-kind')).toHaveText('✓ Google Sheet');
	await page.getByLabel('Link name').fill('Keyword research 2026');
	await page.locator('.pdx-pop').getByRole('button', { name: 'Add', exact: true }).click();
	await page.locator('.pdx-card.editing').getByRole('button', { name: 'Save' }).click();
	await page.getByText('Section added').waitFor();
	// The first section is the project's header card (design PD-F): no team names in it.
	const about = page.locator('.pdx-hero');
	await expect(about.getByRole('heading', { name: 'About' })).toBeVisible();
	await expect(about.locator('.pdx-htext span')).toHaveText(/^Acme Plumbing · Active · Cycle /);
	await expect(about).not.toContainText('Max Member');
	await expect(about).toContainText('Family plumbing company in Dhaka and Gazipur.');
	const chip = about.getByRole('link', { name: /Keyword research 2026/ });
	await expect(chip).toHaveAttribute('href', 'https://docs.google.com/spreadsheets/d/abc/edit');
	await expect(chip).toHaveAttribute('target', '_blank');
	// A Drive folder straight from the card (no Edit needed).
	await about.getByRole('button', { name: '+ Add link' }).click();
	await page.getByLabel('Link address').fill('https://drive.google.com/drive/folders/xyz');
	await expect(page.locator('.pdx-kind')).toHaveText('✓ Google Drive folder');
	await page.getByLabel('Link name').fill('Job photos');
	await page.locator('.pdx-pop').getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByText('Link added').waitFor();
	await expect(about.locator('a.pdx-chip')).toHaveText([/Keyword research 2026/, /Job photos/]);
	// Goals and Notes for the team are always there; Notes with "-" lines shows a list.
	const goals = page.getByRole('region', { name: 'Goals' });
	const notes = page.getByRole('region', { name: 'Notes for the team' });
	await expect(goals).toBeVisible();
	await notes.getByRole('button', { name: 'Edit Notes for the team' }).click();
	await page.getByLabel('Description').fill('- Client-approved photos only\n- No prices on the site');
	await page.locator('.pdx-card.editing').getByRole('button', { name: 'Save' }).click();
	await page.getByText('Saved', { exact: true }).waitFor();
	await expect(page.getByRole('region', { name: 'Notes for the team' }).locator('li')).toHaveText(['Client-approved photos only', 'No prices on the site']);
	await expect(page.getByRole('region', { name: 'Goals' })).toBeVisible();
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/details.png' });

	// Plan: keywords for this cycle and the next; one moves by drag, one by the Deadline menu.
	await tab('Plan').click();
	await page.getByRole('button', { name: '+ Add keywords' }).click();
	await dlg.getByLabel(/Keywords/).fill('emergency plumber dhaka\nwater heater repair\nblocked drain gazipur');
	await dlg.getByRole('button', { name: 'Add 3 keywords' }).click();
	await page.getByText('3 keywords added').waitFor();
	const group = (name) => page.getByRole('rowgroup', { name });
	const row = (kw) => page.locator('.kp-row', { hasText: kw });
	await expect(group('This cycle').locator('.kp-row')).toHaveCount(3);
	await row('blocked drain gazipur').getByRole('button', { name: /Deadline for blocked drain gazipur/ }).click();
	await page.getByRole('menuitem', { name: /^Next cycle/ }).click();
	await expect(group('Next cycle')).toContainText('blocked drain gazipur');
	await row('water heater repair').dragTo(group('Later').locator('.kp-gh'));
	await expect(group('Later')).toContainText('water heater repair');
	await expect(row('water heater repair').getByRole('button', { name: /Deadline for/ })).toHaveText(/No deadline/);
	// Columns: rename one.
	await page.getByRole('button', { name: '⚙ Columns' }).click();
	await dlg.getByLabel('Column 4').fill('GBP post');
	await dlg.getByRole('button', { name: 'Save' }).click();
	await page.getByText('Columns saved').waitFor();
	await expect(page.locator('.kp-th')).toContainText('GBP post');
	await signOut(page);

	// Team Member: opens the links, ticks a box and writes a note; manages nothing.
	await signIn(page, MAX);
	await openProject(page, 'Acme Plumbing');
	await tab('Details').click();
	await expect(page.locator('.pdx-hero').getByRole('link', { name: /Job photos/ })).toBeVisible();
	await expect(page.locator('.pdx-hero')).toContainText('Drive folder');
	await expect(page.getByRole('region', { name: 'Notes for the team' }).locator('li')).toHaveCount(2);
	await expect(page.getByRole('region', { name: 'Goals' })).toContainText('Nothing here yet.');
	await expect(page.getByRole('button', { name: 'Edit Goals' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
	await expect(page.getByRole('button', { name: '+ Add link' })).toHaveCount(0);
	await tab('Plan').click();
	await expect(page.getByRole('button', { name: '+ Add keywords' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /Deadline for/ })).toHaveCount(0);
	const box = row('emergency plumber dhaka').getByRole('checkbox', { name: 'Content for emergency plumber dhaka' });
	await box.click();
	await expect(box).toHaveAttribute('aria-checked', 'true');
	await expect(box).toHaveAttribute('title', /Ticked by Max Member/);
	await expect(row('emergency plumber dhaka')).toContainText('1/4');
	const note = page.getByLabel('Note for emergency plumber dhaka');
	await note.fill('Need 3 more local backlinks');
	await note.press('Enter');
	await expect(note).toHaveValue('Need 3 more local backlinks');
	await expect(page.locator('.kp-foot')).toContainText('3 keywords');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/plan.png' });
	// A Team Member can't untick: clicking a tick asks a Team Leader instead.
	await box.click();
	await expect(dlg.getByRole('heading', { name: 'Ask to untick?' })).toBeVisible();
	await dlg.getByLabel('Why? (optional)').fill('Ticked by mistake');
	await dlg.getByRole('button', { name: 'Ask to untick' }).click();
	await page.getByText('Asked your Team Leaders to untick it').waitFor();
	await expect(box).toHaveAttribute('aria-checked', 'true');
	await expect(box).toHaveClass(/asked/);
	await signOut(page);

	// Team Leader: the request waits in Notifications; Untick clears the box.
	await signIn(page, LEAD);
	const asks = await waiting(page);
	const req = asks.locator('.ap-item', { hasText: 'Untick asked' });
	await expect(req).toContainText('Content · emergency plumber dhaka');
	await expect(req).not.toContainText('Ticked by mistake');
	await req.getByRole('button', { name: 'Untick', exact: true }).click();
	await page.getByText('Unticked').waitFor();
	await expect(asks.locator('.ap-item', { hasText: 'Untick asked' })).toHaveCount(0);
	await openProject(page, 'Acme Plumbing');
	await tab('Plan').click();
	await expect(row('emergency plumber dhaka').getByRole('checkbox', { name: 'Content for emergency plumber dhaka' })).toHaveAttribute('aria-checked', 'false');
	await signOut(page);
	noErrors();
});
