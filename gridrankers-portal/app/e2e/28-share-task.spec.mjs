// Share a task (SPEC.md 7.7, design SHR-1B): ↗ Share on a card copies a link to the task; opening
// the link — after signing in — goes to that task's board with the card highlighted.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, card, openProject, signIn, signOut, watchErrors } from './helpers.mjs';

test('share a task', async ({ page, context }) => {
	const noErrors = watchErrors(page);
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	const title = `Shared task ${Date.now()}`;

	// Lee copies the link of a meeting task.
	await signIn(page, LEAD);
	const acme = (await apiCall(page, 'GET', 'projects')).json.find((p) => p.name === 'Acme Plumbing');
	const made = await apiCall(page, 'POST', 'meeting-tasks', { project_id: acme.id, title, assignees: [{ id: 'tm_max', n: 1 }] });
	expect(made.status).toBe(201);
	await openProject(page, 'Acme Plumbing');
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await card(page, title).getByRole('button', { name: `Share ${title}` }).click();
	await page.getByText('Link copied — paste it in a chat').waitFor();
	const link = await page.evaluate(() => navigator.clipboard.readText());
	expect(link).toMatch(new RegExp(`\\?task=${made.json.id}$`));
	const monthly = (await apiCall(page, 'GET', 'monthly-tasks')).json.find((t) => t.project_id === acme.id);
	await signOut(page);

	// Max opens it: sign in first, then the card is on screen and highlighted.
	await page.goto(link);
	await page.getByLabel('Your code').fill(MAX);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(card(page, title)).toHaveClass(/flash/);
	await expect(card(page, title)).toBeInViewport();
	await expect(page.getByRole('tab', { name: 'Meeting Minutes' })).toHaveAttribute('aria-selected', 'true');
	expect(new URL(page.url()).search).toBe('');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/share-open.png' });

	// A monthly task's link opens Monthly Tasks; a missing task says so.
	await page.goto(`/?task=${monthly.id}`);
	await expect(page.locator(`#task-${monthly.id}`)).toHaveClass(/flash/);
	await page.goto('/?task=nope');
	await page.getByText('That task no longer exists.').waitFor();
	await signOut(page);
	noErrors();
});
