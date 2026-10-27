import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { Overview } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const overview = (canChange: boolean): Overview => ({
  daily_total_budget_usd: "20.00",
  time_zone: "Asia/Dhaka",
  spent_today_usd: "5.0000",
  spent_this_month_usd: "61.2500",
  can_change: canChange,
  agents: [],
});

beforeEach(() => window.history.pushState(null, "", "/"));
afterEach(() => vi.unstubAllGlobals());

test("shows today's and this month's costs", async () => {
  mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "admin" }), csrf_token: "t" }],
    "GET /overview": [200, overview(false)],
    "GET /health": [200, { status: "ok", version: "0.1.0", checks: { database: "ok" } }],
  });
  render(<App />);

  expect(await screen.findByText("$5.00")).toBeVisible();
  expect(screen.getByText("of $20.00 for all agents")).toBeVisible();
  expect(screen.getByText("$61.25")).toBeVisible();
  expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "25");
  expect(screen.getByText("No agents yet.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Change the total budget" })).not.toBeInTheDocument();
});

test("the Owner changes the total budget", async () => {
  const calls = mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "owner" }), csrf_token: "t" }],
    "GET /overview": [200, overview(true)],
    "PUT /budget": [200, {}],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Change the total budget" }));
  const amount = screen.getByLabelText("Total daily budget (USD)");
  await userEvent.clear(amount);
  await userEvent.type(amount, "35");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByRole("button", { name: "Change the total budget" })).toBeVisible();
  expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
    daily_total_budget_usd: "35",
    time_zone: "Asia/Dhaka",
  });
});

test("recent alerts and, for Owners, where alerts go", async () => {
  const calls = mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "owner" }), csrf_token: "t" }],
    "GET /overview": [200, overview(true)],
    "GET /alerts": [
      200,
      [
        {
          id: "a1",
          kind: "run_failed",
          title: "GBP audit failed",
          body: "DataForSEO down.",
          created_at: "2026-10-27T10:00:00Z",
          sent_at: "2026-10-27T10:00:30Z",
          emailed_to: 2,
          telegram_sent: true,
          error: null,
        },
      ],
    ],
    "GET /alert-settings": [
      200,
      {
        alerts_telegram: true,
        daily_summary: true,
        daily_summary_time: "08:00",
        low_balance_usd: "10.00",
        can_change: true,
      },
    ],
    "PUT /alert-settings": (body) => [200, { ...(body as object), can_change: true }],
  });
  render(<App />);

  expect(await screen.findByText("GBP audit failed")).toBeVisible();
  expect(screen.getByText("Emailed to 2 · sent to Telegram")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Alert settings" }));
  await userEvent.click(screen.getByLabelText("A daily summary in the Telegram group"));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(calls.find((c) => c.path === "/alert-settings" && c.method === "PUT")?.body).toEqual({
    alerts_telegram: true,
    daily_summary: false,
    daily_summary_time: "08:00",
    low_balance_usd: "10.00",
  });
});
