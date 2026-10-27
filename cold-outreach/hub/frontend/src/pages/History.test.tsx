import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { HistoryEntry } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

function entry(id: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    at: "2026-10-27T08:00:00Z",
    actor: "Olivia",
    action: "edit",
    entity: "budget",
    entity_id: null,
    title: "Total daily budget",
    changes: [{ field: "daily_total_budget_usd", from: "20.00", to: "35.00" }],
    ...overrides,
  };
}

beforeEach(() => window.history.pushState(null, "", "/history"));
afterEach(() => vi.unstubAllGlobals());

test("Owners see who changed what, filter it and load older entries", async () => {
  const calls = mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "owner" }), csrf_token: "t" }],
    "GET /history": [200, { entries: [entry("e1")], more: true }],
    "GET /history?before=2026-10-27T08%3A00%3A00Z": [
      200,
      {
        entries: [
          entry("e0", {
            actor: null,
            action: "update",
            entity: "connections",
            title: "Connections",
            changes: [{ field: "pagespeed_api_key", from: null, to: "(changed)" }],
          }),
        ],
        more: false,
      },
    ],
    "GET /history?entity=user": [200, { entries: [], more: false }],
  });
  render(<App />);

  const rows = await screen.findAllByRole("row");
  expect(within(rows[1]!).getByText("Olivia")).toBeVisible();
  expect(within(rows[1]!).getByText("daily_total_budget_usd: 20.00 → 35.00")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show older" }));
  expect(await screen.findByText("pagespeed_api_key: — → (changed)")).toBeVisible();
  expect(screen.getByText("the Hub")).toBeVisible();

  await userEvent.selectOptions(screen.getByLabelText("What"), "user");
  expect(await screen.findByText("Nothing yet.")).toBeVisible();
  expect(calls.some((c) => c.path === "/history?entity=user")).toBe(true);
});

test("History isn't in an Admin's menu", async () => {
  mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "admin" }), csrf_token: "t" }],
    "GET /overview": [500, { error: { code: "x", message: "x" } }],
    "GET /alerts": [200, []],
  });
  render(<App />);

  expect(await screen.findByRole("link", { name: "Overview" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "History" })).not.toBeInTheDocument();
});
