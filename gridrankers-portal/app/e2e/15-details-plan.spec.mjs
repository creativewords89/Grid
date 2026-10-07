// Project Details and the keyword checklist (SPEC.md 6.12, designs PD-D and KP-C): everyone writes
// the details, manages keywords, ticks and unticks boxes and writes notes; done keywords go to Past.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, openProject, signIn, signOut, watchErrors } from './helpers.mjs';

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
	// The project line over the sub-tabs, no team names (design DP-F); About carries the links.
	await expect(page.locator('.pdx-proj')).toContainText(/Acme Plumbing\s*Active · Cycle /);
	await expect(page.locator('.pdx-proj')).not.toContainText('Max Member');
	const about = page.locator('.pdx-hero');
	await expect(about.getByRole('heading', { name: 'About' })).toBeVisible();
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
	await row('water heater repair').dragTo(group('Next cycle').locator('.kp-gh'));
	await expect(group('Next cycle').locator('.kp-row')).toHaveCount(2);
	await expect(group('Past')).toContainText('Keywords with every box ticked show here');
	// Columns: rename one.
	await page.getByRole('button', { name: '⚙ Columns' }).click();
	await dlg.getByLabel('Column 4').fill('GBP post');
	await dlg.getByRole('button', { name: 'Save' }).click();
	await page.getByText('Columns saved').waitFor();
	await expect(page.locator('.kp-th')).toContainText('GBP post');
	await signOut(page);

	// Team Member: maintains the Details and Plan tabs too (SPEC.md 6.12), ticks, unticks and writes notes.
	await signIn(page, MAX);
	await openProject(page, 'Acme Plumbing');
	await tab('Details').click();
	await expect(page.locator('.pdx-hero').getByRole('link', { name: /Job photos/ })).toBeVisible();
	await expect(page.locator('.pdx-hero')).toContainText('Drive folder');
	await expect(page.getByRole('region', { name: 'Notes for the team' }).locator('li')).toHaveCount(2);
	await page.getByRole('region', { name: 'Goals' }).getByRole('button', { name: 'Edit Goals' }).click();
	await page.getByLabel('Description').fill('Top 3 for emergency plumber in Dhaka');
	await page.locator('.pdx-card.editing').getByRole('button', { name: 'Save' }).click();
	await page.getByText('Saved', { exact: true }).waitFor();
	await expect(page.getByRole('region', { name: 'Goals' })).toContainText('Top 3 for emergency plumber in Dhaka');
	await expect(page.getByRole('button', { name: '+ Add link' }).first()).toBeVisible();
	await tab('Plan').click();
	await page.getByRole('button', { name: '+ Add keywords' }).click();
	await dlg.getByLabel(/Keywords/).fill('plumber near me');
	await dlg.getByRole('button', { name: 'Add keyword', exact: true }).click();
	await page.getByText('Keyword added').waitFor();
	await expect(row('plumber near me').getByRole('button', { name: /Deadline for plumber near me/ })).toBeVisible();
	const box = row('emergency plumber dhaka').getByRole('checkbox', { name: 'Content for emergency plumber dhaka' });
	await box.click();
	await expect(box).toHaveAttribute('aria-checked', 'true');
	await expect(box).toHaveAttribute('title', /Ticked by Max Member/);
	await expect(row('emergency plumber dhaka')).toContainText('1/4');
	const note = page.getByLabel('Note for emergency plumber dhaka');
	await note.fill('Need 3 more local backlinks');
	await note.press('Enter');
	await expect(note).toHaveValue('Need 3 more local backlinks');
	await expect(page.locator('.kp-foot')).toContainText('4 keywords');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/plan.png' });
	// Anyone unticks a box straight away.
	await box.click();
	await page.getByText('Unticked').waitFor();
	await expect(box).toHaveAttribute('aria-checked', 'false');
	await expect(row('emergency plumber dhaka')).toContainText('0/4');
	// Every box ticked → the keyword moves to Past; unticking one brings it back.
	for (const col of ['On-page', 'Content', 'Internal links', 'GBP post']) {
		const b = row('emergency plumber dhaka').getByRole('checkbox', { name: `${col} for emergency plumber dhaka` });
		await b.click();
		await expect(b).toHaveAttribute('aria-checked', 'true');
	}
	await expect(group('Past').locator('.kp-row')).toHaveCount(1);
	await expect(group('Past')).toContainText('emergency plumber dhaka');
	await expect(group('This cycle')).not.toContainText('emergency plumber dhaka');
	await row('emergency plumber dhaka').getByRole('checkbox', { name: 'GBP post for emergency plumber dhaka' }).click();
	await expect(group('This cycle')).toContainText('emergency plumber dhaka');
	await expect(group('Past').locator('.kp-row')).toHaveCount(0);
	// Dragged into Past by hand: its boxes stay as they are; dragging it back to This cycle brings it out.
	await row('blocked drain gazipur').dragTo(group('Past').locator('.kp-gh'));
	await page.getByText('Moved to Past').first().waitFor();
	await expect(group('Past')).toContainText('blocked drain gazipur');
	await expect(row('blocked drain gazipur')).toContainText('Moved to Past by');
	await expect(row('blocked drain gazipur')).toContainText('0/4');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/plan-past.png' });
	await row('blocked drain gazipur').dragTo(group('This cycle').locator('.kp-gh'));
	await expect(group('This cycle')).toContainText('blocked drain gazipur');
	await expect(group('Past').locator('.kp-row')).toHaveCount(0);
	// The ⋯ menu does the same without dragging.
	await row('water heater repair').getByRole('button', { name: 'More for water heater repair' }).click();
	await page.getByRole('menuitem', { name: 'Move to Past' }).click();
	await expect(group('Past')).toContainText('water heater repair');
	await signOut(page);
	noErrors();
});
