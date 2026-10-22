// Holidays (SPEC.md 6.10, 6.20, designs HOL-1 to HOL-3, HOL-8B2, HOL-9A, HOL-10): the Super Admin adds a festival holiday
// and makes Nia contractual; Nia sees he has no leave days; Max sees his yearly leave and asks
// for sick leave; the Team Leader approves it from Waiting for you.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, openTeam, signIn, signInOwner, signOut, signOutOwner, waiting, watchErrors } from './helpers.mjs';

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
	// Design HOL-11B2: everyone's days left (5 a page, search), no Waiting for you, the Add box.
	const everyone = page.getByRole('region', { name: 'Everyone’s leave' });
	await expect(everyone).toContainText(/\d+–\d+ of \d+ · fewest days left first/);
	expect(await everyone.locator('.ev-r:not(.ev-th)').count()).toBeLessThanOrEqual(5);
	await everyone.getByLabel('Search a person').fill('Max');
	await expect(everyone.locator('.ev-r:not(.ev-th)')).toHaveCount(1);
	await expect(everyone.locator('.ev-r:not(.ev-th)')).toContainText('Max Member');
	await everyone.getByLabel('Search a person').fill('');
	await expect(page.getByRole('region', { name: 'Waiting for you' })).toHaveCount(0);
	await expect(page.locator('.dr-top-end .hol-nav')).toBeVisible();
	const festival = page.getByRole('region', { name: 'Festival holidays' });
	const add = page.getByRole('region', { name: 'Add' });
	await add.getByRole('button', { name: 'Add holiday' }).click();
	await dlg.getByLabel('Name').fill('Victory Day');
	await dlg.getByLabel('Date').fill(HOLI);
	await expect(dlg.locator('.lv-sum')).toContainText('of 13 festival days set');
	await dlg.getByRole('button', { name: 'Add holiday' }).click();
	await page.getByText('Victory Day added').waitFor();
	await expect(festival).toContainText('Victory Day');
	// Add sick leave for someone: approved straight away.
	await add.getByRole('button', { name: 'Add sick leave' }).click();
	await dlg.getByRole('radio', { name: /Ray Reporter/ }).click();
	await dlg.getByLabel('From').fill(ymd(plus(30)));
	await dlg.getByLabel('To').fill(ymd(plus(30)));
	await dlg.getByRole('button', { name: 'Add leave' }).click();
	await page.getByText('Sick leave added for Ray Reporter').waitFor();

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
	// Leave days a year (HOL-10): 12 casual days this year, then back to 10.
	const days = page.getByRole('region', { name: 'Leave days a year' });
	await days.getByRole('button', { name: 'More casual leave days' }).click();
	await days.getByRole('button', { name: 'More casual leave days' }).click();
	await expect(days).toContainText('Casual leave 10 → 12');
	await days.getByRole('group', { name: 'Starts' }).getByRole('button', { name: /^This year/ }).click();
	await days.getByRole('button', { name: 'Save' }).click();
	await page.getByText(/^Leave days saved for \d{4}$/).waitFor();
	await expect(system).toContainText('12 casual');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/leave-days.png', fullPage: true });
	await days.getByLabel('Casual leave days a year').fill('10');
	await days.getByRole('button', { name: 'Save' }).click();
	await expect(system).toContainText('10 casual');
	await signOutOwner(page);

	// Nia, contractual: no leave days, leave is unpaid; the holiday is still hers.
	await signIn(page, 'NIACODE11');
	await openHolidays();
	const nias = page.getByRole('region', { name: 'My leave' });
	await expect(nias).toContainText('You don’t have leave days');
	await expect(nias).toContainText('Contractual');
	await expect(nias.getByRole('button', { name: 'Request unpaid leave' })).toBeVisible();
	// Festival holidays are hers too (13 a year).
	await expect(nias.getByRole('region', { name: 'Festival holidays' })).toContainText('of 13 left');
	await signOut(page);

	// Max, full-time (design HOL-8B2): rings with the days left of 10 casual, 14 sick and 13 festival
	// holidays, his balance in money; taps days on the calendar and asks for sick leave.
	await signIn(page, MAX);
	await openHolidays();
	const mine = page.getByRole('region', { name: 'My leave' });
	await expect(mine.getByRole('region', { name: 'Casual leave' })).toContainText('of 10 left');
	await expect(mine.getByRole('region', { name: 'Sick leave' })).toContainText('of 14 left');
	await expect(mine.getByRole('region', { name: 'Festival holidays' })).toContainText('of 13 left');
	await expect(page.getByRole('region', { name: 'Your balance if not taken' })).toContainText('BDT');
	// Tapping a day on the calendar fills in the dates of the request.
	const pickable = page.locator('button.hol-day');
	const tapped = (await pickable.count()) > 0;
	if (tapped) {
		await pickable.first().click();
		await expect(mine.getByRole('button', { name: /Request leave · 1 day picked/ })).toBeVisible();
	}
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/holidays-member.png', fullPage: true });
	await mine.getByRole('button', { name: /Request leave/ }).click();
	const request = page.locator('dialog[open]');
	if (tapped) await expect(request.getByLabel('From')).not.toHaveValue('');
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

	// Team Leader: approves it on My day (Holidays has no Waiting for you, HOL-11B2).
	await signIn(page, LEAD);
	const asks = await waiting(page);
	await asks.locator('.ap-item', { hasText: 'Max Member asks for sick leave' }).first().getByRole('button', { name: 'Approve' }).click();
	await dlg.getByRole('button', { name: 'Approve' }).click();
	await page.getByText('Leave approved').waitFor();
	// Team Leader (design TL-B): Team holidays for the team; My holidays only theirs.
	await page.locator('aside').getByRole('button', { name: 'Daily reports' }).click();
	const teamHol = page.getByRole('tablist', { name: 'My team' }).getByRole('tab', { name: /^Team holidays/ });
	await page.getByRole('tablist', { name: 'Mine' }).getByRole('tab', { name: 'My holidays' }).click();
	await expect(page.getByRole('region', { name: 'My leave' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Waiting for you' })).toHaveCount(0);
	await expect(page.locator('.hol-cal .hol-chip.out')).toHaveCount(0);
	await teamHol.click();
	await page.locator('.hol').waitFor();
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/tl-team-holidays.png' });
	await expect(page.getByRole('region', { name: 'Everyone’s leave' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Waiting for you' })).toHaveCount(0);
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
	await expect(first.getByRole('region', { name: 'Casual leave' })).toContainText(`of ${Math.floor((10 * months) / 12 + 0.5)} left`);
	await expect(first.getByRole('region', { name: 'Sick leave' })).toContainText(`of ${Math.floor((14 * months) / 12 + 0.5)} left`);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/holidays-joiner.png', fullPage: true });
	await signOut(page);

	// Effective from (HOL-9A): the Super Admin moves Nia's start to Jan 1, so her whole year counts.
	await signInOwner(page);
	await openTeam(page, 'Admin settings');
	const sys = page.getByRole('region', { name: 'Holiday system' });
	const niaRow = sys.getByRole('row', { name: /Nia/ });
	await expect(niaRow).toContainText(months === 12 ? 'Full year' : `${months} months`);
	await sys.getByLabel(/^Effective from for Nia/).fill(`${new Date().getFullYear()}-01-01`);
	await page.getByText(/^Nia .+’s leave counts from /).waitFor();
	await expect(niaRow).toContainText('Full year');
	await expect(niaRow).toContainText('10/10');
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/holiday-system.png', fullPage: true });
	await signOutOwner(page);
	noErrors();
});
