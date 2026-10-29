// Time tracker on the portal (SPEC.md 6.21, step 97): Max starts and stops the timer in the top bar;
// tracked time is a "⏱ Tracked" line in his daily report whose minutes he can't type over; Lee sees
// tracked and handwritten time apart in Team reports; the Super Admin has no timer and sees the split
// on the pay sheet.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, signIn, signInOwner, signOut, watchErrors } from './helpers.mjs';

const utc = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');

test('timer in the top bar and tracked time in reports', async ({ page }) => {
	const noErrors = watchErrors(page);
	const dlg = page.locator('dialog[open]').last();

	await signIn(page, MAX);

	// 40 minutes tracked earlier today (as the desktop app would send it).
	const started = await apiCall(page, 'POST', 'timer/start', { ref_kind: 'none', started_at: utc(50 * 60000) });
	expect(started.status).toBe(200);
	const stopped = await apiCall(page, 'POST', 'timer/stop', { ended_at: utc(10 * 60000) });
	expect(stopped.status).toBe(200);

	// Start a timer from the top bar, then stop it.
	await page.getByRole('button', { name: '▶ Start timer' }).click();
	const pop = page.getByRole('dialog', { name: 'Start timer' });
	await expect(pop).toBeVisible();
	await pop.getByRole('button', { name: /^No task/ }).click();
	await expect(page.locator('.tm.on')).toBeVisible();
	await expect(page.getByLabel('Timer running')).toHaveText(/^0:0\d$/);
	await expect(page.locator('.tm-label')).toHaveText('No task');
	await page.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect(page.getByRole('button', { name: '▶ Start timer' })).toBeVisible();

	// The tracked line in today's report: its time comes from the timer.
	await page.locator('aside').getByRole('button', { name: 'Daily reports' }).click();
	const tracked = page.locator('.dr-row', { hasText: 'Tracked time' });
	await expect(tracked).toBeVisible();
	await expect(tracked.locator('.dr-src.tracked')).toHaveText('⏱ Tracked');
	await expect(tracked.locator('.dr-row-m')).toHaveText('40m');
	await tracked.getByRole('button', { name: 'Tracked time' }).click();
	await expect(dlg.locator('.dr-tracked-note')).toContainText('40m');
	await expect(dlg.getByRole('group', { name: 'Time spent' })).toHaveCount(0);
	await expect(dlg.getByRole('button', { name: 'Remove' })).toHaveCount(0);
	await dlg.getByLabel('Details').fill('Keyword research for Acme');
	await dlg.locator('.dlg-acts').getByRole('button', { name: /^(Save|Add)$/ }).click();
	await expect(tracked).toContainText('Keyword research for Acme');
	await expect(tracked.locator('.dr-row-m')).toHaveText('40m');

	// Handwritten work beside it, then send.
	await page.getByRole('button', { name: '+ Add work' }).click();
	await dlg.getByLabel('What did you do?').fill('Client call');
	await dlg.getByLabel('Project').selectOption({ label: 'Other' });
	await dlg.getByRole('group', { name: 'Time spent' }).getByRole('button', { name: '30m' }).click();
	await dlg.locator('.dlg-acts').getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.locator('.dr-row', { hasText: 'Client call' })).toBeVisible();
	await page.getByRole('button', { name: /^(Send report|Update report)$/ }).first().click();
	await page.waitForTimeout(500);
	await signOut(page);

	// Lee: Team reports mark each line tracked or by hand.
	await signIn(page, LEAD);
	await expect(page.locator('.tm')).toHaveCount(1);
	await page.locator('aside').getByRole('button', { name: 'Daily reports' }).click();
	const teamTab = page.getByRole('tab', { name: /Team reports|^Team$/ }).first();
	await teamTab.click();
	const maxRow = page.locator('tr', { hasText: 'Client call' }).first();
	await expect(maxRow.locator('.dr-src.hand')).toHaveText('✍ by hand');
	await expect(page.locator('tr', { hasText: 'Keyword research for Acme' }).locator('.dr-src.tracked')).toHaveText('⏱ Tracked');
	await signOut(page);

	// The Super Admin tracks no time; the pay sheet shows tracked and handwritten time apart.
	await signInOwner(page);
	await expect(page.locator('.tm')).toHaveCount(0);
	await page.locator('aside').getByRole('button', { name: 'Daily reports' }).click();
	await page.getByRole('tab', { name: 'Salary' }).click();
	await expect(page.locator('.pay-tr', { hasText: 'Max Member' }).locator('.pay-hand')).toContainText('by hand');

	noErrors();
});
