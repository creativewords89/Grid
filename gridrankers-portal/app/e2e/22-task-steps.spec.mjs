// Task steps (SPEC.md 6.16, designs DEP-A..C): a Team Leader adds a meeting task with Write → Edit →
// Proofread; each person sees their own step on My day, ticks it when it's their turn, the next one
// is told "Ready for you", and the last step completes the task with the submission form.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, card, openProject, signIn, signOut, watchErrors } from './helpers.mjs';

test('task steps', async ({ page }) => {
	const noErrors = watchErrors(page);
	const title = `Water heater page ${Date.now()}`;
	const dlg = page.locator('dialog[open]').last();
	const steps = () => card(page, title).locator('.stp');
	const row = (name) => steps().locator('.stp-row').filter({ has: page.locator('.stp-name', { hasText: new RegExp(`^${name}$`) }) });
	const day = page.locator('.mp-tasks li', { hasText: title });

	// Team Leader: Add task → Who does it → Steps in order → Write → Edit → Proofread.
	await signIn(page, LEAD);
	await openProject(page, 'Acme Plumbing');
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await page.getByRole('button', { name: 'Add task', exact: true }).click();
	await dlg.getByLabel('What needs to change').fill(title);
	await dlg.getByRole('group', { name: 'Who does it' }).getByRole('button', { name: 'Steps in order' }).click();
	await expect(dlg.getByLabel('Status')).toBeDisabled();
	await dlg.getByRole('button', { name: 'Write → Edit → Proofread' }).click();
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await expect(dlg.locator('.err')).toHaveText('Pick who does “Write”.');
	await dlg.getByLabel('Who does step 1').selectOption({ label: 'Max Member' });
	await dlg.getByLabel('Who does step 2').selectOption({ label: 'Lee Lead' });
	await dlg.getByLabel('Who does step 3').selectOption({ label: 'Grid Owner' });
	await dlg.getByRole('button', { name: 'Move step 2 down' }).click();
	await expect(dlg.getByLabel('Step 3 name')).toHaveValue('Edit');
	await dlg.getByRole('button', { name: 'Move step 3 up' }).click();
	if (process.env.SHOTS) await dlg.screenshot({ path: process.env.SHOTS + '/steps-dialog.png' });
	await dlg.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Task added').waitFor();

	// The card shows the chain: Write is Max's turn, the others wait.
	await expect(steps().locator('.stp-row')).toHaveCount(3);
	await expect(row('Write')).toContainText('Max’s turn');
	await expect(row('Edit')).toContainText('Waiting for Write');
	await expect(row('Proofread')).toContainText('Waiting for Edit');
	await expect(card(page, title).getByRole('group', { name: /^Status of/ })).toHaveCount(0);
	await expect(row('Edit').getByRole('button', { name: 'Edit done' })).toHaveCount(0);
	await signOut(page);

	// Max: My day lists his step with Your turn; he ticks Write on the card.
	await signIn(page, MAX);
	// Earlier specs leave Max plenty of work: find Acme Plumbing's box and show all its tasks.
	const acme = page.locator('.mp-box', { has: page.locator('.mp-name', { hasText: 'Acme Plumbing' }) });
	await page.locator('section.md-card', { has: page.getByRole('heading', { name: 'My projects' }) }).waitFor();
	for (let i = 0; i < 10 && !(await acme.count()); i++) await page.locator('.mp-pages').getByRole('button', { name: 'Next ›' }).click();
	if (await acme.locator('.mp-more').count()) await acme.locator('.mp-more').click();
	await expect(day).toContainText(`Write · ${title}`);
	await expect(day.locator('.mp-turn')).toHaveText('Your turn');
	await openProject(page, 'Acme Plumbing');
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await expect(row('Edit').getByRole('button', { name: 'Edit done' })).toHaveCount(0);
	await row('Write').getByRole('button', { name: 'Write done' }).click();
	await page.getByText('Write: done — ready for Edit').waitFor();
	await expect(row('Write')).toContainText('Done');
	await expect(row('Edit')).toContainText('Lee’s turn');
	await expect(card(page, title).locator('.stp-row.s-done .stp-btn')).toHaveCount(0);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/steps-card.png' });
	await signOut(page);

	// Lee: "Ready for you" in Notifications opens the task; he edits; the Proofread step is the Super Admin's.
	await signIn(page, LEAD);
	const ready = page.locator('section.nf .nf-item', { hasText: `Ready for you: Edit “${title}”` });
	await expect(ready).toBeVisible();
	await ready.getByRole('button', { name: 'Open task ›' }).click();
	await row('Edit').getByRole('button', { name: 'Edit done' }).click();
	await page.getByText('Edit: done — ready for Proofread').waitFor();
	// A leader can count a step back while the next one hasn't used it.
	await row('Edit').getByRole('button', { name: 'Count back Edit' }).click();
	await expect(row('Edit')).toContainText('Lee’s turn');
	await row('Edit').getByRole('button', { name: 'Edit done' }).click();
	await expect(row('Proofread')).toContainText('Grid’s turn');

	// The last step completes it: the submission form first.
	await row('Proofread').getByRole('button', { name: 'Proofread done' }).click();
	await expect(dlg.getByRole('heading', { name: 'Submit completed work' })).toBeVisible();
	await dlg.getByLabel('What you did').fill('Proofread and published');
	await dlg.getByRole('button', { name: 'Complete' }).click();
	await page.getByText('All steps done — completed').waitFor();
	await expect(card(page, title)).toHaveClass(/st-done/);
	await expect(card(page, title).locator('.stp-btn')).toHaveCount(0);
	await signOut(page);
	noErrors();
});
