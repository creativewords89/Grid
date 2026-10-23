import { expect, type Page } from "@playwright/test";
import path from "node:path";

export const API = "http://localhost:8100";
const TELEGRAM = "http://127.0.0.1:9917";
export const GROUP = -100777; // seeded as the review group (seed.py)
export const ALI_TELEGRAM_ID = 5001;

export const OWNER = {
  email: "olivia@example.com",
  password: "olivia owner passphrase",
};

export async function signIn(page: Page, who = OWNER): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ask" })).toBeVisible();
}

export type Sent = {
  method: string;
  id: number;
  text?: string;
  message_id?: number;
  reply_markup?: {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
};

/** What the bot has sent to Telegram so far. */
export async function telegram(): Promise<Sent[]> {
  return (await (await fetch(`${TELEGRAM}/_sent`)).json()) as Sent[];
}

export async function waitForSent(
  match: (sent: Sent) => boolean,
  label: string,
): Promise<Sent> {
  let found: Sent | undefined;
  await expect
    .poll(async () => (found = (await telegram()).find(match)) !== undefined, {
      message: label,
    })
    .toBe(true);
  return found!;
}

/** An update from Telegram, as its webhook would deliver it. */
export async function telegramUpdate(update: object): Promise<void> {
  const response = await fetch(`${API}/api/telegram/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "e2e-webhook-secret-123",
    },
    body: JSON.stringify(update),
  });
  expect(response.status).toBe(200);
}

/** Upload a file from fixtures/ (unless it's there already) and wait until it's searchable. */
export async function haveDocument(page: Page, name: string): Promise<void> {
  await page.goto("/documents");
  const row = page.getByRole("row").filter({ hasText: name });
  await page.getByRole("heading", { name: "Documents" }).waitFor();
  await page.waitForLoadState("networkidle");
  if ((await row.count()) === 0) {
    await page
      .getByTestId("upload-input")
      .setInputFiles(path.join("fixtures", name));
  }
  await expect(async () => {
    await page.reload();
    await expect(row.locator(".pill", { hasText: "Ready" })).toBeVisible({
      timeout: 2000,
    });
    await expect(row.getByText("Sync pending")).toHaveCount(0, {
      timeout: 1000,
    });
  }).toPass({ timeout: 60_000 });
}

export async function ask(page: Page, question: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "+ New chat" }).click();
  const box = page.getByLabel("Your question");
  await box.fill(question);
  await box.press("Enter");
}
