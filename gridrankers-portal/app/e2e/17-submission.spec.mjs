// Submit completed work (SPEC.md 6.6, designs SF-A and SF-B): a Team Member submits with a link, a
// file and a comment, edits it afterwards and comments; a Team Leader fills in the same form and
// asks someone to review their own work; comments ring the bell of the people on the task.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, card, openProject, signIn, signOut, watchErrors } from './helpers.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('submission with files, edit and comments', async ({ page }) => {
	const noErrors = watchErrors(page);
	const stamp = Date.now();
	const maxTitle = 'Add citations ' + stamp;
	const leadTitle = 'Content plan ' + stamp;
	const top = () => page.locator('dialog[open]').last();

	await signIn(page, LEAD);
	const project = (await apiCall(page, 'GET', 'projects')).json.find((p) => p.name === 'Acme Plumbing');
	const max = (await apiCall(page, 'GET', 'members')).json.find((m) => m.name === 'Max Member');
	expect((await apiCall(page, 'POST', 'meeting-tasks', { project_id: project.id, title: maxTitle, assignees: [{ id: max.id }] })).status).toBe(201);
	expect((await apiCall(page, 'POST', 'meeting-tasks', { project_id: project.id, title: leadTitle })).status).toBe(201);
	await signOut(page);

	// Max: Completed opens Submit completed work — link, file, comment for the reviewer.
	await signIn(page, MAX);
	await openProject(page, 'Acme Plumbing');
	await card(page, maxTitle).getByRole('button', { name: 'Completed' }).click();
	const form = top();
	await expect(form.getByRole('heading', { name: 'Submit completed work' })).toBeVisible();
	await expect(form.getByRole('radio')).toHaveCount(0);
	await form.getByLabel('What you did').fill('Added 10 citations, NAP checked');
	await form.getByLabel('Link', { exact: true }).fill('https://docs.google.com/spreadsheets/d/citations');
	await form.getByRole('button', { name: '+ Add' }).click();
	await form.getByLabel('Attach files').setInputFiles({ name: 'proof.png', mimeType: 'image/png', buffer: PNG });
	await expect(form.locator('.sf-row', { hasText: 'proof.png' })).not.toHaveClass(/uploading/);
	await form.getByLabel('Comment for the reviewer').fill('Two sites still waiting for confirmation');
	if (process.env.SHOTS) await form.screenshot({ path: process.env.SHOTS + '/submit-form.png' });
	await form.getByRole('button', { name: 'Submit for review' }).click();
	await page.getByText('Sent for review').waitFor();

	// Details → Submission: everything is there; Edit submission changes it in place.
	await card(page, maxTitle).getByRole('button', { name: 'Details' }).click();
	const details = top();
	const sub = details.locator('.sb');
	await expect(sub.locator('.sb-note')).toHaveText('Added 10 citations, NAP checked');
	await expect(sub.locator('.sb-link')).toContainText('docs.google.com/spreadsheets/d/citations');
	await expect(sub.locator('.sb-files')).toContainText('proof.png');
	await expect(sub).toContainText('Two sites still waiting for confirmation');
	await sub.getByRole('button', { name: '✎ Edit submission' }).click();
	const edit = top();
	await expect(edit.getByRole('heading', { name: 'Edit submission' })).toBeVisible();
	await expect(edit.getByLabel('What you did')).toHaveValue('Added 10 citations, NAP checked');
	await edit.getByLabel('What you did').fill('Added 12 citations, NAP checked');
	await edit.getByRole('button', { name: 'Save changes' }).click();
	await page.getByText('Submission saved').waitFor();
	await expect(sub.locator('.sb-note')).toHaveText('Added 12 citations, NAP checked');
	await expect(sub.locator('.sb-head')).toContainText('edited');

	// Comment on it.
	await sub.getByLabel('Write a comment').fill('Ready when you are');
	await sub.getByRole('button', { name: 'Send' }).click();
	await expect(sub.locator('.sb-c', { hasText: 'Ready when you are' })).toBeVisible();
	if (process.env.SHOTS) await details.screenshot({ path: process.env.SHOTS + '/submission.png' });
	await page.keyboard.press('Escape');
	await signOut(page);

	// Team Leader: replies; then completes their own task with the same form and asks Max to review it.
	await signIn(page, LEAD);
	await openProject(page, 'Acme Plumbing');
	await card(page, maxTitle).getByRole('button', { name: 'Details' }).click();
	const theirs = top().locator('.sb');
	await expect(theirs.locator('.sb-c')).toContainText('Ready when you are');
	await theirs.getByLabel('Write a comment').fill('Add the Yelp screenshot too');
	await theirs.getByRole('button', { name: 'Send' }).click();
	await expect(theirs.locator('.sb-c', { hasText: 'Add the Yelp screenshot too' })).toBeVisible();
	await page.keyboard.press('Escape');

	await card(page, leadTitle).getByRole('button', { name: 'Completed' }).click();
	const mine = top();
	await expect(mine.getByRole('radio', { name: /Done — no review needed/ })).toBeChecked();
	await mine.getByLabel('What you did').fill('October content plan ready');
	await mine.getByRole('radio', { name: /Ask someone to review it/ }).check();
	await mine.getByLabel('Reviewer', { exact: true }).selectOption({ label: 'Max Member · Team Member' });
	if (process.env.SHOTS) await mine.screenshot({ path: process.env.SHOTS + '/submit-leader.png' });
	await mine.getByRole('button', { name: 'Send for review' }).click();
	await page.getByText('Sent for review').waitFor();
	await expect(card(page, leadTitle).locator('.mini-rv')).toHaveText('Awaiting review');
	await signOut(page);

	// Max: the leader's comment rings the bell.
	await signIn(page, MAX);
	await page.getByRole('button', { name: /Notifications/ }).click();
	await expect(page.locator('.md-pop').getByText(`Lee Lead commented on “${maxTitle}”`)).toBeVisible();
	// …and shows in the Notifications box too.
	await expect(page.locator('section.nf .nf-item', { hasText: `Lee Lead commented on “${maxTitle}”` })).toBeVisible();
	await signOut(page);
	noErrors();
});
