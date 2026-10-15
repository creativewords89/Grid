// Pay (SPEC.md 6.19, designs PAY-1 to PAY-4): Pia sets up her hours, salary and payment details
// before anything else; Max sees his month on the Salary tab and his details on Payment
// information; the Super Admin sees the pay sheet.
import { test, expect } from '@playwright/test';
import { MAX, signIn, signInOwner, signOut, watchErrors } from './helpers.mjs';

test('pay', async ({ page }) => {
	const noErrors = watchErrors(page);
	const openReports = () => page.locator('aside').getByRole('button', { name: 'Daily reports' }).click();
	const area = (name) => page.getByRole('tablist', { name: 'Daily reports and pay' }).getByRole('tab', { name });

	// Pia: the setup page comes first — no sidebar until it is saved.
	await page.goto('/');
	await page.getByLabel('Your code').fill('PIACODE11');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { name: 'Set up your work and pay' })).toBeVisible();
	await expect(page.locator('aside')).toHaveCount(0);
	await page.getByRole('button', { name: 'Save and continue' }).click();
	await expect(page.locator('.pay-form .err')).toHaveText('Pick how many hours you work a day (1 to 16).');
	await page.getByRole('group', { name: 'Hours a day' }).getByRole('button', { name: '6 hours' }).click();
	await page.getByLabel('Salary a month (BDT)').fill('18,000');
	await expect(page.locator('.pay-calc')).toContainText('1 day = 18,000 ÷ 30 = 600 BDT');
	await expect(page.locator('.pay-calc')).toContainText('1 hour = 600 ÷ 6 = 100 BDT');
	await page.getByRole('group', { name: 'Paid by' }).getByRole('button', { name: 'bKash' }).click();
	await page.getByLabel('Account name').fill('Pia Newcomer');
	await page.getByLabel('Account number').fill('12345');
	await page.getByRole('button', { name: 'Save and continue' }).click();
	await expect(page.locator('.pay-form .err')).toHaveText('Write the 11-digit mobile number, e.g. 01712345678.');
	await page.getByLabel('Account number').fill('017 1234 5678');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/pay-setup.png', fullPage: true });
	await page.getByRole('button', { name: 'Save and continue' }).click();
	await page.getByText('Shared with your team · live').waitFor();

	// Payment information: her pay and the number, all but the last 4 digits hidden.
	await openReports();
	await area('Payment information').click();
	const yours = page.getByRole('region', { name: 'Your pay' });
	await expect(yours).toContainText('18,000 BDT a month');
	await expect(yours).toContainText('6 hours a day');
	await expect(yours).toContainText('100 BDT');
	await expect(page.getByRole('region', { name: 'Payment details' })).toContainText('•••• 5678');
	await expect(page.getByRole('region', { name: 'Payment details' })).not.toContainText('01712345678');
	// Edit: 8 hours a day now.
	await yours.getByRole('button', { name: '✎ Edit' }).click();
	const dlg = page.locator('dialog[open]');
	await dlg.getByRole('group', { name: 'Hours a day' }).getByRole('button', { name: '8 hours' }).click();
	await dlg.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(yours).toContainText('8 hours a day');
	await expect(yours).toContainText('75 BDT');
	await signOut(page);

	// Max: the Salary tab — his month on a calendar and what it adds up to.
	await signIn(page, MAX);
	await openReports();
	await area('Salary').click();
	await expect(page.locator('.pay-cal')).toBeVisible();
	await expect(page.locator('.pay-sum')).toContainText('5 hours a day · 1 day 1,000 · 1 hour 200');
	await expect(page.locator('.pay-tiles')).toContainText('BDT');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/pay-salary.png', fullPage: true });
	await area('Payment information').click();
	await expect(page.getByRole('region', { name: 'Past months' })).toContainText('Your first payslip comes on the 1st of next month.');
	await area('Reports').click();
	await expect(page.locator('.dr-title')).toHaveText('Today');
	await signOut(page);

	// The Super Admin: the pay sheet, everyone's numbers; no Payment information of their own.
	await signInOwner(page);
	await openReports();
	await expect(area('Payment information')).toHaveCount(0);
	await area('Salary').click();
	const pia = page.getByRole('row', { name: 'Pia Newcomer' });
	await expect(pia).toContainText('18,000');
	await expect(pia).toContainText('01712345678');
	await expect(page.getByRole('row', { name: 'Max Member' })).toContainText('200');
	await expect(page.locator('.pay-notice')).toContainText('so far');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/pay-sheet.png', fullPage: true });
	noErrors();
});
