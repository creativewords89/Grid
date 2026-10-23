import { expect, test } from "@playwright/test";
import { haveDocument, signIn } from "./helpers";

// SPEC 6.10 (step 17): Facebook posts have no usable links, so conversations are found by
// the person's name: start one, post it, then find it again by name for their reply.
test("Facebook: new conversation by name → posted → found by name → follow-up", async ({
  page,
}) => {
  await signIn(page);
  await haveDocument(page, "Client handbook.csv");
  const name = `Dan Miller ${Date.now().toString(36).slice(-4)}`;

  // Nobody by that name yet: start a new conversation and draft.
  await page.goto("/marketing");
  await page.getByRole("tab", { name: "Facebook" }).click();
  await page.getByLabel("Their name on Facebook").fill(name);
  await page.getByRole("button", { name: "Find" }).click();
  await expect(
    page.getByText(`No earlier conversations with ${name}.`),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `+ New conversation with ${name}` })
    .click();
  await page
    .getByLabel("Their question")
    .fill(
      "How long does Google Business Profile verification take for a new practice?",
    );
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
  await page.getByRole("button", { name: "Save as posted" }).click();
  await expect(status).toHaveText("Waiting for them");

  // Days later they reply: find the conversation by their name, closest one marked.
  await page.goto("/marketing");
  await page.getByRole("tab", { name: "Facebook" }).click();
  await page.getByLabel("Their name on Facebook").fill(name.toLowerCase());
  await page
    .getByLabel(/Their new message/)
    .fill("Thanks! Is video verification faster?");
  await page.getByRole("button", { name: "Find" }).click();
  const match = page.locator(".name-match", {
    hasText: "How long does Google Business Profile",
  });
  await expect(match.getByText("Closest match")).toBeVisible();
  await expect(match.getByText(/Our last reply/)).toBeVisible();
  await match.getByRole("button", { name: "This one" }).click();

  // Their message is ready to add; add it and draft the follow-up.
  await expect(page.getByLabel("Their reply")).toHaveValue(
    "Thanks! Is video verification faster?",
  );
  await page.getByRole("button", { name: "Add reply" }).click();
  await expect(status).toHaveText("Waiting for us");
  await page
    .getByLabel("Instruction for the draft (optional)")
    .last()
    .fill("mention us");
  await page.getByRole("button", { name: "Draft reply" }).last().click();
  await expect(page.locator(".bubble-us.draft").last()).toContainText(
    "(I work at GridRankers.)",
  );
});
