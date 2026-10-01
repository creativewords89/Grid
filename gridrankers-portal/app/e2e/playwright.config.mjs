// Playwright e2e for the portal (SPEC.md build step 14). Run from the plugin folder:
//   cd app && npm run e2e
// The web server step builds a fresh WordPress site (e2e/site/setup.sh) and serves it with PHP.
import { defineConfig } from '@playwright/test';

const port = process.env.E2E_PORT || '8090';
const url = `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.mjs',
	fullyParallel: false,
	workers: 1,
	timeout: 60000,
	reporter: [['list']],
	use: {
		baseURL: url,
		viewport: { width: 1280, height: 900 },
		launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
	},
	webServer: {
		command: `E2E_URL=${url} bash site/setup.sh && php -S 127.0.0.1:${port} -t \${E2E_DIR:-/tmp/grp-e2e}`,
		cwd: new URL('.', import.meta.url).pathname,
		url,
		timeout: 120000,
		reuseExistingServer: false,
	},
});
