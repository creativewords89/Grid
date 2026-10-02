// My page → Leave (SPEC.md 7.5, design LV-A): the numbers on top, Leave requests with status chips
// and Approve / Reject, and the Super Admin's settlement. Runs after 08 (Max is on leave today).
import { test, expect } from '@playwright/test';
import { LEAD, MAX, openTeam, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plus = (n) => {
	const d = new Date();
	d.setDate(d.getDate() + n);
	return d;
};
// A week from today: the same weekday as today, so not the weekly day off 08 moved to +3.
const DAY = ymd(plus(7));

test('leave tab: numbers, requests and settlement', async ({ page }) => {
	const noErrors = watchErrors(page);
	const dlg = page.locator('dialog[open]');
	const stat = (label) => page.locator('.lv-stat', { hasText: label });
	const list = page.locator('.lv-req');

	// Team Member asks for a day a week from now.
	await signIn(page, MAX);
	await page.locator('.md-card', { has: page.getByRole('heading', { name: 'Day leave' }) }).getByRole('button', { name: 'Request day leave' }).click();
	await dlg.getByLabel('Leave type').selectOption('day');
	await dlg.getByLabel('From').fill(DAY);
	await dlg.getByLabel('To').fill(DAY);
	await dlg.getByLabel('Reason (optional)').fill('Dentist');
	await dlg.getByRole('button', { name: 'Send request' }).click();
	await page.getByText('Leave requested').waitFor();
	await signOut(page);

	// Team Leader: three numbers (no settlement data), the request on top with Approve / Reject.
	await signIn(page, LEAD);
	await openTeam(page, /^Leave/);
	await expect(page.locator('.lv-stat')).toHaveCount(3);
	await expect(stat('Waiting for you')).toContainText('Max Member');
	await expect(stat('Out today')).toContainText('Max Member · Day leave');
	await expect(page.locator('#leaveReport')).toHaveCount(0);
	const row = list.locator('.lv-row.wait', { hasText: 'Dentist' });
	await expect(list.locator('.lv-row:not(.lv-th)').first()).toContainText('Dentist');
	await expect(row).toContainText('Waiting');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/leave-lead.png', fullPage: true });
	// Chips filter by status.
	await page.locator('.lv-chips').getByRole('button', { name: /^Waiting/ }).click();
	await expect(list.locator('.lv-row:not(.lv-th)').filter({ hasNotText: 'Waiting' })).toHaveCount(0);
	await page.locator('.lv-chips').getByRole('button', { name: /^Not approved/ }).click();
	await expect(page.locator('.lv-card').first()).toContainText('Nothing with this status.');
	await page.locator('.lv-chips').getByRole('button', { name: /^Waiting/ }).click();
	await row.getByRole('button', { name: 'Approve' }).click();
	await dlg.getByLabel('Message (optional)').fill('Get well soon');
	await dlg.getByRole('button', { name: 'Approve' }).click();
	await page.getByText('Leave approved').waitFor();
	await expect(row).toHaveCount(0);
	await page.locator('.lv-chips').getByRole('button', { name: /^All/ }).click();
	const done = list.locator('.lv-row', { hasText: 'Dentist' });
	await expect(done).toContainText('Approved');
	await expect(done).toContainText('by Lee Lead');
	await expect(done).toContainText('“Get well soon”');
	await expect(stat('Waiting for you')).toContainText('Nothing to decide');
	await signOut(page);

	// Super Admin: four numbers and the settlement with the switch and the stepper.
	await signInOwner(page);
	await openTeam(page, /^Leave/);
	await expect(page.locator('.lv-stat')).toHaveCount(4);
	await expect(stat('Over the allowance')).toBeVisible();
	const set = page.locator('#leaveReport');
	await expect(set.locator('.lv-row', { hasText: 'Max Member' })).toContainText(/of 1/);
	await expect(set.locator('.lv-tot')).toContainText('paid');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/leave-admin.png', fullPage: true });
	await set.getByRole('button', { name: 'Previous' }).click();
	await expect(set.getByRole('button', { name: 'Next' })).toBeEnabled();
	await set.getByRole('button', { name: 'Year-end' }).click();
	await expect(set.locator('.lv-th')).toContainText('Sick leave');
	await expect(set.getByRole('button', { name: 'Next' })).toBeDisabled();
	await signOutOwner(page);
	noErrors();
});
