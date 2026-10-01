// Cycle switching: tasks belong to their cycle, ‹ › moves between cycles, the Super Admin changes the cycle (SPEC.md 6.1).
import { test, expect } from '@playwright/test';
import { LEAD, addMeetingTask, card, openProject, signIn, signInOwner, signOut, watchErrors } from './helpers.mjs';

test('cycle switching and cycle change', async ({ page }) => {
	const noErrors = watchErrors(page);
	const title = 'Refresh GBP photos';
	const label = page.locator('.navgrp h2');

	await signIn(page, LEAD);
	await openProject(page, 'Bright Dental');
	await addMeetingTask(page, title, 'Max Member');
	await expect(label).toHaveText('Current cycle');

	await page.getByRole('button', { name: 'Next cycle' }).click();
	await expect(label).toHaveText('Next cycle');
	await expect(card(page, title)).toHaveCount(0);
	await page.getByRole('button', { name: 'Next cycle' }).click();
	await expect(label).toHaveText('2 cycles ahead');

	await page.getByRole('button', { name: 'Back to current' }).click();
	await expect(label).toHaveText('Current cycle');
	await expect(card(page, title)).toBeVisible();

	await page.getByRole('button', { name: 'Previous cycle' }).click();
	await expect(label).toHaveText('Previous cycle');
	await expect(card(page, title)).toHaveCount(0);
	await page.getByRole('button', { name: 'Previous cycle' }).click();
	await expect(label).toHaveText('2 cycles ago');
	await page.getByRole('button', { name: 'Back to current' }).click();

	// Leads see the locked cycle but cannot change it.
	await expect(page.locator('.cc-start.locked')).toContainText('Starts day 1');
	await expect(page.locator('.cc-change', { hasText: 'Change' })).toHaveCount(0);
	await signOut(page);

	// Super Admin changes the start day from the end of the current cycle.
	await signInOwner(page);
	await openProject(page, 'Bright Dental');
	await page.getByRole('tab', { name: 'Meeting Minutes' }).click();
	await page.locator('.cc-change', { hasText: 'Change' }).click();
	await page.getByRole('button', { name: 'Change cycle' }).click();
	await expect(page.getByText('Pick the new start day.')).toBeVisible();
	await page.getByLabel('New cycle start day').selectOption('15');
	await page.locator('label.pol', { hasText: 'Fresh start' }).click();
	await page.getByLabel('Reason for the change').fill('Contract renewed on the 15th');
	await page.getByRole('button', { name: 'Change cycle' }).click();
	await page.getByText('Bright Dental: cycle changed').waitFor();
	await expect(page.locator('.cc-start.locked')).toContainText('Starts day 1');
	await expect(page.locator('.cc-pend')).toContainText('Day 15 from');

	await page.locator('.cc-change', { hasText: 'History' }).click();
	await expect(page.locator('.dt-hist')).toContainText('Day 1 → 15');
	await expect(page.locator('.dt-hist')).toContainText('Contract renewed on the 15th');
	await page.getByRole('button', { name: 'Close' }).click();

	// The current cycle keeps its task; the next cycle starts on day 15.
	await expect(card(page, title)).toBeVisible();
	await page.getByRole('button', { name: 'Next cycle' }).click();
	await expect(label).toHaveText('Next cycle');
	await expect(card(page, title)).toHaveCount(0);
	noErrors();
});
