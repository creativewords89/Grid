import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { Run } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    trigger: "schedule",
    status: "succeeded",
    queued_at: "2026-10-27T20:00:00Z",
    started_at: "2026-10-27T20:00:05Z",
    finished_at: "2026-10-27T20:20:00Z",
    done: 95,
    failed: 3,
    skipped: 2,
    cost_usd: "0.9500",
    stop_reason: null,
    requested_by: null,
    stop_requested: false,
    agent_key: "gbp-audit",
    agent_name: "GBP audit",
    ...overrides,
  };
}

beforeEach(() => window.history.pushState(null, "", "/runs"));
afterEach(() => vi.unstubAllGlobals());

test("lists runs, filters them and shows older ones", async () => {
  const calls = mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "viewer" }), csrf_token: "t" }],
    "GET /agents": [200, []],
    "GET /runs": [200, { runs: [run("r1")], more: true }],
    "GET /runs?before=2026-10-27T20%3A00%3A00Z": [
      200,
      {
        runs: [
          run("r0", {
            status: "stopped",
            trigger: "manual",
            requested_by: "Sara",
            stop_reason: "The daily budget is used up.",
          }),
        ],
        more: false,
      },
    ],
    "GET /runs?status=failed": [200, { runs: [], more: false }],
  });
  render(<App />);

  const rows = await screen.findAllByRole("row");
  expect(within(rows[1]!).getByText("GBP audit")).toBeVisible();
  expect(within(rows[1]!).getByText("95 · 3 · 2")).toBeVisible();
  expect(within(rows[1]!).getByText("$0.95")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show older runs" }));
  expect(await screen.findByText("The daily budget is used up.")).toBeVisible();
  expect(screen.getByText("Run now by Sara")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Show older runs" })).not.toBeInTheDocument();

  await userEvent.selectOptions(screen.getByLabelText("Status"), "failed");
  expect(await screen.findByText("No runs yet.")).toBeVisible();
  expect(calls.some((c) => c.path === "/runs?status=failed")).toBe(true);
});
