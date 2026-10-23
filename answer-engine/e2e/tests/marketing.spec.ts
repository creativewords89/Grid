import { expect, test } from "@playwright/test";
import { haveDocument, signIn } from "./helpers";

// SPEC 6.10: URL → thread → draft → posted → their reply via its comment URL → follow-up.
test("a Reddit thread from first draft to follow-up", async ({ page }) => {
  await signIn(page);
  await haveDocument(page, "Client handbook.csv");
  const post =
    "https://www.reddit.com/r/localseo/comments/e2e1abc/how_long_does_gbp_verification_take/";

  // Paste the post's URL (with tracking), add their question, draft.
  await page.goto("/marketing");
  await page
    .getByLabel("Paste a Reddit link or the post's code")
    .fill(`${post}?utm_source=share`);
  await page.getByRole("button", { name: "Go" }).click();
  await expect(page.getByText("New thread")).toBeVisible();
  await page
    .getByLabel("Their question")
    .fill(
      "How long does Google Business Profile verification take for a new dental practice?",
    );
  await page.getByLabel("Their username (optional)").fill("u/dentist_dan");
  await page.getByRole("button", { name: "Draft reply" }).click();
  await expect(page.locator(".bubble-us.draft")).toBeVisible();

  // A low-confidence draft is locked until a reviewer approves it.
  const status = page.locator(".thread-head .pill");
  if ((await status.innerText()) === "In review") {
    await expect(
      page.getByRole("button", { name: "Mark as posted" }),
    ).toHaveCount(0);
    await page.goto("/reviews");
    await page
      .getByRole("button", { name: /How long does Google Business Profile/ })
      .first()
      .click();
    await page.getByRole("button", { name: "✅ Approve" }).click();
    await expect(page.getByText(/Approved by Olivia/)).toBeVisible();
    await page.getByRole("link", { name: "Open the thread" }).click();
  }
  await expect(status).toHaveText("Ready to post");

  // Post it (by hand, on Reddit) and record our comment's link.
  await page.getByRole("button", { name: "Mark as posted" }).click();
  await page
    .getByLabel("Link to our posted comment (optional)")
    .fill(`${post}ourcmt1/`);
  await page.getByRole("button", { name: "Save as posted" }).click();
  await expect(page.getByText(/Posted by Olivia/)).toBeVisible();
  await expect(status).toHaveText("Waiting for them");

  // They reply under our comment: its URL opens the same thread with the reply form ready.
  await page.goto("/marketing");
  await page
    .getByLabel("Paste a Reddit link or the post's code")
    .fill(
      "https://old.reddit.com/r/localseo/comments/e2e1abc/x/ourcmt1/?context=3",
    );
  await page.getByRole("button", { name: "Go" }).click();
  await expect(page.getByLabel("Their reply")).toBeVisible();
  await page
    .getByLabel("Their reply")
    .fill("Thanks! Is video verification faster?");
  await page.getByRole("button", { name: "Add reply" }).click();
  await expect(
    page.locator(".bubble-them", { hasText: "Is video verification faster?" }),
  ).toBeVisible();
  await expect(status).toHaveText("Waiting for us");

  // The follow-up draft answers their new message and adds the disclosure line.
  await page
    .getByLabel("Instruction for the draft (optional)")
    .last()
    .fill("mention us");
  await page.getByRole("button", { name: "Draft reply" }).last().click();
  await expect(page.locator(".bubble-us.draft").last()).toContainText(
    "(I work at GridRankers.)",
  );
});
