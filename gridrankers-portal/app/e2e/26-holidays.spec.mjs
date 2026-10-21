// Holidays (SPEC.md 6.10, 6.20, designs HOL-1 to HOL-3): the Super Admin adds a festival holiday
// and makes Nia contractual; Nia sees he has no leave days; Max sees his yearly leave and asks
// for sick leave; the Team Leader approves it from Waiting for you.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plus = (n) => {
	const d = new Date();
	d.setDate(d.getDate() + n);
	return d;
};
// A holiday 9 days ahead in this year (tomorrow near the year end), not on a Friday; sick leave after it.
const ahead = plus(9).getFullYear() === new Date().getFullYear() ? 9 : 1;
const HOLI = ymd(plus(plus(ahead).getDay() === 5 ? ahead + 1 : ahead));
const SICK_FROM = ymd(plus(12));
const SICK_TO = ymd(plus(14));

test('holidays', async ({ page }) => {
	const noErrors = watchErrors(page);
	const dlg = page.locator('dialog[open]');
	const openHolidays = async () => {
		await page.locator('aside').getByRole('button', { name: 'Daily reports' }).click();
		await page.getByRole('tablist', { name: 'Daily reports and pay' }).getByRole('tab', { name: 'Holidays' }).click();
		await page.locator('.hol').waitFor();
	};

	// Super Admin: the tiles, a new festival holiday, Nia made contractual.
	await signInOwner(page);
	await openHolidays();
	await expect(page.getByRole('region', { name: 'This month' })).toContainText(/\d+ of 13/);
	await expect(page.locator('.dr-top-end .hol-nav')).toBeVisible();
	const festival = page.getByRole('region', { name: 'Festival holidays' });
	await festival.getByRole('button', { name: '+ Add holiday' }).click();
	await dlg.getByLabel('Name').fill('Victory Day');
	await dlg.getByLabel('Date').fill(HOLI);
	await expect(dlg.locator('.lv-sum')).toContainText('of 13 festival days set');
	await dlg.getByRole('button', { name: 'Add holiday' }).click();
	await page.getByText('Victory Day added').waitFor();
	await expect(festival).toContainText('Victory Day');

	const system = page.getByRole('region', { name: 'Holiday system' });
	await expect(system).toContainText('10 casual');
	// (An earlier spec may have renamed Nia.)
	await system.getByLabel(/^Employment of Nia/).selectOption('contractual');
	await page.getByText(/^Nia .+ is now Contractual$/).waitFor();
	await expect(system.locator('.hol-none')).toContainText('Nia');
	await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Year' }).click();
	await expect(page.locator('.hol-mini')).toHaveCount(12);
	await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Month' }).click();
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/holidays-admin.png', fullPage: true });
	await signOutOwner(page);

	// Nia, contractual: no leave days, leave is unpaid; the holiday is still hers.
	await signIn(page, 'NIACODE11');
	await openHolidays();
	const nias = page.getByRole('region', { name: 'My leave' });
	await expect(nias).toContainText('You don’t have leave days');
	await expect(nias).toContainText('Contractual');
	await expect(nias.getByRole('button', { name: 'Request unpaid leave' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Upcoming holidays' })).toContainText('Victory Day');
	await signOut(page);

	// Max, full-time: casual and sick days left of 10 and 14; asks for sick leave.
	await signIn(page, MAX);
	await openHolidays();
	const mine = page.getByRole('region', { name: 'My leave' });
	await expect(mine).toContainText('Full-Time');
	await expect(mine).toContainText(/of 10 days left/);
	await expect(mine).toContainText(/of 14 days left/);
	await expect(mine).toContainText(`Starts again on Jan 1, ${+HOLI.slice(0, 4) + 1}`);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/holidays-member.png', fullPage: true });
	await mine.getByRole('button', { name: 'Request leave' }).click();
	await dlg.getByLabel('Leave type').selectOption('sick');
	await expect(dlg.getByLabel('Leave type')).toContainText(/Sick · \d+ of 14 left/);
	await dlg.getByLabel('From').fill(SICK_FROM);
	await dlg.getByLabel('To').fill(SICK_TO);
	await dlg.getByLabel('Reason (optional)').fill('Doctor');
	await dlg.getByRole('button', { name: 'Send request' }).click();
	await page.getByText('Leave requested').waitFor();
	const requests = page.getByRole('region', { name: 'My requests' });
	await expect(requests.locator('.hol-li', { hasText: 'Sick leave' }).first()).toContainText('Waiting');
	await signOut(page);

	// Team Leader: approves it from Waiting for you.
	await signIn(page, LEAD);
	await openHolidays();
	const waiting = page.getByRole('region', { name: 'Waiting for you' });
	const ask = waiting.locator('.hol-req', { hasText: 'Max Member' }).filter({ hasText: 'Doctor' });
	await expect(ask).toContainText('Sick leave');
	await ask.getByRole('button', { name: 'Approve' }).click();
	await dlg.getByRole('button', { name: 'Approve' }).click();
	await page.getByText('Leave approved').waitFor();
	await expect(waiting.locator('.hol-req', { hasText: 'Doctor' })).toHaveCount(0);
	// The Team Leader's own leave sits on top; there is no employment picker for them.
	await expect(page.getByRole('region', { name: 'My leave' })).toBeVisible();
	await expect(page.getByLabel('Employment of Max Member')).toHaveCount(0);
	await signOut(page);
	noErrors();
});
