import { expect, test } from "@playwright/test";
import { haveDocument, signIn } from "./helpers";

// SPEC 6.10: Reddit → post code → draft → posted → their reply via its comment URL → follow-up.
test("a Reddit conversation from first draft to follow-up", async ({
  page,
}) => {
  await signIn(page);
  await haveDocument(page, "Client handbook.csv");
  const post =
    "https://www.reddit.com/r/localseo/comments/e2e1abc/how_long_does_gbp_verification_take/";

  // New conversation: pick Reddit, paste the post's link (with tracking), add their question.
  await page.goto("/marketing");
  await page.getByRole("button", { name: /^Reddit/ }).click();
  await page
    .getByLabel("Post code or link", { exact: true })
    .fill(`${post}?utm_source=share`);
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByText(/we haven't answered it/)).toBeVisible();
  await page
    .getByLabel("Their question")
    .fill(
      "How long does Google Business Profile verification take for a new dental practice?",
    );
  await page.getByLabel("Their username (optional)").fill("u/dentist_dan");
  await page.getByRole("button", { name: "Start and draft reply" }).click();
  await expect(page.locator(".bubble-us.draft")).toBeVisible();

  // A low-confidence draft is locked until a reviewer approves it.
  const status = page.locator(".mk-thread-head .pill");
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

  // They reply under our comment: its URL, pasted in the finder, opens the same conversation.
  await page.goto("/marketing");
  await page
    .getByLabel("Find by post code or link")
    .fill(
      "https://old.reddit.com/r/localseo/comments/e2e1abc/x/ourcmt1/?context=3",
    );
  await page.getByLabel("Find by post code or link").press("Enter");
  await expect(page.getByLabel("Paste their new reply")).toBeFocused();
  await page
    .getByLabel("Paste their new reply")
    .fill("Thanks! Is video verification faster?");
  await page.getByRole("button", { name: "Send and draft" }).click();
  await expect(
    page.locator(".bubble-them", { hasText: "Is video verification faster?" }),
  ).toBeVisible();
  // The follow-up is drafted straight away.
  await expect(page.locator(".bubble-us.draft")).toHaveCount(1);

  // Redraft with an instruction: the draft mentions us, so it adds the disclosure line.
  await page.getByRole("button", { name: "Redraft…" }).click();
  await page.getByLabel("Instruction for a new draft").fill("mention us");
  await page.getByRole("button", { name: "Redraft", exact: true }).click();
  await expect(page.locator(".bubble-us.draft").last()).toContainText(
    "(I work at GridRankers.)",
  );
});
