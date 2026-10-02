// A Team Member cannot edit or delete tasks: no buttons in the UI, and 403 from the server (SPEC.md 3).
import { test, expect } from '@playwright/test';
import { LEAD, MAX, addMeetingTask, apiCall, card, openProject, signIn, signOut, watchErrors } from './helpers.mjs';

test('member cannot edit or delete', async ({ page }) => {
	const noErrors = watchErrors(page);
	const title = 'Add schema markup';

	await signIn(page, LEAD);
	await openProject(page, 'Acme Plumbing');
	await addMeetingTask(page, title, 'Max Member');
	await expect(card(page, title).getByRole('button', { name: 'Edit' })).toBeVisible();
	await signOut(page);

	await signIn(page, MAX);
	await openProject(page, 'Acme Plumbing');
	const mine = card(page, title);
	await expect(mine).toBeVisible();
	await expect(mine.getByRole('button', { name: 'Edit' })).toHaveCount(0);
	await expect(mine.getByRole('button', { name: `Delete ${title}` })).toHaveCount(0);

	// Going around the UI is refused by the server.
	const list = await apiCall(page, 'GET', 'meeting-tasks');
	expect(list.status).toBe(200);
	const task = list.json.find((t) => t.title === title);
	expect(task).toBeTruthy();

	const edit = await apiCall(page, 'PATCH', `meeting-tasks/${task.id}`, { title: 'Hacked' });
	expect(edit.status).toBe(403);
	const del = await apiCall(page, 'DELETE', `meeting-tasks/${task.id}`);
	expect(del.status).toBe(403);
	const assign = await apiCall(page, 'PATCH', `meeting-tasks/${task.id}`, { assignees: [{ id: 'tm_nia', n: 1 }] });
	expect(assign.status).toBe(403);

	await page.reload();
	await expect(card(page, title)).toBeVisible();
	await expect(card(page, 'Hacked')).toHaveCount(0);

	// Signed out, the API answers 401.
	await signOut(page);
	const anon = await apiCall(page, 'GET', 'meeting-tasks');
	expect(anon.status).toBe(401);
	noErrors();
});
