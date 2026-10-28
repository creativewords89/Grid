import { expect, test } from "@playwright/test";
import path from "node:path";
import { signIn } from "./helpers";

// SPEC 6.13: the Owner uploads Facebook examples, the AI writes the style guide, and Try it
// drafts with the closest example.
test("Brand voice: upload Facebook examples, get a style guide, try a question", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/documents");
  await page.getByRole("tab", { name: "Brand voice" }).click();
  await page.getByRole("tab", { name: "Facebook" }).click();

  await page
    .locator("#bv-upload")
    .setInputFiles(path.join("fixtures", "Facebook examples.csv"));
  await expect(page.getByText(/Added 2 examples\./)).toBeVisible();
  await expect(page.getByText("Can I use a PO box for my GBP?")).toBeVisible();

  // The worker writes the style guide from the examples.
  await page.getByRole("button", { name: "Style guide & rules" }).click();
  await expect(async () => {
    await page.reload();
    await page.getByRole("tab", { name: "Brand voice" }).click();
    await page.getByRole("tab", { name: "Facebook" }).click();
    await page.getByRole("button", { name: "Style guide & rules" }).click();
    await expect(
      page.getByText(/End with a small question back to them/),
    ).toBeVisible({
      timeout: 2000,
    });
  }).toPass({ timeout: 30_000 });

  // Try it, once the examples have reached the search index (the worker syncs every 10 s).
  await page.getByRole("button", { name: "Try it" }).click();
  await page
    .getByLabel("Their question")
    .fill(
      "How long does Google Business Profile verification take for a dentist?",
    );
  await expect(async () => {
    await page.getByRole("button", { name: "Write a test draft" }).click();
    await expect(
      page.getByText("Examples it copied the style from"),
    ).toBeVisible({
      timeout: 3000,
    });
  }).toPass({ timeout: 40_000 });
  await expect(
    page.getByText(/Verification usually takes 5 to 14 days/),
  ).toBeVisible();
  await expect(
    page.locator(".bv-example", {
      hasText: "How long does Google Business Profile verification take?",
    }),
  ).toBeVisible();
});
