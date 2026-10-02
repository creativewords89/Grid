// My day and the people features (SPEC.md 6.10, 7.0, build step 19): leave request → approval,
// a leader's own leave, Who's out today, a day off, birthdays, shout-outs and a review request.
// Dates are relative to today; the team's weekly day off is moved away from them first.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, apiCall, openProject, signIn, signInOwner, signOut, signOutOwner, watchErrors } from './helpers.mjs';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plus = (n) => {
	const d = new Date();
	d.setDate(d.getDate() + n);
	return d;
};
const TODAY = ymd(plus(0));
const MONTH = new Date().toLocaleDateString('en-US', { month: 'long' });

test('my day: leave, days off, birthdays, shout-outs and review requests', async ({ page }) => {
	const noErrors = watchErrors(page);
	const strip = (text) => page.locator('.md-strip', { hasText: text });
	const box = (title) => page.locator('.md-card', { has: page.getByRole('heading', { name: title }) });
	const dlg = page.locator('dialog[open]');

	// Super Admin: the team's weekly day off is three days from now, so today … +2 are working days.
	await signInOwner(page);
	expect((await apiCall(page, 'PUT', 'days-off/weekly', { weekdays: [plus(3).getDay()] })).status).toBe(200);
	await expect(page.getByRole('heading', { name: 'Day leave' })).toHaveCount(0);
	await signOutOwner(page);

	// Team Member: sets a birthday (today) and asks for 3 days of leave starting today.
	await signIn(page, MAX);
	await expect(box('Day leave')).toContainText(`1 day left in ${MONTH}`);
	await expect(box('Shout-outs')).toContainText('No shout-outs yet');
	await page.locator('.me-btn').click();
	await page.locator('nav.ttabs').getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Birthday day').selectOption(pad(new Date().getDate()));
	await page.getByLabel('Birthday month').selectOption(pad(new Date().getMonth() + 1));
	await page.getByRole('button', { name: 'Save profile' }).click();
	await page.getByText('Profile saved').waitFor();

	await page.getByRole('button', { name: /GridRankers/ }).click();
	await expect(strip('Happy birthday, Max!')).toBeVisible();
	await box('Day leave').getByRole('button', { name: 'Request day leave' }).click();
	await dlg.getByLabel('Leave type').selectOption('day');
	await dlg.getByLabel('From').fill(TODAY);
	await dlg.getByLabel('To').fill(ymd(plus(2)));
	await expect(dlg.locator('.lv-sum')).toContainText('3 days');
	await dlg.getByLabel('Reason (optional)').fill('Family wedding');
	await dlg.getByRole('button', { name: 'Send request' }).click();
	await page.getByText('Leave requested').waitFor();
	await expect(box('Day leave')).toContainText('1 request waiting for an answer');
	await signOut(page);

	// Team Leader: sees the birthday and the request, approves it with a message, takes their own
	// leave (approved straight away) and sends Max a shout-out.
	await signIn(page, LEAD);
	await expect(strip('Today is Max Member’s birthday.')).toBeVisible();
	const asks = box('Needs your approval');
	await expect(asks).toContainText('Max Member');
	await expect(asks).toContainText('Day leave');
	await asks.getByRole('button', { name: 'Approve' }).first().click();
	await dlg.getByLabel('Message (optional)').fill('Enjoy the wedding!');
	await dlg.getByRole('button', { name: 'Approve' }).click();
	await page.getByText('Leave approved').waitFor();
	await expect(asks).toContainText('Nothing waiting for you');
	await expect(box('Who’s out today')).toContainText('Max Member');
	await expect(box('Who’s out today').locator('li', { hasText: 'Max Member' })).toContainText('On leave');

	await box('Day leave').getByRole('button', { name: 'Take day leave' }).click();
	await dlg.getByLabel('From').fill(TODAY);
	await dlg.getByLabel('To').fill(TODAY);
	await dlg.getByRole('button', { name: 'Take day leave' }).click();
	await page.getByText('approved straight away').first().waitFor();
	await expect(box('Day leave')).toContainText(`0 days left in ${MONTH}`);

	await page.getByRole('button', { name: 'Send shout-out' }).click();
	await dlg.getByLabel('To').selectOption({ label: 'Max Member' });
	await dlg.getByLabel('Message').fill('Great work on the Acme H1 fixes, the client loved it.');
	await dlg.getByRole('button', { name: 'Send' }).click();
	await page.getByText('Shout-out sent to Max Member').waitFor();

	// A leader's own finished task: done straight away, then sent to Max for a review.
	await openProject(page, 'Bright Dental');
	await page.getByRole('button', { name: 'Add task', exact: true }).click();
	await page.getByLabel('What needs to change').fill('Approve content plan');
	await page.locator('.pk2-list').getByText('Lee Lead').click();
	await page.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Task added').waitFor();
	const task = page.locator('article.mcard', { hasText: 'Approve content plan' });
	await task.getByRole('button', { name: 'Fixed' }).click();
	await task.getByRole('button', { name: 'Details' }).click();
	await dlg.getByRole('button', { name: 'Ask someone to review it' }).click();
	// It opens inside the Details dialog: take the innermost open dialog.
	const ask = page.locator('dialog[open]').last();
	await expect(ask.getByRole('heading', { name: 'Ask someone to review it' })).toBeVisible();
	await ask.getByLabel('Reviewer', { exact: true }).selectOption({ label: 'Max Member · Team Member' });
	await ask.getByLabel('Note for the reviewer (optional)').fill('Please check the October topics');
	await ask.getByRole('button', { name: 'Send for review' }).click();
	await page.getByText('Sent to Max Member for review').waitFor();
	await page.keyboard.press('Escape');
	await signOut(page);

	// Super Admin: both are out today; adds today as an event day off.
	await signInOwner(page);
	await expect(box('Who’s out today').locator('li', { hasText: 'Lee Lead' })).toContainText('On leave');
	await expect(box('Needs your approval')).toContainText('Approve content plan', { timeout: 15000 });
	await page.locator('.me-btn').click();
	await page.locator('nav.ttabs').getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Day off name').fill('Founders Day');
	await page.getByLabel('Date', { exact: true }).fill(TODAY);
	await page.getByRole('button', { name: '+ Add day off' }).click();
	await page.getByText('Founders Day added').waitFor();
	// The reviewer was asked by name: the Super Admin may decide it, but leaves it to Max here.
	await page.locator('nav.ttabs').getByRole('tab', { name: /^Leave/ }).click();
	await expect(page.locator('tr', { hasText: 'Max Member' })).toContainText('Approved');
	await expect(page.locator('#leaveReport')).toContainText('Max Member');
	await signOutOwner(page);

	// Team Member: the answer, the day off, the shout-out and the review request.
	await signIn(page, MAX);
	await expect(strip('Your leave for')).toContainText('Enjoy the wedding!');
	await expect(strip('Founders Day')).toBeVisible();
	await expect(box('Day leave')).toContainText(`0 days left in ${MONTH}`);
	await expect(box('Shout-outs')).toContainText('Great work on the Acme H1 fixes');
	await expect(box('Shout-outs')).toContainText('Lee Lead → you');
	const review = strip('Lee Lead asked you to review “Approve content plan”.');
	await expect(review).toContainText('Please check the October topics');
	await review.getByRole('button', { name: 'Review now' }).click();
	await page.locator('article.mcard', { hasText: 'Approve content plan' }).getByRole('button', { name: 'Details' }).click();
	await dlg.getByRole('button', { name: 'Approve' }).click();
	await page.getByText('Accepted').first().waitFor();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: /GridRankers/ }).click();
	await expect(strip('asked you to review')).toHaveCount(0);

	// Dismissed strips stay dismissed.
	await strip('Founders Day').getByRole('button', { name: 'Thanks' }).click();
	await expect(strip('Founders Day')).toHaveCount(0);
	await page.reload();
	await expect(page.locator('.md-top h1')).toBeVisible();
	await expect(strip('Founders Day')).toHaveCount(0);

	// Leave privacy: Max sees no one else's leave type or reason over the API.
	const sync = (await apiCall(page, 'GET', 'sync')).json;
	const others = sync.changes.leave.filter((l) => l.member_id !== 'tm_max');
	expect(others.length).toBeGreaterThan(0);
	for (const l of others) expect(Object.keys(l).sort()).toEqual(['from_date', 'id', 'member_id', 'status', 'to_date', 'updated_at']);
	expect((await apiCall(page, 'GET', 'leave/report')).status).toBe(403);
	await signOut(page);
	noErrors();
});
