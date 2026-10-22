// Holidays (SPEC.md 6.10, 6.20, designs HOL-1 to HOL-3): the Super Admin adds a festival holiday
// and makes Nia contractual; Nia sees he has no leave days; Max sees his yearly leave and asks
// for sick leave; the Team Leader approves it from Waiting for you.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, openTeam, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

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

	await expect(page.getByRole('region', { name: 'Holiday system' })).toHaveCount(0);
	await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Year' }).click();
	await expect(page.locator('.hol-mini')).toHaveCount(12);
	await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Month' }).click();
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/holidays-admin.png', fullPage: true });

	// Holiday system is in Admin settings: everyone's days left and the employment picker.
	await openTeam(page, 'Admin settings');
	const system = page.getByRole('region', { name: 'Holiday system' });
	await expect(system).toContainText('10 casual');
	// (An earlier spec may have renamed Nia.)
	await system.getByLabel(/^Employment of Nia/).selectOption('contractual');
	await page.getByText(/^Nia .+ is now Contractual$/).waitFor();
	await expect(system.locator('.hol-none')).toContainText('Nia');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/holiday-system.png', fullPage: true });
	await signOutOwner(page);

	// Nia, contractual: no leave days, leave is unpaid; the holiday is still hers.
	await signIn(page, 'NIACODE11');
	await openHolidays();
	const nias = page.getByRole('region', { name: 'My leave' });
	await expect(nias).toContainText('You don’t have leave days');
	await expect(nias).toContainText('Contractual');
	await expect(nias.getByRole('button', { name: 'Request unpaid leave' })).toBeVisible();
	// Festival holidays are hers too (13 a year).
	await expect(nias.getByRole('region', { name: 'Festival holidays' })).toContainText('13');
	await signOut(page);

	// Max, full-time (design HOL-6): total · taken · left for casual (10), sick (14) and festival
	// holidays (13), nothing to click; his balance in money; asks for sick leave from Request leave.
	await signIn(page, MAX);
	await openHolidays();
	const mine = page.getByRole('region', { name: 'My leave' });
	const total = (name) => mine.getByRole('region', { name }).locator('.bal-nums > span').first().locator('b');
	await expect(total('Casual leave')).toHaveText('10');
	await expect(total('Sick leave')).toHaveText('14');
	await expect(total('Festival holidays')).toHaveText('13');
	await expect(mine.getByRole('button')).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Your balance if not taken' })).toContainText('BDT');
	const request = page.getByRole('region', { name: 'Request leave' });
	// Tapping a day on the calendar fills in the dates.
	const pickable = page.locator('button.hol-day');
	if (await pickable.count()) {
		await pickable.first().click();
		await expect(request.getByLabel('From')).not.toHaveValue('');
	}
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/holidays-member.png', fullPage: true });
	// Just the type, the dates and a reason if there is one.
	await request.getByLabel('Type of leave').selectOption('sick');
	await request.getByLabel('From').fill(SICK_FROM);
	await request.getByLabel('To').fill(SICK_TO);
	await request.getByLabel('Reason (optional)').fill('Doctor');
	await request.getByRole('button', { name: 'Send request' }).click();
	await page.getByText('Leave requested').waitFor();
	const requests = page.getByRole('region', { name: 'My requests' });
	await expect(requests.locator('.hol-li', { hasText: 'Sick leave' }).first()).toContainText('Waiting');
	await signOut(page);

	// Team Leader: approves it from Waiting for you.
	// Team Leader (design TL-B): Team holidays (counting the request) for the team; My holidays only theirs.
	await signIn(page, LEAD);
	await page.locator('aside').getByRole('button', { name: 'Daily reports' }).click();
	const teamHol = page.getByRole('tablist', { name: 'My team' }).getByRole('tab', { name: /^Team holidays/ });
	await expect(teamHol).toContainText(/\d/);
	await page.getByRole('tablist', { name: 'Mine' }).getByRole('tab', { name: 'My holidays' }).click();
	await expect(page.getByRole('region', { name: 'My leave' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Waiting for you' })).toHaveCount(0);
	await expect(page.locator('.hol-cal .hol-chip.out')).toHaveCount(0);
	await teamHol.click();
	await page.locator('.hol').waitFor();
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/tl-team-holidays.png' });
	const waiting = page.getByRole('region', { name: 'Waiting for you' });
	const ask = waiting.locator('.hol-req', { hasText: 'Max Member' }).filter({ hasText: 'Sick leave' }).first();
	await expect(ask).toContainText('Sick leave');
	const before = await waiting.locator('.hol-req').count();
	await ask.getByRole('button', { name: 'Approve' }).click();
	await dlg.getByRole('button', { name: 'Approve' }).click();
	await page.getByText('Leave approved').waitFor();
	await expect(waiting.locator('.hol-req')).toHaveCount(before - 1);
	// Their own leave is not on the team tab; there is no employment picker for them.
	await expect(page.getByRole('region', { name: 'My leave' })).toHaveCount(0);
	await expect(page.getByLabel('Employment of Max Member')).toHaveCount(0);
	await signOut(page);

	// Nia made Full-Time today: her first year is prorated from today (HOL-5).
	await signInOwner(page);
	await openTeam(page, 'Admin settings');
	await page.getByRole('region', { name: 'Holiday system' }).getByLabel(/^Employment of Nia/).selectOption('full_time');
	await page.getByText(/^Nia .+ is now Full-Time$/).waitFor();
	await signOutOwner(page);
	await signIn(page, 'NIACODE11');
	await openHolidays();
	const first = page.getByRole('region', { name: 'My leave' });
	// HOL-5B: the year as a timeline from the day she started, a square per day, this year and next.
	await expect(page.getByRole('region', { name: `Your ${new Date().getFullYear()}` })).toContainText('You joined');
	await expect(page.getByRole('region', { name: 'Days this year' })).toContainText('of 10 a full year');
	const months = 12 - new Date().getMonth();
	const firstTotal = (name) => first.getByRole('region', { name }).locator('.bal-nums > span').first().locator('b');
	await expect(firstTotal('Casual leave')).toHaveText(String(Math.floor((10 * months) / 12 + 0.5)));
	await expect(firstTotal('Sick leave')).toHaveText(String(Math.floor((14 * months) / 12 + 0.5)));
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/holidays-joiner.png', fullPage: true });
	await signOut(page);
	noErrors();
});
