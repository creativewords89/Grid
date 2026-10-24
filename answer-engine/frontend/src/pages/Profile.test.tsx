import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

beforeEach(() => window.history.pushState(null, "", "/profile"));
afterEach(() => vi.unstubAllGlobals());

test("linking Telegram shows a code, then confirms", async () => {
  let linked = false;
  mockApi({
    "GET /auth/me": () => [
      200,
      { user: makeUser({ role: "reviewer", telegram_linked: linked }), csrf_token: "t" },
    ],
    "GET /reviews/count": [200, { waiting: 0 }],
    "POST /me/telegram-link": [
      200,
      { code: "ABCD2345", expires_at: "2026-10-09T10:10:00Z", bot_username: "gr_answers_bot" },
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Link Telegram" }));
  expect(await screen.findByText("/link ABCD2345")).toBeVisible();
  expect(screen.getByRole("link", { name: "Open the bot in Telegram" })).toHaveAttribute(
    "href",
    "https://t.me/gr_answers_bot?start=ABCD2345",
  );
  linked = true;
  await userEvent.click(screen.getByRole("button", { name: "I've sent it" }));

  expect(await screen.findByText("Your Telegram is linked.")).toBeVisible();
  expect(screen.getByText("✔ Linked")).toBeVisible();
});

test("without a bot the reason is shown", async () => {
  mockApi({
    "GET /auth/me": [200, { user: makeUser(), csrf_token: "t" }],
    "POST /me/telegram-link": [
      409,
      { error: { code: "not_configured", message: "Telegram isn't set up yet. Ask the Owner." } },
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Link Telegram" }));
  expect(await screen.findByText("Telegram isn't set up yet. Ask the Owner.")).toBeVisible();
});

test("choosing how to be notified", async () => {
  const calls = mockApi({
    "GET /auth/me": [200, { user: makeUser(), csrf_token: "t" }],
    "PATCH /me": (body) => [200, makeUser(body as object)],
  });
  render(<App />);

  const telegram = await screen.findByRole("radio", { name: /Telegram/ });
  expect(telegram).toBeDisabled(); // not linked yet
  expect(screen.getByRole("radio", { name: /Email/ })).toBeChecked();
  await userEvent.click(screen.getByRole("radio", { name: /In the app only/ }));

  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ notify_channel: "in_app" });
  expect(await screen.findByRole("radio", { name: /In the app only/ })).toBeChecked();
});
