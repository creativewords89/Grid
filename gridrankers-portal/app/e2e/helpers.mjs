// Shared steps for the e2e specs. Codes and names come from site/install.php.
import { expect } from '@playwright/test';

export const LEAD = 'LEADCODE1';
export const MAX = 'MAXCODE11';

const live = (page) => page.getByText('Shared with your team · live').waitFor({ timeout: 15000 });

// Fails the test on any uncaught error or console error on the portal page, other than expected
// 401/403 responses (wp-admin and wp-login load things this test site can't serve).
export function watchErrors(page) {
	const errors = [];
	const onPortal = () => !/\/wp-(admin|login)/.test(page.url());
	const add = (msg) => {
		console.log(`[browser] ${msg}`); // shows up in the CI log
		errors.push(msg);
	};
	page.on('pageerror', (e) => onPortal() && add(`pageerror: ${e.message}`));
	page.on('console', (m) => {
		if (onPortal() && m.type() === 'error' && !/401|403/.test(m.text())) add(`console: ${m.text()}`);
	});
	page.on('requestfailed', (r) => {
		const why = r.failure()?.errorText || '';
		if (!onPortal()) return;
		// Leaving the page cancels requests still in flight (ERR_ABORTED): logged, not an error.
		if (why.includes('ERR_ABORTED')) console.log(`[browser] cancelled: ${r.url()}`);
		else add(`request failed: ${r.url()} ${why}`);
	});
	return () => expect(errors).toEqual([]);
}

export async function signIn(page, code) {
	await page.goto('/');
	await page.getByLabel('Your code').fill(code);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await live(page);
}

export async function signOut(page) {
	await page.getByRole('button', { name: 'Sign out' }).click();
	await page.getByText('Sign in to continue').waitFor();
}

// Super Admin: WordPress login (owner is linked to tm_owner).
export async function signInOwner(page) {
	await page.goto('/wp-login.php');
	// wp-login.php clears and focuses the username field ~200 ms after load (wp_attempt_focus):
	// let that happen first, then check both fields before submitting.
	await page.waitForLoadState('load');
	await page.waitForTimeout(400);
	await page.locator('#user_login').fill('owner');
	await page.locator('#user_pass').fill('owner-pass-123');
	await expect(page.locator('#user_login')).toHaveValue('owner');
	await expect(page.locator('#user_pass')).toHaveValue('owner-pass-123');
	await page.locator('#wp-submit').click();
	await page.waitForURL(/wp-admin|\/$/);
	await page.goto('/');
	await live(page);
}

export async function signOutOwner(page) {
	await page.context().clearCookies();
}

// Dashboard → Projects tab (Super Admin, Team Leader).
export async function openProjectsTab(page) {
	await page.locator('.md-tabs').getByRole('tab', { name: /^Projects/ }).click();
	await page.locator('.pd-tabs').waitFor();
}

export const card = (page, title) => page.locator('article.mcard', { hasText: title });

// Sidebar project → its Meeting Minutes (everyone lands on the Dashboard after signing in).
export async function openProject(page, name) {
	await page.locator('button.pick', { hasText: name }).click();
	await expect(page.locator('.top h1')).toHaveText(new RegExp(`^${name}`));
}

export async function addMeetingTask(page, title, assignee) {
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await page.getByRole('button', { name: 'Add task', exact: true }).click();
	await page.getByLabel('What needs to change').fill(title);
	await page.locator('.pk2-list').getByText(assignee).click();
	await page.getByRole('button', { name: 'Save task' }).click();
	await page.getByText('Task added').waitFor();
	await expect(card(page, title)).toBeVisible();
}

// Calls the portal API from the page with the app's own nonce and session cookie.
export function apiCall(page, method, path, body) {
	return page.evaluate(
		async ({ method, path, body }) => {
			const cfg = window.GRP_CONFIG;
			const url = new URL(cfg.restRoot + path, location.href);
			const res = await fetch(url, {
				method,
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': cfg.nonce },
				body: body ? JSON.stringify(body) : undefined,
			});
			return { status: res.status, json: await res.json().catch(() => null) };
		},
		{ method, path, body }
	);
}

// The header shows one message at a time (SPEC.md 7.0): steps through them with › until the one
// containing `text` is showing, and returns it.
export async function showStrip(page, text) {
	const strip = page.locator('.md-strip', { hasText: text });
	await expect(strip).toHaveCount(1);
	for (let i = 0; i < 10 && !(await strip.isVisible()); i++) {
		await page.locator('.md-strip:visible').getByRole('button', { name: 'Next message' }).click();
	}
	await expect(strip).toBeVisible();
	return strip;
}
