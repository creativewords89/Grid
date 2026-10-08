// Task steps (SPEC.md 6.16, designs DEP-B, DEP-F, DEP-K4): a Team Leader adds a meeting task with
// Write → Edit → Proofread, each with its person and due date. The card shows only the current step
// with Not started · In progress · Completed; completing a step hands over to the next person
// ("Ready for you"), and the last step completes the task with the submission form.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, card, openProject, signIn, signOut, watchErrors } from './helpers.mjs';

test('task steps', async ({ page }) => {
	const noErrors = watchErrors(page);
	const title = `Water heater page ${Date.now()}`;
	const dlg = page.locator('dialog[open]').last();
	const step = () => card(page, title).locator('.stpc');
	const status = (name) => page.getByRole('group', { name: `Status of ${name}` });
	const day = page.locator('.mp-tasks li', { hasText: title });

	// Team Leader: Add task → Steps in order → Write → Edit → Proofread, each with a person and a date.
	await signIn(page, LEAD);
	await openProject(page, 'Acme Plumbing');
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await page.getByRole('button', { name: 'Add task', exact: true }).click();
	await dlg.getByLabel('What needs to change').fill(title);
	await dlg.getByRole('group', { name: 'Who does it' }).getByRole('button', { name: 'Steps in order' }).click();
	await expect(dlg.getByLabel('Status')).toBeDisabled();
	await expect(dlg.getByText('each step has its own due date below')).toBeVisible();
	await dlg.getByRole('button', { name: 'Write → Edit → Proofread' }).click();
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await expect(dlg.locator('.err')).toHaveText('Pick who does “Write”.');
	await dlg.getByLabel('Who does step 1').selectOption({ label: 'Max Member' });
	await dlg.getByLabel('Who does step 2').selectOption({ label: 'Lee Lead' });
	await dlg.getByLabel('Who does step 3').selectOption({ label: 'Grid Owner' });
	await dlg.getByLabel('Step 1 due').fill('2030-01-07');
	await dlg.getByLabel('Step 2 due').fill('2030-01-03');
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await expect(dlg.locator('.err')).toHaveText('“Edit” is due before “Write” — each step’s date must be on or after the one before.');
	await dlg.getByLabel('Step 1 due').fill('2030-01-03');
	await dlg.getByLabel('Step 2 due').fill('2030-01-07');
	await dlg.getByLabel('Step 3 due').fill('2030-01-10');
	if (process.env.SHOTS) await dlg.screenshot({ path: process.env.SHOTS + '/steps-dialog.png' });
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Task added').waitFor();

	// The card shows only the current step (K4): Step 1 of 3, Write · Max · due Jan 3, who is next.
	await expect(step().locator('.stpc-badge')).toHaveText(/Step 1 of 3/i);
	await expect(step().locator('.stp-segs i')).toHaveCount(3);
	await expect(step().locator('.stpc-who b')).toHaveText('Write');
	await expect(step().locator('.stpc-who small')).toContainText('Max · due Jan 3');
	await expect(step().locator('.stpc-next')).toContainText('Next: Edit · Lee · Jan 7');
	await expect(card(page, title).getByRole('group', { name: /^Status of Water/ })).toHaveCount(0);
	// The task's deadline is the last step's date.
	await expect(card(page, title).locator('.due').filter({ hasText: 'Jan 10' })).toHaveCount(1);
	await signOut(page);

	// Max: My day lists Write with Your turn and his date; he moves it to In progress, then Completed.
	await signIn(page, MAX);
	const acme = page.locator('.mp-box', { has: page.locator('.mp-name', { hasText: 'Acme Plumbing' }) });
	await page.locator('section.md-card', { has: page.getByRole('heading', { name: 'My projects' }) }).waitFor();
	for (let i = 0; i < 10 && !(await acme.count()); i++) await page.locator('.mp-pages').getByRole('button', { name: 'Next ›' }).click();
	if (await acme.locator('.mp-more').count()) await acme.locator('.mp-more').click();
	await expect(day).toContainText(`Write · ${title}`);
	await expect(day.locator('.mp-turn')).toHaveText('Your turn');
	await expect(day).toContainText('Due Jan 3');
	await openProject(page, 'Acme Plumbing');
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await status('Write').getByRole('button', { name: 'In progress' }).click();
	await page.getByText('Write: in progress').waitFor();
	await expect(card(page, title)).toHaveClass(/st-doing/);
	await expect(status('Write').getByRole('button', { name: 'Not started' })).toBeDisabled();
	await status('Write').getByRole('button', { name: 'Completed' }).click();
	await page.getByText('Write: completed — Edit is next').waitFor();
	await expect(step().locator('.stpc-badge')).toHaveText(/Step 2 of 3/i);
	await expect(step().locator('.stpc-who b')).toHaveText('Edit');
	await expect(status('Edit').getByRole('button', { name: 'Completed' })).toBeDisabled();
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/steps-card.png' });
	await signOut(page);

	// Lee: "Ready for you" opens the task; Edit → Completed; in Details he moves it back, then on.
	await signIn(page, LEAD);
	const ready = page.locator('section.nf .nf-item', { hasText: `Ready for you: Edit “${title}”` });
	await expect(ready).toBeVisible();
	await ready.getByRole('button', { name: 'Open task ›' }).click();
	await status('Edit').getByRole('button', { name: 'Completed' }).click();
	await page.getByText('Edit: completed — Proofread is next').waitFor();
	await card(page, title).getByRole('button', { name: 'Details' }).click();
	const details = page.locator('dialog[open]');
	await expect(details.locator('.stp-row')).toHaveCount(3);
	await expect(details.locator('.stp-row').nth(0)).toContainText('Due Jan 3');
	await details.getByRole('group', { name: 'Status of Edit' }).getByRole('button', { name: 'In progress' }).click();
	await page.getByText('Edit: in progress').waitFor();
	await details.getByRole('group', { name: 'Status of Edit' }).getByRole('button', { name: 'Completed' }).click();
	await page.keyboard.press('Escape');

	// The last step's Completed asks for the submission and completes the task.
	await status('Proofread').getByRole('button', { name: 'Completed' }).click();
	await expect(dlg.getByRole('heading', { name: 'Submit completed work' })).toBeVisible();
	await dlg.getByLabel('What you did').fill('Proofread and published');
	await dlg.getByRole('button', { name: 'Complete' }).click();
	await page.getByText('All steps done — completed').waitFor();
	await expect(card(page, title)).toHaveClass(/st-done/);
	await expect(step().locator('.stpc-badge')).toHaveText(/All 3 steps done/i);
	await signOut(page);
	noErrors();
});
