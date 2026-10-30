import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import type { Agent, AgentTest, AgentTestReport, Batch } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

// Test runs (step 50): an agent tried now on a few leads, its report kept in the run.

const agent = {
  key: "gbp-audit",
  name: "GBP audit agent",
  kind: "gbp-audit",
  enabled: true,
  connected: true,
  last_seen_at: "2026-10-30T10:00:00Z",
  manifest: {
    name: "GBP audit agent",
    version: "0.1.0",
    description: "",
    settings: [],
    connections: ["dataforseo"],
    task: "gbp-audit",
    task_name: "GBP Audit",
    result_label: "GBP",
    cost_per_item_usd: 0.01,
  },
  config: {},
  daily_limit: 100,
  run_time: "02:00",
  time_zone: "UTC",
  daily_budget_usd: "5.00",
  task: { key: "gbp-audit", name: "GBP Audit" },
  batches: [],
  missing_connections: [],
  last_run: null,
  next_run_at: null,
  spent_today_usd: "0",
  results: 0,
} as unknown as Agent;

const test0: AgentTest = {
  id: "t1",
  trigger: "test",
  status: "succeeded",
  queued_at: "2026-10-30T11:02:00Z",
  started_at: "2026-10-30T11:02:10Z",
  finished_at: "2026-10-30T11:08:00Z",
  done: 2,
  failed: 0,
  skipped: 0,
  cost_usd: "0.0200",
  stop_reason: null,
  requested_by: "Sara",
  stop_requested: false,
  agent_key: "gbp-audit",
  agent_name: "GBP audit agent",
  what: "2 pasted GBP links",
  statuses: { COLLECTED: 1, NOT_FOUND: 1 },
};

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role, name: "Sara" }), csrf_token: "t" }] as [number, unknown];

afterEach(() => vi.unstubAllGlobals());

test("an Admin tests an agent on pasted GBP links and sees the test listed", async () => {
  window.history.pushState(null, "", "/agents");
  let tests: AgentTest[] = [];
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /agents": [200, [agent]],
    "GET /batches": [200, [{ id: "b1", name: "Construction", leads: 40 } as Batch]],
    "GET /agents/gbp-audit/tests": () => [200, tests],
    "POST /agents/gbp-audit/tests": () => {
      tests = [{ ...test0, status: "queued", statuses: {} }];
      return [201, tests[0]];
    },
  });
  render(<App />);

  const card = await screen.findByRole("article", { name: "GBP audit agent" });
  await userEvent.click(within(card).getByRole("button", { name: "Test" }));
  const dialog = await screen.findByRole("dialog", { name: "Test GBP audit agent" });
  expect(within(dialog).getByText(/5 leads · about \$0\.05/)).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "Paste GBP links" }));
  await userEvent.type(
    within(dialog).getByLabelText("GBP links"),
    "https://share.google/a{enter}https://share.google/b",
  );
  expect(within(dialog).getByText(/2 leads · about \$0\.02/)).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "Start test" }));

  expect(calls.find((c) => c.method === "POST")?.body).toEqual({
    links: ["https://share.google/a", "https://share.google/b"],
  });
  const listed = await within(card).findByRole("table", { name: "GBP audit agent test reports" });
  expect(within(listed).getByText("2 pasted GBP links")).toBeVisible();
  expect(within(listed).getByText("Waiting to start")).toBeVisible();
});

test("a Viewer sees the test reports but can't start a test", async () => {
  window.history.pushState(null, "", "/agents");
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /agents": [200, [agent]],
    "GET /agents/gbp-audit/tests": [200, [test0]],
  });
  render(<App />);
  const card = await screen.findByRole("article", { name: "GBP audit agent" });
  expect(await within(card).findByText("1 collected · 1 not found")).toBeVisible();
  expect(within(card).queryByRole("button", { name: "Test" })).not.toBeInTheDocument();
});

test("a test report shows each lead and what the GBP agent collected", async () => {
  window.history.pushState(null, "", "/agents/gbp-audit/tests/t1");
  const report: AgentTestReport = {
    ...test0,
    leads: [
      {
        key: "T-1",
        lead_id: "",
        business_name: "",
        city: "",
        gbp_link: "https://share.google/a",
        files: ["gbp.json"],
        result: {
          status: "COLLECTED",
          score: null,
          summary: "Collected: claimed · category General contractor",
          benchmark_id: null,
          benchmark_version: null,
          at: "2026-10-30T11:08:00Z",
          details: {
            agent: "gbp",
            data: {
              basics: { name: "Apex Builders", claimed: true, phone: null, hours: null },
              categories: { primary: "General contractor", additional: [], services: null },
              description: { text: null, length: 0 },
              photos: { total: 48, logo: "https://x/logo.jpg", cover: null },
              posts: {
                count: 1,
                last: "2026-10-01",
                last_30_days: 1,
                last_90_days: 1,
                items: [{ date: "2026-10-01", text: "Fall offer", image: true, button: "Call" }],
              },
              reviews: { count: 126, rating: 4.7, reply_pct: 40 },
              unknown: ["basics.phone", "categories.services"],
            },
          },
        },
      },
      {
        key: "T-2",
        lead_id: "",
        business_name: "",
        city: "",
        gbp_link: "https://share.google/b",
        files: [],
        result: {
          status: "NOT_FOUND",
          score: null,
          summary: "No Google Business Profile found.",
          benchmark_id: null,
          benchmark_version: null,
          at: "2026-10-30T11:08:00Z",
          details: {},
        },
      },
    ],
  };
  mockApi({ "GET /auth/me": as("owner"), "GET /agents/gbp-audit/tests/t1": [200, report] });
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "Test report · GBP audit agent" }),
  ).toBeVisible();
  const leads = screen.getByRole("table", { name: "Tested leads" });
  expect(within(leads).getByText("NOT_FOUND")).toBeVisible();
  const open = screen.getByRole("article", { name: "T-1" });
  expect(within(open).getByRole("heading", { name: "Apex Builders" })).toBeVisible();
  expect(within(open).getByText("General contractor")).toBeVisible();
  expect(within(open).getByText("Fall offer")).toBeVisible();
  expect(within(open).getAllByText("Not given by DataForSEO").length).toBeGreaterThan(0);
  expect(within(open).getByRole("link", { name: "Download gbp.json" })).toHaveAttribute(
    "href",
    "/api/agents/gbp-audit/tests/t1/files/T-1/gbp.json",
  );
  const nav = screen.getByRole("navigation", { name: "Main" });
  expect(within(nav).getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
});
