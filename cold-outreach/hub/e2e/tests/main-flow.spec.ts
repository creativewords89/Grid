import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

// The Hub's main flow on a brand-new install (SPEC section 12, steps 9 to 11 and 39): create
// the Owner → a benchmark → a Collector hands in a file and fixes it → a Reviewer gives a
// city its Top and sends it to the niche's batch → the leads, in the Hub and as Excel → the
// demo agent works on the batch and saves its results → the batch's Leads, Runs and History.

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUN = path.join(HERE, "..", ".run");
const OWNER = {
  name: "Olivia",
  email: "olivia@example.com",
  password: "olivia owner passphrase",
};

test.describe.configure({ mode: "serial" });

let page: Page;
let rita: Page; // the Reviewer

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
  await rita?.close();
});

/** The Owner invites someone; email isn't set up, so the link is copied. */
async function invite(
  name: string,
  email: string,
  role: string,
): Promise<string> {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Users" })
    .click();
  await page.getByRole("button", { name: "+ Invite" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Role").selectOption(role);
  await dialog.getByRole("button", { name: "Send invite" }).click();
  // Wait for this person's link, not one shown before.
  await expect(page.getByText(`send it to ${name} yourself`)).toBeVisible();
  const link = await page.getByRole("textbox", { name: "Link" }).inputValue();
  await page.keyboard.press("Escape");
  return new URL(link).pathname + new URL(link).hash;
}

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

test("a Collector hands in a file, fixes it and sends it on to Top Review", async ({
  browser,
}) => {
  const link = await invite("Cal", "cal@example.com", "collector");
  const cal = await browser.newPage();
  await cal.goto(link);
  await cal.getByLabel("New password").fill("cal collector passphrase");
  await cal.getByLabel("Repeat password").fill("cal collector passphrase");
  await cal.getByRole("button", { name: "Set password and sign in" }).click();
  const nav = cal.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveText(["Files"]);
  await cal
    .getByLabel(/Excel file/)
    .setInputFiles(path.join(HERE, "..", "fixtures", "cleaning-leads.xlsx"));
  // The niche is asked for once the file is chosen (step 38).
  const ask = cal.getByRole("dialog", {
    name: "Which niche is this file for?",
  });
  await ask.getByLabel("Niche").selectOption("Cleaning");
  await ask.getByRole("button", { name: "Upload and check" }).click();
  await expect(cal.getByText(/is uploaded and being checked/)).toBeVisible();
  // Checked on the server (step 33), even after a reload: Sparkle is on two rows, an error.
  await cal.reload();
  const mine = cal.getByRole("row", { name: /cleaning-leads\.xlsx/ });
  await expect(mine).toContainText("1 error to fix");
  await mine.getByRole("button", { name: "cleaning-leads.xlsx" }).click();
  const businesses = cal.getByRole("region", {
    name: "Businesses in this file",
  });
  await expect(
    businesses.getByText("Sparkle Home Cleaning").first(),
  ).toBeVisible();
  // Duplicates first, on the Hub (step 40): until then the problems don't download.
  await expect(
    cal.getByRole("button", { name: /Download problems to fix/ }),
  ).toBeDisabled();
  cal.once("dialog", (dialog) => void dialog.accept());
  await cal.getByRole("button", { name: "Remove duplicates" }).click();
  await expect(cal.getByText(/No errors\. Final check/)).toBeVisible({
    timeout: 20_000,
  });
  const downloaded = cal.waitForEvent("download");
  await cal.getByRole("button", { name: /Download problems to fix/ }).click();
  expect((await downloaded).suggestedFilename()).toBe(
    "cleaning-leads-v2-to-fix.xlsx",
  );
  await cal.getByRole("button", { name: "Send to Top Review now" }).click();
  // Both cities are under 10 businesses: none goes on unless it is given a Top.
  await expect(cal.getByText(/no city is in the batch/)).toBeVisible();
  await expect(cal.getByRole("button", { name: /Upload fixes/ })).toHaveCount(
    0,
  );
  await cal.close();
});

test("a Reviewer gives a city its Top and sends it to the niche's batch now", async ({
  browser,
}) => {
  const link = await invite("Rita", "rita@example.com", "reviewer");
  rita = await browser.newPage();
  await rita.goto(link);
  await rita.getByLabel("New password").fill("rita reviewer passphrase");
  await rita.getByLabel("Repeat password").fill("rita reviewer passphrase");
  await rita.getByRole("button", { name: "Set password and sign in" }).click();
  await expect(
    rita.getByRole("navigation", { name: "Main" }).getByRole("link"),
  ).toHaveText(["Top Review"]);
  // Top Review opens on the niches: Cleaning, then its file (step 45).
  await rita.getByRole("button", { name: /^Cleaning\s*1 file/ }).click();
  await rita.getByRole("button", { name: "Open cleaning-leads.xlsx" }).click();
  const lists = rita.getByRole("navigation", { name: "Cities" });
  await lists.getByRole("button", { name: /Cities under 10/ }).click();
  // The cities under 10 are ticked on one page (step 41), most reviews first.
  await rita
    .getByRole("checkbox", { name: "Top: Big Shine Co (Dallas)" })
    .check();
  await rita.getByRole("button", { name: "Save the Tops of 1 city" }).click();
  await expect(rita.getByText(/Saved the Top of 1 city/)).toBeVisible();
  await rita
    .getByRole("navigation", { name: "Cities" })
    .getByRole("button", { name: /^Ready/ })
    .click();
  const dallas = rita.getByRole("row", { name: /Dallas/ });
  await dallas.getByRole("button", { name: "Send to batch now" }).click();
  await expect(rita.getByText("Dallas is in its batch.")).toBeVisible();

  // The niche's batch is made, named after it, with its benchmark.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Batches" })
    .click();
  const batch = page.getByRole("row", { name: /Cleaning Benchmark 1/ });
  await expect(batch).toContainText("Cleaning");
  await expect(batch).toContainText("3 · 1 Top");
});

test("the leads are in the niche's batch and download as Excel", async () => {
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
    .getByRole("button", { name: "Cleaning", exact: true })
    .first()
    .click();
  // It opens on its cities: Dallas has fewer than 10 businesses, muted, on its own tab.
  await page
    .getByRole("tab", { name: /Small cities \(under 10\) \(1\)/ })
    .click();
  await expect(
    page.getByRole("switch", { name: "Dallas on or off" }),
  ).not.toBeChecked();
  // Each city says the file it came with; the latest file's cities are New.
  await expect(page.getByRole("row", { name: /Dallas/ })).toContainText(
    "cleaning-leads.xlsx · Dallas",
  );
  await expect(
    page.getByRole("row", { name: /Dallas/ }).locator(".pill-active"),
  ).toHaveText("New");
  // Unmuted by hand, so the demo agent can work on them.
  await page.getByRole("button", { name: "All on" }).click();
  await expect(
    page.getByRole("switch", { name: "Dallas on or off" }),
  ).toBeChecked();
  // A city's leads, and back to the cities.
  await page.getByRole("button", { name: "Dallas", exact: true }).click();
  await expect(page.getByText("3 leads", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← Back to Cities" }).click();
  await expect(page.getByRole("tab", { name: /Small cities/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "Lead files" }).click();
  await expect(page.getByText("3 leads")).toBeVisible();
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
  await expect(dialog.getByText(/Cleaning/).first()).toBeVisible();
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

  // Its Top came from Top Review; with a Top Dallas is ready for the agents.
  await expect(
    page.getByRole("row", { name: /Big Shine Co/ }).locator(".pill-top"),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Cities", exact: true }).click();
  await page.getByRole("tab", { name: /Small cities/ }).click();
  await expect(page.getByRole("row", { name: /Dallas/ })).toContainText(
    "Ready",
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
  await page.getByRole("button", { name: "Cleaning", exact: true }).click();
  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
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
    "Used in: Cleaning · GBP Audit",
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
  // Dallas's two other leads audited; the Top one is never handed out.
  await expect(card.getByText(/2 done/)).toBeVisible();

  // Its results are on the batch's Leads tab, and can be sorted by.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Batches" })
    .click();
  await page.getByRole("button", { name: "Cleaning", exact: true }).click();
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
    page.getByRole("row", {
      name: /send to batch file · cleaning-leads\.xlsx · Dallas/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /create batches · Cleaning$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /create benchmarks · Cleaning Benchmark 1/ }),
  ).toBeVisible();
});

test("a city of 10 businesses or more gets its Top and goes on to the batch", async () => {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Files" })
    .click();
  await page
    .getByLabel(/Excel file/)
    .setInputFiles(path.join(HERE, "..", "fixtures", "top-review.xlsx"));
  const ask = page.getByRole("dialog", {
    name: "Which niche is this file for?",
  });
  await ask.getByLabel("Niche").selectOption("Cleaning");
  await ask.getByRole("button", { name: "Upload and check" }).click();
  const row = page.getByRole("row", { name: /top-review\.xlsx/ });
  await expect(row).toContainText("No errors");
  await row.getByRole("button", { name: "Send to Top Review now" }).click();
  await expect(row).toContainText("Waiting for Top Review");
  await expect(row).toContainText("0 of 1 city in the batch");

  // The Reviewer finds Austin Not ready and chooses its Top.
  await rita.reload();
  await rita.getByRole("button", { name: /^Cleaning\s*1 file/ }).click();
  await rita.getByRole("button", { name: "Open top-review.xlsx" }).click();
  await rita.getByRole("button", { name: "Austin" }).click();
  await rita.getByRole("checkbox", { name: "Top: Austin Shine 3" }).check();
  await rita.getByRole("button", { name: "Save the Top of Austin" }).click();
  await expect(rita.getByText(/Saved the Top of Austin/)).toBeVisible();

  // Ready: it would go on in an hour; the Reviewer sends it now (Files doesn't show it).
  await page.reload();
  await expect(row).not.toContainText("ready");
  await rita
    .getByRole("navigation", { name: "Cities" })
    .getByRole("button", { name: /^Ready/ })
    .click();
  await rita
    .getByRole("row", { name: /Austin/ })
    .getByRole("button", { name: "Send to batch now" })
    .click();
  await expect(rita.getByText("Austin is in its batch.")).toBeVisible();
  await page.reload();
  // Every Cleaning file is done now: its section is closed until opened (step 44).
  const cleaning = page.getByRole("button", { name: /^Cleaning\s*2 files/ });
  await expect(cleaning).toHaveAttribute("aria-expanded", "false");
  await expect(cleaning).toContainText("Done");
  await cleaning.click();
  await expect(row).toContainText("1 of 1 city in the batch");
  await expect(row).toContainText("Done");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Batches" })
    .click();
  await expect(
    page.getByRole("row", { name: /Cleaning Benchmark 1/ }),
  ).toContainText("15 · 2 Top");
});
