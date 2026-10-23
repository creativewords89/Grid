import { expect, test } from "@playwright/test";
import {
  ALI_TELEGRAM_ID,
  GROUP,
  ask,
  haveDocument,
  signIn,
  telegramUpdate,
  waitForSent,
} from "./helpers";

// SPEC 6.7 and 6.8: a low-confidence answer goes to the Telegram group, a reviewer
// corrects it there, and the asker sees the correction in place.
test("ask → low confidence → Telegram edit → the asker sees the correction", async ({
  page,
}) => {
  await signIn(page);
  await haveDocument(page, "Client handbook.csv");

  const question = "How long does onboarding take for a new client?";
  await ask(page, question);
  // The fake support check calls answers about "how long" only partly supported.
  await expect(page.getByText("🟠 Being checked by our team")).toBeVisible();

  const card = await waitForSent(
    (m) =>
      m.method === "sendMessage" &&
      !!m.text?.includes("Review needed") &&
      !!m.text?.includes(question),
    "the review card is posted to the group",
  );
  const reviewId =
    card.reply_markup!.inline_keyboard[0]![0]!.callback_data.split(":")[1];

  // Ali taps ✏️ Edit, then replies to the bot's prompt with the correct answer.
  await telegramUpdate({
    update_id: 101,
    callback_query: {
      id: "cb-1",
      from: { id: ALI_TELEGRAM_ID },
      message: { message_id: card.id, chat: { id: GROUP } },
      data: `rv:${reviewId}:edit`,
    },
  });
  const prompt = await waitForSent(
    (m) => m.method === "sendMessage" && m.id > card.id,
    "the bot asks for the corrected answer",
  );
  const correction =
    "Onboarding takes three weeks: kickoff call, audit, then the first report.";
  await telegramUpdate({
    update_id: 102,
    message: {
      message_id: 9001,
      from: { id: ALI_TELEGRAM_ID },
      chat: { id: GROUP, type: "supergroup" },
      text: correction,
      reply_to_message: { message_id: prompt.id },
    },
  });
  await waitForSent(
    (m) => m.method === "editMessageText" && m.message_id === card.id,
    "the group card shows the decision",
  );

  // The asker's chat shows the corrected answer, in place of the original.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("✔ Corrected by our team")).toBeVisible({
      timeout: 2000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(page.locator(".bubble-answer").last()).toContainText(correction);
});
