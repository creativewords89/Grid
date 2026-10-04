// One set of statuses and Request undo (SPEC.md 6.6, designs ST-A, ST-B and TC-A): a Team Member
// who moved a task to In progress by mistake asks to undo it; a Team Leader decides from the card's
// Review. The last unit of a quantity task asks what was completed; unassigned tasks are locked.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, card, openProject, signIn, signOut, watchErrors, waiting } from './helpers.mjs';

test('request undo and the last unit', async ({ page }) => {
	const noErrors = watchErrors(page);
	const dlg = page.locator('dialog[open]');
	const box = (title) => page.locator('.md-card', { has: page.getByRole('heading', { name: title }) });
	const undoTitle = 'Undo me ' + Date.now();
	const qtyTitle = 'Two citations ' + Date.now();
	const openTitle = 'Nobody yet ' + Date.now();

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
	expect((await apiCall(page, 'POST', 'meeting-tasks', { project_id: project.id, title: openTitle })).status).toBe(201);
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
	await page.getByText('Undo requested — a Team Leader or the Super Admin will answer').waitFor();
	// Design TC-A: a chip, not the reason.
	await expect(mine.locator('.undo-chip')).toHaveText('↶ Undo requested');
	await expect(mine).toContainText('waiting for a Team Leader or Super Admin');
	await expect(mine).not.toContainText('I moved the wrong card');
	await expect(mine.getByRole('button', { name: '↶ Request undo' })).toHaveCount(0);

	// An unassigned task is locked for Team Members until someone is assigned (SPEC.md 6.6).
	const open = card(page, openTitle);
	await expect(open.locator('.seg button')).toHaveCount(3);
	for (const b of await open.locator('.seg button').all()) await expect(b).toBeDisabled();
	await expect(open.locator('.lock-line')).toContainText('Assign someone before work starts');
	expect((await apiCall(page, 'POST', `meeting-tasks/${(await apiCall(page, 'GET', 'meeting-tasks')).json.find((t) => t.title === openTitle).id}/status`, { status: 'doing' })).status).toBe(403);

	// The last unit of a quantity task asks what was completed.
	const qty = card(page, qtyTitle);
	await qty.getByRole('button', { name: 'Details' }).click();
	await dlg.getByRole('button', { name: 'One more for Max Member' }).click();
	await page.getByText('1/2 done').first().waitFor();
	await dlg.getByRole('button', { name: 'One more for Max Member' }).click();
	const done = page.locator('dialog[open]', { has: page.getByRole('heading', { name: 'Submit completed work' }) });
	await expect(done).toBeVisible();
	await done.getByLabel('What you did').fill('Added two citations to the Dhaka page');
	await done.getByRole('button', { name: 'Submit for review' }).click();
	await page.getByText('All done — sent for review').waitFor();
	await page.keyboard.press('Escape');
	await signOut(page);

	// Team Leader: the request waits in Notifications (Waiting for you) and the bell; on the card,
	// Review shows the reason and Undo puts it back to Not started.
	await signIn(page, LEAD);
	const ask = (await waiting(page)).locator('.ap-item', { hasText: undoTitle });
	await expect(ask).toContainText('Undo requested');
	await expect(ask).toContainText('In progress → Not started');
	await expect(ask).toContainText('I moved the wrong card');
	await page.getByRole('button', { name: /Notifications/ }).click();
	await expect(page.locator('.md-pop').getByText(`Max Member asked to undo “${undoTitle}”`)).toBeVisible();
	// The panel lies over the cards below, not clipped by the header (what is under its lower part is the panel itself).
	const box2 = await page.locator('.md-pop').boundingBox();
	expect(box2.height).toBeGreaterThan(120);
	const onTop = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.md-pop'), { x: box2.x + box2.width / 2, y: box2.y + box2.height - 10 });
	expect(onTop).toBe(true);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/bell-open.png' });
	await page.getByRole('button', { name: /Notifications/ }).click();
	await openProject(page, 'Acme Plumbing');
	const theirs = card(page, undoTitle);
	await expect(theirs.locator('.undo-chip')).toHaveText('↶ Undo requested · Max Member');
	await expect(theirs).not.toContainText('I moved the wrong card');
	await theirs.getByRole('button', { name: 'Review' }).click();
	await expect(theirs.locator('.undo-pop')).toContainText('I moved the wrong card');
	await theirs.getByLabel('Message (optional)').fill('No problem');
	await theirs.getByRole('button', { name: 'Undo', exact: true }).click();
	await page.getByText('Undone — back to Not started').waitFor();
	await expect(theirs.locator('.undo-chip')).toHaveCount(0);
	await signOut(page);

	// Max gets the answer and the task is Not started again.
	await signIn(page, MAX);
	await expect(box('Notifications')).toContainText('Undo approved');
	await openProject(page, 'Acme Plumbing');
	await expect(card(page, undoTitle).locator('.seg [aria-pressed=true]')).toHaveText('Not started');
	await signOut(page);
	noErrors();
});
