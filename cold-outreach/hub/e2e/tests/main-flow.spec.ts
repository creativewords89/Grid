import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

// The Hub's main flow on a brand-new install (SPEC section 12, steps 9 to 11): create the
// Owner → a benchmark → a batch and its file → the leads, in the Hub and as Excel → the demo
// agent works on the batch and saves its results → the batch's Leads, Runs and History.

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUN = path.join(HERE, "..", ".run");
const OWNER = {
  name: "Olivia",
  email: "olivia@example.com",
  password: "olivia owner passphrase",
};

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test("the first Owner is created with the setup code", async () => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Create the Owner account" }),
  ).toBeVisible();
  await page
    .getByLabel("Setup code")
    .fill(readFileSync(path.join(RUN, "setup-code"), "utf8"));
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: /Create/ }).click();

  await expect(
    page.getByRole("heading", { name: "Connections" }),
  ).toBeVisible();
});

test("a benchmark is made for the niche", async () => {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Benchmarks" })
    .click();
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
  await expect(
    page.getByRole("row", { name: /Cleaning Benchmark 1/ }),
  ).toContainText("v1");
});

test("a batch is made and a lead file is read, checked and saved in the Hub", async () => {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Batches" })
    .click();
  await page.getByRole("button", { name: "+ New batch" }).click();
  const made = page.getByRole("form", { name: "New batch" });
  await made.getByLabel("Batch name").fill("Texas November");
  await made.getByLabel("Niche (one per batch)").fill("Cleaning");
  await made
    .getByLabel("Benchmark")
    .selectOption({ label: "Cleaning Benchmark 1" });
  await made.getByRole("button", { name: "Make the batch" }).click();
  await expect(
    page.getByRole("heading", { name: "Texas November" }),
  ).toBeVisible();

  await page
    .getByLabel("Excel file")
    .setInputFiles(path.join(HERE, "..", "fixtures", "cleaning-leads.xlsx"));
  await page.getByRole("button", { name: "Read the file" }).click();

  const preview = page.getByRole("article", { name: "Preview" });
  const count = (label: string) =>
    preview.locator(".count", { has: page.getByText(label, { exact: true }) });
  await expect(count("businesses")).toContainText("4");
  await expect(count("duplicates merged")).toContainText("1");
  await expect(count("already Top (never contacted)")).toContainText("0");
  await expect(preview.getByText(/Top is chosen in the Hub/)).toBeVisible();
  await expect(count("cities")).toContainText("2");
  // The file itself, tab by tab, with every column.
  const file = preview.getByRole("region", { name: "The file, tab by tab" });
  await expect(file.getByRole("tab", { name: /All tabs \(5\)/ })).toBeVisible();
  await expect(file.getByRole("row").first()).toContainText("Business name");
  await expect(file.getByText("Sparkle Home Cleaning").first()).toBeVisible();
  // Lead Check runs on the file before it is saved (step 26): this one has no errors.
  await expect(
    preview.getByRole("region", { name: "Lead Check" }),
  ).toContainText("🔴 0 errors");

  await preview.getByRole("button", { name: "Save 4 businesses" }).click();
  await expect(preview.getByText("Saved: 4 new and 0 updated.")).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Lead Check report of cleaning-leads.xlsx",
    }),
  ).toHaveText("✅ Clear");
  await expect(
    preview
      .getByRole("region", { name: "The file, tab by tab" })
      .getByText("L-000001")
      .first(),
  ).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "Batches" }).click();
  await expect(page.getByRole("row", { name: /Texas November/ })).toContainText(
    "4",
  );
});

test("the leads are in their batch and download as Excel", async () => {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Batches" })
    .click();
  // Find a business in every batch.
  const find = page.getByRole("form", { name: "Find a business" });
  await find.getByLabel("Find a business in every batch").fill("maid pro");
  await find.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText("1 found")).toBeVisible();
  await page
    .getByRole("button", { name: "Texas November", exact: true })
    .first()
    .click();
  // Both cities have fewer than 10 businesses: muted by the Hub, on their own tab.
  await page.getByRole("tab", { name: "Cities", exact: true }).click();
  await page
    .getByRole("tab", { name: /Small cities \(under 10\) \(2\)/ })
    .click();
  await expect(
    page.getByRole("switch", { name: "Tulsa on or off" }),
  ).not.toBeChecked();
  // Each city says the file it came with; the latest file's cities are New.
  await expect(page.getByRole("row", { name: /Tulsa/ })).toContainText(
    "cleaning-leads.xlsx",
  );
  await expect(
    page.getByRole("row", { name: /Tulsa/ }).locator(".pill-active"),
  ).toHaveText("New");
  // Unmuted by hand, so the demo agent can work on them.
  await page.getByRole("button", { name: "All on" }).click();
  await expect(
    page.getByRole("switch", { name: "Tulsa on or off" }),
  ).toBeChecked();
  // A city's leads, and back to the cities.
  await page.getByRole("button", { name: "Tulsa", exact: true }).click();
  await expect(page.getByText("1 lead", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← Back to Cities" }).click();
  await expect(page.getByRole("tab", { name: /Small cities/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "Lead files" }).click();
  await expect(page.getByText("4 leads")).toBeVisible();
  // Every field of the file side by side.
  await expect(
    page.getByRole("row", {
      name: /Lead ID Business name Check GBP link Address City Website Phone WhatsApp Email Facebook Instagram Reviews Rating Top Notes Level Batch/,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sparkle Home Cleaning" }).click();
  const dialog = page.getByRole("dialog", { name: "Sparkle Home Cleaning" });
  // The duplicate rows were merged into one lead with both emails; tracking was removed.
  await expect(dialog.getByLabel("Email(s)")).toHaveValue(
    "hello@sparklehome.com, office@sparklehome.com",
  );
  await expect(dialog.getByLabel("Website")).toHaveValue(
    "https://sparklehome.com/",
  );
  await expect(dialog.getByText(/Texas November/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  await page.getByLabel("Website").selectOption("no");
  await expect(page.getByText("1 lead", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Maid Pro Dallas" }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.locator("summary", { hasText: "Download" }).click(); // the Download menu
  await page.getByRole("link", { name: /^Download Excel/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^leads-\d{4}-\d{2}-\d{2}\.xlsx$/);
  await page.getByLabel("Website").selectOption("");

  // Top is chosen in a city, not on the Leads tab: open Dallas, tick it, Mark as Top.
  await expect(
    page.getByRole("checkbox", { name: "Choose Big Shine Co" }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Cities", exact: true }).click();
  await page.getByRole("tab", { name: /Small cities/ }).click();
  await page.getByRole("button", { name: "Dallas", exact: true }).click();
  await page.getByRole("checkbox", { name: "Choose Big Shine Co" }).click();
  await page.getByRole("button", { name: "Mark as Top" }).click();
  await expect(
    page.getByText("1 lead marked as Top: agents leave them alone."),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Big Shine Co/ }).locator(".pill-top"),
  ).toBeVisible();
  // With a Top chosen Dallas is ready; Tulsa, without one, is not.
  await page.getByRole("button", { name: "← Back to Cities" }).click();
  await expect(page.getByRole("row", { name: /Dallas/ })).toContainText(
    "Ready",
  );
  await expect(page.getByRole("row", { name: /Tulsa/ })).toContainText(
    "Not ready",
  );
});

test("the demo agent joins, works on the batch and finishes a run", async () => {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Agents" })
    .click();
  // A built-in agent (step 25): its kind and job; the Hub runs it, no token or command.
  await page.getByRole("button", { name: "+ Add agent" }).click();
  const add = page.getByRole("dialog", { name: "Add an agent" });
  await expect(add.getByLabel("Kind of agent")).toHaveValue("demo");
  await add.getByLabel("Job it does").selectOption({ label: "GBP Audit" });
  await add.getByLabel("Name").fill("Demo agent");
  await add.getByRole("button", { name: "Add agent" }).click();
  await expect(add).toBeHidden();

  const card = page.getByRole("article", { name: "Demo agent" });
  await expect(async () => {
    await card.getByRole("button", { name: "Refresh" }).click();
    await expect(card.getByText("Connected · runs in the Hub")).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 30_000 });

  await card.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Items per run").fill("4");
  await page.getByLabel("Seconds per item").fill("0.2");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Settings saved.")).toBeVisible();
  await expect(card.getByText("Does:").locator("..")).toContainText(
    "Does: GBP Audit",
  );

  // The batch chooses the agent for its task, then starts.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Batches" })
    .click();
  await page
    .getByRole("button", { name: "Texas November", exact: true })
    .click();
  // The batch starts from the standard steps, then the agent goes on its job's task.
  await expect(
    page.getByRole("region", { name: "Agent library" }).getByText("Demo agent"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use the standard steps" }).click();
  await expect(
    page.getByRole("article", { name: "Opportunity Finder" }),
  ).toBeVisible();
  const slot = page.getByRole("article", { name: "GBP Audit" });
  await slot
    .getByLabel("Add an agent to GBP Audit")
    .selectOption({ label: "Demo agent" });
  await expect(slot.getByText("Demo agent")).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Agents" })
    .click();
  await expect(card.getByText("Used in:").locator("..")).toContainText(
    "Used in: Texas November · GBP Audit",
  );
  const power = card.getByRole("switch", { name: "Demo agent on or off" });
  await power.click(); // saved on the server first, then shown as on
  await expect(power).toBeChecked();

  await card.getByRole("button", { name: "Run now" }).click();
  await expect(card.getByText("Run queued.", { exact: false })).toBeVisible();
  await expect(async () => {
    await card.getByRole("button", { name: "Refresh" }).click();
    await expect(card.getByText("Finished")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 45_000 });
  // Dallas's two other leads audited; the Top one is never handed out, and Tulsa has no
  // Top chosen yet, so it is not ready and left alone.
  await expect(card.getByText(/2 done/)).toBeVisible();

  // Its results are on the batch's Leads tab, and can be sorted by.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Batches" })
    .click();
  await page
    .getByRole("button", { name: "Texas November", exact: true })
    .click();
  await page.getByRole("tab", { name: "Lead files" }).click();
  await page
    .getByLabel("Sort by")
    .selectOption({ label: "Sort: Demo score (best first)" });
  await expect(page.getByRole("row", { name: /Batch Demo$/ })).toBeVisible();
  const scored = page.getByRole("row", { name: /Sparkle Home Cleaning/ });
  await expect(scored.getByRole("cell").last()).toHaveText(/^\d+$/);

  // And on the batch's Results tab, for that agent.
  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  await page.getByRole("tab", { name: "Results" }).click();
  await expect(page.getByRole("button", { name: /2\s*Done/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sparkle Home Cleaning" }),
  ).toBeVisible();
});

test("the run is on the Runs screen and the changes are in History", async () => {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Runs" })
    .click();
  const row = page.getByRole("row", { name: /Demo agent/ });
  await expect(row.getByText("Finished")).toBeVisible();
  await expect(row.getByText("2 · 0 · 0")).toBeVisible();
  await expect(row.getByText("Run now by Olivia")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "History" })
    .click();
  await expect(
    page.getByRole("row", { name: /run agents · Demo agent/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /confirm imports · cleaning-leads\.xlsx/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /create batches · Texas November/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /create benchmarks · Cleaning Benchmark 1/ }),
  ).toBeVisible();
});
