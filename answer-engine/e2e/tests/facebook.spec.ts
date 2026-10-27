import { expect, test } from "@playwright/test";
import { haveDocument, signIn } from "./helpers";

// SPEC 6.10: a Facebook post is found by its permalink (or the code in it), like Reddit:
// Facebook → permalink → draft → posted → their reply's link opens it → follow-up.
test("a Facebook conversation by permalink, from first draft to follow-up", async ({
  page,
}) => {
  await signIn(page);
  await haveDocument(page, "Client handbook.csv");
  const code = `${Date.now()}`;
  const post = `https://www.facebook.com/groups/localbiz/posts/${code}/`;

  await page.goto("/marketing");
  await page.getByRole("button", { name: /^Facebook/ }).click();
  await page
    .getByLabel("Post code or link", { exact: true })
    .fill(`${post}?fbclid=IwAR0e2e`);
  await page.getByRole("button", { name: "Check" }).click();
  await expect(
    page.getByText(/localbiz · we haven't answered it/),
  ).toBeVisible();
  await page
    .getByLabel("Their question")
    .fill(
      "How long does Google Business Profile verification take for a new practice?",
    );
  await page.getByLabel("Their name (optional)").fill("Dan Miller");
  await page.getByRole("button", { name: "Start and draft reply" }).click();
  await expect(page.locator(".bubble-us.draft")).toBeVisible();
  await expect(page.getByText(`post ${code}`, { exact: false })).toBeVisible();

  const status = page.locator(".mk-thread-head .pill");
  if ((await status.innerText()) === "In review") {
    await page.goto("/reviews");
    await page
      .getByRole("button", { name: /How long does Google Business Profile/ })
      .first()
      .click();
    await page.getByRole("button", { name: "✅ Approve" }).click();
    await expect(page.getByText(/Approved by Olivia/)).toBeVisible();
    await page.getByRole("link", { name: "Open the thread" }).click();
  }
  await page.getByRole("button", { name: "Mark as posted" }).click();
  await page
    .getByLabel("Link to our posted comment (optional)")
    .fill(`${post}?comment_id=555`);
  await page.getByRole("button", { name: "Save as posted" }).click();
  await expect(status).toHaveText("Waiting for them");

  // They answer our comment: the link of their reply opens the same conversation.
  await page.goto("/marketing");
  await page
    .getByLabel("Find by post code or link")
    .fill(`${post}?comment_id=555&reply_comment_id=777`);
  await page.getByLabel("Find by post code or link").press("Enter");
  await page
    .getByLabel("Paste their new reply")
    .fill("Thanks! Is video verification faster?");
  await page.getByRole("button", { name: "Send and draft" }).click();
  await expect(page.locator(".bubble-us.draft")).toHaveCount(1);

  // The post's code on its own finds it too, from the list's finder.
  await page.goto("/marketing");
  await page.getByLabel("Find by post code or link").fill(code);
  await page.getByLabel("Find by post code or link").press("Enter");
  await expect(
    page.locator(".bubble-them", { hasText: "Is video verification faster?" }),
  ).toBeVisible();
});
