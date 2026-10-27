import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// The Hub's main flow on a brand-new install (SPEC section 12, steps 9 and 10): create the
// Owner → Connections → a benchmark → a batch and its file → the demo agent works on the
// batch → Runs → History.

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUN = path.join(HERE, "..", ".run");
const DEMO_AGENT = path.join(HERE, "..", "..", "..", "agents", "demo", "agent.py");
const API = "http://localhost:8200";
const GOOGLE = "http://127.0.0.1:9921";
const OWNER = { name: "Olivia", email: "olivia@example.com", password: "olivia owner passphrase" };

test.describe.configure({ mode: "serial" });

let page: Page;
let agent: ChildProcess | undefined;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  agent?.kill();
  await page.close();
});

function serviceAccountKey(): Buffer {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return Buffer.from(
    JSON.stringify({
      type: "service_account",
      client_email: "hub@gridrankers-e2e.iam.gserviceaccount.com",
      private_key: privateKey,
      // Ignored by the Hub (it uses its own GOOGLE_TOKEN_URL), as a real key's would be.
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );
}

async function leadsTab(): Promise<string[][]> {
  const state = (await (await fetch(`${GOOGLE}/_state`)).json()) as Record<string, string[][]>;
  return state["Leads"] ?? [];
}

test("the first Owner is created with the setup code", async () => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create the Owner account" })).toBeVisible();
  await page.getByLabel("Setup code").fill(readFileSync(path.join(RUN, "setup-code"), "utf8"));
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: /Create/ }).click();

  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
});

test("Google is connected and tested from the Connections screen", async () => {
  const google = page.getByRole("form", { name: "Google (Sheets and Drive)" });
  await google.getByLabel("Service account key (JSON file)").setInputFiles({
    name: "key.json",
    mimeType: "application/json",
    buffer: serviceAccountKey(),
  });
  await google
    .getByLabel("Master Sheet link")
    .fill("https://docs.google.com/spreadsheets/d/1E2eSheetIdAbCdEfGhIjKlMnOp/edit");
  await google
    .getByLabel("Drive folder link")
    .fill("https://drive.google.com/drive/folders/1E2eFolderIdAbCd");
  await google.getByRole("button", { name: "Save" }).click();
  await expect(google.getByText("Set up", { exact: true })).toBeVisible();

  await google.getByRole("button", { name: "Test the Sheet and folder" }).click();
  await expect(google.getByText(/Opened “E2E Master”/)).toBeVisible();
  await expect(google.getByText(/The Drive folder can be written to/)).toBeVisible();
});

test("a benchmark is made for the niche", async () => {
  await page.getByRole("link", { name: "Benchmarks" }).click();
  await page.getByRole("button", { name: "+ New benchmark" }).click();
  const form = page.getByRole("form", { name: "Benchmark" });
  await form.getByLabel("Name", { exact: true }).fill("Cleaning Benchmark 1");
  await form.getByLabel("Niche", { exact: true }).fill("Cleaning");
  await form.getByLabel("Photos", { exact: true }).fill("100");
  await form.getByLabel("Posts in 90 days").fill("12");
  await form.getByRole("button", { name: "+ Add a service" }).click();
  await form.getByLabel("Service 1").fill("Deep cleaning");
  await form.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("Saved Cleaning Benchmark 1.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Cleaning Benchmark 1/ })).toContainText("v1");
});

test("a batch is made and a lead file is read, checked and sent to the Master Sheet", async () => {
  await page.getByRole("link", { name: "Batches" }).click();
  await page.getByRole("button", { name: "+ New batch" }).click();
  const made = page.getByRole("form", { name: "New batch" });
  await made.getByLabel("Batch name").fill("Texas November");
  await made.getByLabel("Niche (one per batch)").fill("Cleaning");
  await made.getByLabel("Benchmark").selectOption({ label: "Cleaning Benchmark 1" });
  await made.getByRole("button", { name: "Make the batch" }).click();
  await expect(page.getByRole("heading", { name: "Texas November" })).toBeVisible();

  await page
    .getByLabel("Excel file")
    .setInputFiles(path.join(HERE, "..", "fixtures", "cleaning-leads.xlsx"));
  await page.getByRole("button", { name: "Read the file" }).click();

  const preview = page.getByRole("article", { name: "Preview" });
  const count = (label: string) =>
    preview.locator(".count", { has: page.getByText(label, { exact: true }) });
  await expect(count("businesses")).toContainText("4");
  await expect(count("duplicates merged")).toContainText("1");
  await expect(count("Top (never contacted)")).toContainText("1");
  await expect(count("cities")).toContainText("2");

  await preview.getByRole("button", { name: "Send 4 businesses to the Master Sheet" }).click();
  await expect(preview.getByText("Sent: 4 rows added and 0 updated")).toBeVisible();

  const rows = await leadsTab();
  expect(rows).toHaveLength(5); // the header and four leads
  expect(rows[0]).toContain("Lead ID");
  const sparkle = rows.find((row) => row.includes("Sparkle Home Cleaning"))!;
  expect(sparkle).toContain("hello@sparklehome.com, office@sparklehome.com");
  expect(sparkle.join(" ")).not.toContain("utm_source");
  expect(sparkle[rows[0]!.indexOf("Batch")]).toBe("Texas November");
  await page.getByRole("button", { name: "All batches" }).click();
  await expect(page.getByRole("row", { name: /Texas November/ })).toContainText("1 Top");
  await expect(page.getByRole("switch", { name: "Tulsa · Cleaning on or off" })).toBeChecked();
});

test("the demo agent joins, works on the batch and finishes a run", async () => {
  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "+ Add agent" }).click();
  await page.getByLabel("Name").fill("Demo agent");
  await page.getByLabel("Key").fill("demo");
  await page.getByRole("button", { name: "Add and show the token" }).click();
  const token = await page.getByLabel("Agent token").inputValue();
  expect(token).toMatch(/^hub_agent_/);
  await page.getByRole("button", { name: "Done" }).click();

  agent = spawn("python3", [DEMO_AGENT], {
    env: { ...process.env, HUB_URL: API, AGENT_TOKEN: token, POLL_SECONDS: "1" },
    stdio: "ignore",
  });
  const card = page.getByRole("article", { name: "Demo agent" });
  await expect(async () => {
    await card.getByRole("button", { name: "Refresh" }).click();
    await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  await card.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Items per run").fill("4");
  await page.getByLabel("Seconds per item").fill("0.2");
  await page.getByLabel("Add a batch").selectOption({ label: "Texas November (Cleaning)" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Works on: Texas November")).toBeVisible();
  const power = card.getByRole("switch", { name: "Demo agent on or off" });
  await power.click(); // saved on the server first, then shown as on
  await expect(power).toBeChecked();

  await card.getByRole("button", { name: "Run now" }).click();
  await expect(card.getByText("Run queued.", { exact: false })).toBeVisible();
  await expect(async () => {
    await card.getByRole("button", { name: "Refresh" }).click();
    await expect(card.getByText("Finished")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 45_000 });
  // Three leads audited; the Top one skipped.
  await expect(card.getByText(/3 done, 1 skipped/)).toBeVisible();
});

test("the run is on the Runs screen and the changes are in History", async () => {
  await page.getByRole("link", { name: "Runs" }).click();
  const row = page.getByRole("row", { name: /Demo agent/ });
  await expect(row.getByText("Finished")).toBeVisible();
  await expect(row.getByText("3 · 0 · 1")).toBeVisible();
  await expect(row.getByText("Run now by Olivia")).toBeVisible();

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByRole("row", { name: /run agents · Demo agent/ })).toBeVisible();
  await expect(
    page.getByRole("row", { name: /confirm imports · cleaning-leads\.xlsx/ }),
  ).toBeVisible();
  await expect(page.getByText("google_service_account: — → (changed)")).toBeVisible();
  await expect(page.getByRole("row", { name: /create batches · Texas November/ })).toBeVisible();
  await expect(
    page.getByRole("row", { name: /create benchmarks · Cleaning Benchmark 1/ }),
  ).toBeVisible();
});
