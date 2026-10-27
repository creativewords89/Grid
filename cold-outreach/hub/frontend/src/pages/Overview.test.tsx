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
