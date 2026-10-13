// Daily reports (SPEC.md 6.18, designs DR-A to DR-D): Max writes what he did (with a file and a
// link) and sends it on the way out; Lee reads the team's day, reminds Nia and opens Max's days;
// Ray, who closed the browser without a report, sends it before anything else; the Super Admin
// only reads.
import { test, expect } from '@playwright/test';
import { LEAD, MAX, signIn, signInOwner, signOut, watchErrors } from './helpers.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('daily reports', async ({ page }) => {
	const noErrors = watchErrors(page);
	const dlg = page.locator('dialog[open]').last();
	const openReports = () => page.locator('aside').getByRole('button', { name: 'Daily reports' }).click();

	// Max: Daily reports → Today → + Add work (details, project, time, a file and a link).
	await signIn(page, MAX);
	await openReports();
	await expect(page.locator('.dr-title')).toHaveText('Today');
	await expect(page.getByRole('tab', { name: 'Team' })).toHaveCount(0);
	// Earlier specs may have given Max leave today, or today may be the team's day off: then no
	// report is owed (he can still send one) and Sign out doesn't ask.
	await page.locator('.dr-status').waitFor();
	const away = await page.locator('.dr-status').getByText(/no report needed/).isVisible();
	if (!away) await expect(page.locator('.dr-status')).toContainText('Not sent');
	await page.getByRole('button', { name: '+ Add work' }).click();
	await dlg.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(dlg.locator('.err')).toHaveText('Write what you did.');
	await dlg.getByLabel('What did you do?').fill('Site audit — speed and mobile');
	await dlg.getByLabel('Details').fill('Checked 14 pages on PageSpeed; listed 6 fixes.');
	await dlg.getByLabel('Project').selectOption({ label: 'Acme Plumbing' });
	await dlg.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(dlg.locator('.err')).toHaveText('Add the time spent.');
	await dlg.getByRole('group', { name: 'Time spent' }).getByRole('button', { name: 'Other' }).click();
	await dlg.getByLabel('Hours').fill('1');
	await dlg.getByLabel('Minutes').fill('15');
	await dlg.getByLabel('Entry files').setInputFiles({ name: 'audit.png', mimeType: 'image/png', buffer: PNG });
	await expect(dlg.locator('.dr-att')).toContainText('audit.png');
	await dlg.getByRole('button', { name: '🔗 Add link' }).click();
	await dlg.getByLabel('Link', { exact: true }).fill('ftp://nope');
	await dlg.getByRole('button', { name: 'Add', exact: true }).first().click();
	await expect(dlg.locator('.err')).toHaveText('The link should start with https://');
	await dlg.getByLabel('Link', { exact: true }).fill('https://docs.google.com/document/d/abc');
	await dlg.getByLabel('Link name').fill('Audit doc');
	await dlg.locator('.dr-link').getByRole('button', { name: 'Add' }).click();
	await expect(dlg.locator('.dr-att')).toContainText('Audit doc');
	if (process.env.SHOTS) await dlg.screenshot({ path: process.env.SHOTS + '/dr-add.png' });
	await dlg.locator('.dlg-acts').getByRole('button', { name: 'Add', exact: true }).click();

	const row = page.locator('.dr-row', { hasText: 'Site audit' });
	await expect(row.locator('.dr-row-m')).toHaveText('1h 15m');
	await expect(row).toContainText('Acme Plumbing');
	await expect(row.getByRole('link', { name: '🔗 Audit doc' })).toHaveAttribute('href', 'https://docs.google.com/document/d/abc');
	await page.getByRole('button', { name: '+ Add work' }).click();
	await dlg.getByLabel('What did you do?').fill('Team meeting');
	await dlg.getByLabel('Project').selectOption({ label: 'Office' });
	await dlg.getByRole('group', { name: 'Time spent' }).getByRole('button', { name: '30m' }).click();
	await dlg.locator('.dlg-acts').getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.locator('.dr-sum')).toHaveText('2 entries · 1h 45m');
	await page.getByLabel('Anything blocking you?').fill('Waiting for Bright Dental’s logins.');
	await page.waitForTimeout(1000);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/dr-mine.png' });

	// Sign out asks for the report on a working day: Send report and sign out.
	if (away) {
		await page.getByRole('button', { name: 'Send report' }).click();
		await page.getByText('Report sent').waitFor();
		await signOut(page);
	} else {
		await page.getByRole('button', { name: 'Sign out', exact: true }).click();
		await expect(dlg.getByRole('heading', { name: 'Before you sign out' })).toBeVisible();
		await expect(dlg.locator('.dr-row')).toHaveCount(2);
		if (process.env.SHOTS) await dlg.screenshot({ path: process.env.SHOTS + '/dr-signout.png' });
		await dlg.getByRole('button', { name: 'Send report and sign out' }).click();
		await page.getByText('Sign in to continue').waitFor();
	}

	// Lee: Team tab — Max sent (with his blocker), Nia not sent → Remind; Max's days.
	await signIn(page, LEAD);
	await openReports();
	await page.getByRole('tab', { name: 'Team' }).click();
	const max = page.locator('article.dr-card', { hasText: 'Max Member' });
	await expect(max.locator('.dr-badge')).toContainText('Sent');
	await expect(max.locator('.dr-row')).toHaveCount(2);
	await expect(max).toContainText('Waiting for Bright Dental’s logins.');
	await expect(page.locator('article.dr-card', { hasText: 'Grid Owner' })).toHaveCount(0);
	const nia = page.locator('article.dr-card', { hasText: 'Nia' });
	const reminded = (await nia.locator('.dr-badge').textContent()) === 'Not sent';
	if (reminded) {
		await nia.getByRole('button', { name: 'Remind' }).click();
		await page.getByText(/Reminder sent to Nia/).waitFor();
	}
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/dr-team.png' });
	await max.getByRole('button', { name: /Max Member/ }).click();
	await expect(page.locator('.dr-person-h h2')).toHaveText('Max Member');
	await expect(page.locator('.dr-d[aria-pressed="true"]')).toHaveClass(/has/);
	await expect(page.locator('.dr-dayreport .dr-row')).toHaveCount(2);
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/dr-person.png' });
	await page.getByRole('button', { name: '‹ Team reports' }).click();
	await signOut(page);

	// Nia gets the reminder as a notice.
	if (reminded) {
		await signIn(page, 'NIACODE11');
		await expect(page.locator('.nf-item', { hasText: 'Lee Lead → you: Please send your daily report' })).toBeVisible();
		await signOut(page);
	}

	// Ray closed the browser without a report: he sends it before using the portal (marked Late).
	await page.goto('/');
	await page.getByLabel('Your code').fill('RAYCODE11');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { name: /report is missing/ })).toBeVisible();
	await expect(page.locator('aside')).toHaveCount(0);
	await page.getByRole('button', { name: /^Send/ }).click();
	await expect(page.locator('.dr-missing .err')).toHaveText('Add at least one thing you did.');
	await page.getByRole('button', { name: '+ Add work' }).click();
	await dlg.getByLabel('What did you do?').fill('Citations for Bright Dental');
	await dlg.getByRole('group', { name: 'Time spent' }).getByRole('button', { name: '2h' }).click();
	await dlg.locator('.dlg-acts').getByRole('button', { name: 'Add', exact: true }).click();
	if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/dr-missing.png' });
	await page.getByRole('button', { name: /^Send/ }).click();
	await page.getByText('Shared with your team · live').waitFor();
	await expect(page.getByRole('heading', { name: /report is missing/ })).toHaveCount(0);
	await page.context().clearCookies();

	// The Super Admin reads every report but writes none: Team only.
	await signInOwner(page);
	await openReports();
	await expect(page.getByRole('tab', { name: 'My reports' })).toHaveCount(0);
	await expect(page.locator('article.dr-card', { hasText: 'Lee Lead' })).toBeVisible();
	await expect(page.locator('article.dr-card', { hasText: 'Max Member' }).locator('.dr-badge')).toContainText('Sent');
	noErrors();
});
