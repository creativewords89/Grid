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
	page.on('pageerror', (e) => onPortal() && errors.push(`pageerror: ${e.message}`));
	page.on('console', (m) => {
		if (onPortal() && m.type() === 'error' && !/401|403/.test(m.text())) errors.push(`console: ${m.text()}`);
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
	await page.locator('#user_login').fill('owner');
	await page.locator('#user_pass').fill('owner-pass-123');
	await page.locator('#wp-submit').click();
	await page.waitForURL(/wp-admin|\/$/);
	await page.goto('/');
	await live(page);
}

export async function signOutOwner(page) {
	await page.context().clearCookies();
}

export const card = (page, title) => page.locator('article.mcard', { hasText: title });

export async function openProject(page, name) {
	await page.locator('button.pick', { hasText: name }).click();
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
