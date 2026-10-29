// End-to-end test of the desktop app itself (Electron), against a running portal:
//   TRACKER_LIVE_URL=http://127.0.0.1:8090 TRACKER_LIVE_CODE=MAXCODE11 npx playwright test -c e2e/playwright.config.mjs
// (on Linux without a screen: xvfb-run -a …)
import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: '.', testMatch: '*.spec.mjs', workers: 1, timeout: 60000, reporter: [['list']], outputDir: '../test-results' });
