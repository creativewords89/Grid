import { expect, test } from "@playwright/test";
import { haveDocument, signIn } from "./helpers";

// SPEC 6.10: a Facebook post is found by its permalink (or the code in it), like Reddit:
// permalink → draft → posted → their reply's link opens the same thread → follow-up.
test("a Facebook thread by permalink, from first draft to follow-up", async ({
  page,
}) => {
  await signIn(page);
  await haveDocument(page, "Client handbook.csv");
  const code = `${Date.now()}`;
  const post = `https://www.facebook.com/groups/localbiz/posts/${code}/`;

  await page.goto("/marketing");
  await page
    .getByLabel("Paste a Reddit or Facebook link or the post's code")
    .fill(`${post}?fbclid=IwAR0e2e`);
  await page.getByRole("button", { name: "Go" }).click();
  await expect(page.getByText(/Facebook · localbiz/)).toBeVisible();
  await page
    .getByLabel("Their question")
    .fill(
      "How long does Google Business Profile verification take for a new practice?",
    );
  await page.getByLabel("Their name (optional)").fill("Dan Miller");
  await page.getByRole("button", { name: "Draft reply" }).click();
  await expect(page.locator(".bubble-us.draft")).toBeVisible();

  const status = page.locator(".thread-head .pill");
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

  // They answer our comment: the link of their reply opens the same thread.
  await page.goto("/marketing");
  await page
    .getByLabel("Paste a Reddit or Facebook link or the post's code")
    .fill(`${post}?comment_id=555&reply_comment_id=777`);
  await page.getByRole("button", { name: "Go" }).click();
  await page
    .getByLabel("Their reply")
    .fill("Thanks! Is video verification faster?");
  await page.getByRole("button", { name: "Add reply" }).click();
  await expect(status).toHaveText("Waiting for us");

  // The post's code on its own finds it too.
  await page.goto("/marketing");
  await page
    .getByLabel("Paste a Reddit or Facebook link or the post's code")
    .fill(code);
  await page.getByRole("button", { name: "Go" }).click();
  await expect(
    page.locator(".bubble-them", { hasText: "Is video verification faster?" }),
  ).toBeVisible();
  await page
    .getByLabel("Instruction for the draft (optional)")
    .last()
    .fill("mention us");
  await page.getByRole("button", { name: "Draft reply" }).last().click();
  await expect(page.locator(".bubble-us.draft").last()).toContainText(
    "(I work at GridRankers.)",
  );
});
