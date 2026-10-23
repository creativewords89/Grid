import { defineConfig, devices } from "@playwright/test";

// End-to-end tests of the main flows (SPEC section 15, step 16), against the real API,
// worker and web app with fake Claude, Pinecone and Telegram (see serve.sh).
export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1, // the flows share one database and one fake Telegram
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5180",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  webServer: {
    command: "sh ./serve.sh",
    url: "http://localhost:5180",
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
