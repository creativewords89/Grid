import { expect, test } from "@playwright/test";
import { ask, haveDocument, signIn } from "./helpers";

// SPEC 6.4: a deleted file is never used in an answer again, even before Pinecone catches up.
test("delete a file → it is never cited again", async ({ page }) => {
  await signIn(page);
  await haveDocument(page, "Old price list.csv");
  const question = "How much does the Platinum plan cost per month?";

  await ask(page, question);
  const sources = page
    .locator(".bubble-answer")
    .last()
    .getByRole("list", { name: "Sources" });
  await expect(sources.getByText(/Old price list\.csv/)).toBeVisible();

  await page.goto("/documents");
  await page
    .getByRole("row")
    .filter({ hasText: "Old price list.csv" })
    .getByRole("button", { name: "Delete" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(
    page.getByText("Old price list.csv was moved to the trash."),
  ).toBeVisible();

  await ask(page, question);
  const answer = page.locator(".bubble-answer").last();
  // 👍 appears once the answer is finished and saved.
  await expect(
    answer.getByRole("button", { name: "Helpful", exact: true }),
  ).toBeVisible();
  await expect(answer.getByText(/Old price list\.csv/)).toHaveCount(0);
  await expect(answer).not.toContainText("Platinum");
});
