// One set of statuses and Request undo (SPEC.md 6.6, designs ST-A and ST-B): a Team Member who
// moved a task to In progress by mistake asks to undo it; a Team Leader decides. The last unit of
// a quantity task asks what was completed.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, card, openProject, signIn, signOut, watchErrors } from './helpers.mjs';

test('request undo and the last unit', async ({ page }) => {
	const noErrors = watchErrors(page);
	const dlg = page.locator('dialog[open]');
	const box = (title) => page.locator('.md-card', { has: page.getByRole('heading', { name: title }) });
	const undoTitle = 'Undo me ' + Date.now();
	const qtyTitle = 'Two citations ' + Date.now();

	// Team Leader: two tasks for Max — one plain, one with a quantity of 2.
	await signIn(page, LEAD);
	const project = (await apiCall(page, 'GET', 'projects')).json.find((p) => p.name === 'Acme Plumbing');
	const max = (await apiCall(page, 'GET', 'members')).json.find((m) => m.name === 'Max Member');
	for (const [title, target] of [
		[undoTitle, 1],
		[qtyTitle, 2],
	]) {
		expect((await apiCall(page, 'POST', 'meeting-tasks', { project_id: project.id, title, target, assignees: [{ id: max.id }] })).status).toBe(201);
	}
	await signOut(page);

	// Max: the board uses Not started · In progress · Completed; moves one by mistake and asks to undo.
	await signIn(page, MAX);
	await openProject(page, 'Acme Plumbing');
	const mine = card(page, undoTitle);
	await expect(mine.locator('.seg button')).toHaveText(['Not started', 'In progress', 'Completed']);
	await mine.getByRole('button', { name: 'In progress' }).click();
	await expect(mine.getByRole('button', { name: 'Not started' })).toBeDisabled();
	await mine.getByRole('button', { name: '↶ Request undo' }).click();
	await expect(dlg.getByRole('heading', { name: 'Request undo' })).toBeVisible();
	await dlg.getByLabel('What was the mistake, and why undo it?').fill('I moved the wrong card — not started yet.');
	await dlg.getByRole('button', { name: 'Send request' }).click();
	await page.getByText('Undo requested — a Team Leader will answer').waitFor();
	await expect(mine.locator('.undo-req')).toContainText('I moved the wrong card');
	await expect(mine.getByRole('button', { name: '↶ Request undo' })).toHaveCount(0);

	// The last unit of a quantity task asks what was completed.
	const qty = card(page, qtyTitle);
	await qty.getByRole('button', { name: 'Details' }).click();
	await dlg.getByRole('button', { name: 'One more for Max Member' }).click();
	await page.getByText('1/2 done').first().waitFor();
	await dlg.getByRole('button', { name: 'One more for Max Member' }).click();
	const done = page.locator('dialog[open]', { has: page.getByRole('heading', { name: 'What did you complete?' }) });
	await expect(done).toBeVisible();
	await done.getByLabel('What you did').fill('Added two citations to the Dhaka page');
	await done.getByRole('button', { name: 'Mark completed' }).click();
	await page.getByText('All done — sent for review').waitFor();
	await page.keyboard.press('Escape');
	await signOut(page);

	// Team Leader: the request is in Needs your approval; Undo puts it back to Not started.
	await signIn(page, LEAD);
	const ask = box('Needs your approval').locator('.ap-item', { hasText: undoTitle });
	await expect(ask).toContainText('Undo requested');
	await expect(ask).toContainText('In progress → Not started');
	await expect(ask).toContainText('I moved the wrong card');
	await ask.getByRole('button', { name: 'Undo', exact: true }).click();
	await dlg.getByLabel('Message (optional)').fill('No problem');
	await dlg.getByRole('button', { name: 'Undo', exact: true }).click();
	await page.getByText('Undone — back to Not started').waitFor();
	await expect(box('Needs your approval').locator('.ap-item', { hasText: undoTitle })).toHaveCount(0);
	await signOut(page);

	// Max gets the answer and the task is Not started again.
	await signIn(page, MAX);
	await expect(box('Notices')).toContainText('Undo approved');
	await openProject(page, 'Acme Plumbing');
	await expect(card(page, undoTitle).locator('.seg [aria-pressed=true]')).toHaveText('Not started');
	await signOut(page);
	noErrors();
});
