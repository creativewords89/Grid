// Invoices (SPEC.md 6.14, designs TR-A and TR-B): the Super Admin's own record of what is billed
// and paid. "Cycle Co" ended a cycle yesterday, so it has a line To send and a daily reminder;
// the Super Admin sets a fee, ticks Invoice sent, records two part payments, and sees it Paid.
// Team Leaders don't see Invoices at all.
import { test, expect } from '@playwright/test';
import { LEAD, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

test('invoices tracker', async ({ page }) => {
	const noErrors = watchErrors(page);
	const side = page.locator('aside .side-link', { hasText: 'Invoices' });
	const dlg = page.locator('dialog[open]');
	const nf = page.locator('.md-card', { has: page.getByRole('heading', { name: 'Notifications' }) });

	// Team Leader: no Invoices link.
	await signIn(page, LEAD);
	await expect(page.locator('aside .side-link', { hasText: 'General tasks' })).toBeVisible();
	await expect(side).toHaveCount(0);
	await signOut(page);

	// Super Admin: the daily reminder in Notifications opens Invoices.
	await signInOwner(page);
	const reminder = nf.locator('.nf-must-item', { hasText: 'Cycle Co: send the invoice for' });
	await expect(reminder).toBeVisible();
	await page.locator('.md-bell-btn').click();
	await expect(page.locator('.md-pop li.must.new', { hasText: 'Cycle Co: send the invoice for' })).toHaveCount(1);
	await page.locator('.md-bell-btn').click();
	await reminder.getByRole('button', { name: 'Open invoices' }).click();
	await expect(page.locator('.top h1')).toHaveText('Invoices');
	await expect(side).toHaveAttribute('aria-current', 'page');

	const row = page.locator('.bl-row', { hasText: 'Cycle Co' });
	await expect(row.locator('.bl-tag')).toHaveText('To send');
	await expect(page.locator('.bl-tile', { hasText: 'To send' })).toContainText('Cycle Co');

	// ⚙ Fees: the fee fills in the amount of the cycle not sent yet; reminder 3 days by default.
	await page.getByRole('button', { name: '⚙ Fees' }).click();
	await expect(dlg.getByLabel('Reminder days · Cycle Co')).toHaveValue('3');
	await dlg.getByLabel('Fee · Cycle Co').fill('500');
	await dlg.getByRole('button', { name: 'Save fees' }).click();
	await expect(row).toContainText('$500');

	// Tick Invoice sent: Waiting, and the reminder is gone.
	await row.getByLabel('Invoice sent · Cycle Co').click();
	await page.getByText('Cycle Co: invoice marked as sent').waitFor();
	await expect(row.locator('.bl-tag')).toContainText('Waiting · sent');

	// Payment received: a part payment by bKash.
	await row.getByLabel('Payment received · Cycle Co').click();
	await expect(dlg.getByLabel(/^Amount/)).toHaveValue('500');
	await dlg.getByLabel(/^Amount/).fill('200');
	await dlg.getByRole('button', { name: 'bKash' }).click();
	await dlg.getByLabel(/^Reference/).fill('TX-77');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/invoice-payment.png' });
	await dlg.getByRole('button', { name: 'Save' }).click();
	await expect(row.locator('.bl-tag')).toHaveText('Partly paid · $300 left');
	await expect(row).toContainText('$200 of $500');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/invoices.png' });

	// Open › : the payment is listed; the rest arrives → Paid.
	await row.getByRole('button', { name: /^Open Cycle Co/ }).click();
	await expect(dlg.locator('.bl-pays')).toContainText('$200');
	await expect(dlg.locator('.bl-pays')).toContainText('bKash · TX-77');
	await dlg.getByRole('button', { name: '+ Record payment' }).click();
	const pay = page.getByRole('dialog', { name: 'Payment received · Cycle Co' });
	await expect(pay.getByLabel(/^Amount/)).toHaveValue('300');
	await pay.getByRole('button', { name: 'Save' }).click();
	await page.getByText('Cycle Co: payment recorded').last().waitFor();
	const bill = page.getByRole('dialog', { name: /^Cycle Co · / });
	await expect(bill.locator('.bl-pays li')).toHaveCount(2);
	await bill.getByRole('button', { name: 'Close' }).click();
	await expect(row.locator('.bl-tag')).toHaveText('Paid');
	await expect(row.getByLabel('Payment received · Cycle Co')).toBeChecked();

	// Year view: the cycle's cell is Paid, nothing owed.
	await page.locator('.bl-seg').getByRole('button', { name: 'Year view' }).click();
	const year = page.locator('.bl-yrow', { hasText: 'Cycle Co' });
	await expect(year.locator('button.bl-cell')).toHaveText('Paid');
	await expect(year.locator('.bl-owed')).toHaveText('—');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/invoices-year.png' });

	// The reminder is gone from My day.
	await page.locator('aside .side-link', { hasText: 'My day' }).click();
	await expect(nf.locator('.nf-must-item', { hasText: 'Cycle Co: send the invoice' })).toHaveCount(0);
	await signOutOwner(page);
	noErrors();
});
