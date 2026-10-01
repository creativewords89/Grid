// Import round trip: dry run, real import, legacy codes, export, re-import changes nothing new (SPEC.md 8).
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { apiCall, signIn, signInOwner, signOut, watchErrors } from './helpers.mjs';

const fixture = fileURLToPath(new URL('../../tests/fixtures/export-v1.json', import.meta.url));

async function upload(page, file, dryRun) {
	await page.goto('/wp-admin/admin.php?page=gridrankers-portal-import');
	await page.locator('#grp_import_file').setInputFiles(file);
	await page.locator('input[name=grp_dry_run]').setChecked(dryRun);
	await page.getByRole('button', { name: 'Import' }).click();
	const notice = page.locator('.notice', { has: page.locator('table') });
	await notice.waitFor();
	const counts = {};
	for (const row of await notice.locator('tbody tr').all()) {
		const [name, inserted, updated, skipped] = await row.locator('td').allTextContents();
		counts[name] = { inserted: +inserted, updated: +updated, skipped: +skipped };
	}
	return { text: await notice.innerText(), counts };
}

const total = (counts, key) => Object.values(counts).reduce((n, c) => n + c[key], 0);

test('import round trip', async ({ page }, testInfo) => {
	const noErrors = watchErrors(page);
	await signInOwner(page);

	// Dry run changes nothing.
	const dry = await upload(page, fixture, true);
	expect(dry.text).toContain('Dry run: nothing was changed');
	// The e2e site already has Acme Plumbing and Bright Dental: those projects and their tasks are skipped.
	expect(dry.counts.clients).toEqual({ inserted: 1, updated: 0, skipped: 2 });
	expect(dry.counts.items).toEqual({ inserted: 1, updated: 0, skipped: 4 });
	expect(dry.text).toContain('Skipped project “Acme Plumbing”: another project already has that name.');
	await page.goto('/');
	await expect(page.locator('button.pick', { hasText: 'Coastal Roofing' })).toHaveCount(0);

	// Real import.
	const real = await upload(page, fixture, false);
	expect(real.text).toContain('Import finished.');
	expect(real.counts).toEqual(dry.counts);

	await page.goto('/');
	await page.getByText('Shared with your team · live').waitFor();
	await expect(page.locator('button.pick', { hasText: 'Coastal Roofing' })).toBeVisible();
	const tasks = (await apiCall(page, 'GET', 'meeting-tasks')).json;
	expect(tasks.filter((t) => t.project_id === 'c_coast').map((t) => t.title)).toEqual(['Check roof gallery']);
	expect(tasks.filter((t) => t.project_id === 'c_acme')).toEqual([]);

	// Export from WordPress, then import the export again: nothing new.
	await page.goto('/wp-admin/admin.php?page=gridrankers-portal-export');
	const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download export' }).click()]);
	const exported = testInfo.outputPath('export.json');
	await download.saveAs(exported);
	const json = JSON.parse(await readFile(exported, 'utf8'));
	expect(json.format).toBe('gridrankers-portal-export');
	expect(json.data.clients.map((c) => c.name)).toEqual(expect.arrayContaining(['Acme Plumbing', 'Bright Dental', 'Coastal Roofing']));
	await writeFile(exported, JSON.stringify(json));

	const again = await upload(page, exported, false);
	expect(again.text).toContain('Import finished.');
	expect(total(again.counts, 'inserted')).toBe(0);
	expect(total(again.counts, 'skipped')).toBe(0);
	expect(total(again.counts, 'updated')).toBeGreaterThan(0);

	// Codes already moved to password_hash() are kept: Max still signs in with the portal code,
	// not the old portal's (legacy codes signing in is covered by PHPUnit).
	await page.context().clearCookies();
	await signIn(page, 'MAXCODE11');
	await expect(page.locator('.me-btn')).toContainText('Max Member');
	await signOut(page);
	noErrors();
});
