import { defineConfig, devices } from "@playwright/test";

// End-to-end test of the main flow (SPEC section 12), against the real API, scheduler, web
// app and demo agent (see serve.sh).
export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1, // the flow builds on one fresh database
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5190",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: "sh ./serve.sh",
    url: "http://localhost:5190",
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
