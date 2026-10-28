import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { Batch, BotProgress, BotResults, Pipeline, Task } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

function batch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: "b1",
    name: "Texas November",
    niche: "Cleaning",
    benchmark: { id: "m1", name: "Cleaning Benchmark 1", version: 1 },
    leads: 3983,
    top: 12,
    files: 1,
    bots: ["GBP audit (DataForSEO)"],
    status: "not_started",
    position: 0,
    progress_pct: null,
    created_at: "2026-10-27T10:00:00Z",
    can_edit: true,
    can_rename: true,
    can_delete: false,
    can_run: true,
    ...overrides,
  };
}

function progress(key: string, name: string, done = 0): BotProgress {
  return {
    key,
    name,
    enabled: true,
    connected: true,
    done,
    failed: 0,
    ready: 10,
    waiting: 0,
    average_score: done ? 54 : null,
  };
}

function pipeline(overrides: Partial<Pipeline> = {}, gbpBots = 1): Pipeline {
  const bots = [progress("gbp-full", "GBP audit (DataForSEO)", 2800)];
  if (gbpBots > 1) bots.push(progress("gbp-quick", "GBP quick check"));
  return {
    batch: batch(),
    steps: [
      {
        step: 1,
        tasks: [
          {
            task_id: "t1",
            key: "gbp-audit",
            name: "GBP Audit",
            needs: [],
            share: "all",
            bots,
            can_remove: false,
          },
        ],
      },
      {
        step: 2,
        tasks: [
          {
            task_id: "t2",
            key: "opportunity",
            name: "Opportunity Finder",
            needs: ["GBP Audit"],
            share: "all",
            bots: [],
            can_remove: true,
          },
        ],
      },
    ],
    can_start: true,
    start_problem: null,
    ...overrides,
  };
}

const TASKS: Task[] = [
  {
    id: "t1",
    key: "gbp-audit",
    name: "GBP Audit",
    about: "",
    needs: [],
    bots: [
      { key: "gbp-full", name: "GBP audit (DataForSEO)", enabled: true },
      { key: "gbp-quick", name: "GBP quick check", enabled: true },
    ],
    batches: ["Texas November"],
    can_edit: true,
    can_delete: false,
  },
  {
    id: "t2",
    key: "opportunity",
    name: "Opportunity Finder",
    about: "",
    needs: [{ key: "gbp-audit", name: "GBP Audit" }],
    bots: [{ key: "opp", name: "Opportunity finder", enabled: true }],
    batches: [],
    can_edit: true,
    can_delete: false,
  },
];

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];

beforeEach(() => window.history.pushState(null, "", "/batches"));
afterEach(() => vi.unstubAllGlobals());

test("a batch's tasks: add another bot to a task, choose how they share, then start", async () => {
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": [200, [batch()]],
    "GET /lists": [200, []],
    "GET /imports?batch_id=b1": [200, []],
    "GET /batches/b1/pipeline": [200, pipeline()],
    "GET /tasks": [200, TASKS],
    "POST /batches/b1/tasks/t1/bots": [200, pipeline({}, 2)],
    "PATCH /batches/b1/tasks/t1": [200, pipeline({}, 2)],
    "POST /batches/b1/start": [
      200,
      pipeline({ batch: batch({ status: "running" }), can_start: false }, 2),
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Texas November" }));
  const gbp = await screen.findByRole("article", { name: "GBP Audit" });
  expect(within(gbp).getByText(/2,800 done · 10 ready · avg score 54/)).toBeVisible();
  const opportunity = screen.getByRole("article", { name: "Opportunity Finder" });
  expect(within(opportunity).getByText(/No bot yet/)).toBeVisible();
  expect(within(opportunity).getByText("Needs: GBP Audit")).toBeVisible();

  await userEvent.selectOptions(
    within(gbp).getByLabelText("Add another bot to GBP Audit"),
    "gbp-quick",
  );
  expect(await within(gbp).findByText("GBP quick check")).toBeVisible();
  await userEvent.selectOptions(within(gbp).getByLabelText(/How the bots share/), "split");
  await userEvent.click(screen.getByRole("button", { name: "Start" }));

  expect(await screen.findByRole("button", { name: "Pause" })).toBeVisible();
  expect(calls.find((c) => c.path === "/batches/b1/tasks/t1/bots")?.body).toEqual({
    key: "gbp-quick",
  });
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ share: "split" });
});

test("a bot from the library is added to its task, and the task first when missing", async () => {
  const empty = pipeline({ steps: [], can_start: false, start_problem: "Add a task first." });
  const calls = mockApi({
    "GET /auth/me": as("owner"),
    "GET /batches": [200, [batch()]],
    "GET /lists": [200, []],
    "GET /imports?batch_id=b1": [200, []],
    "GET /batches/b1/pipeline": [200, empty],
    "GET /tasks": [200, TASKS],
    "POST /batches/b1/tasks": [201, empty],
    "POST /batches/b1/tasks/t1/bots": [200, pipeline()],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Texas November" }));
  expect(await screen.findByText(/To start: Add a task first/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  const library = screen.getByRole("complementary", { name: "Bot library" });
  await userEvent.click(
    await within(library).findByRole("button", { name: "Add GBP audit (DataForSEO) to GBP Audit" }),
  );

  expect(await screen.findByRole("article", { name: "GBP Audit" })).toBeVisible();
  expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
    "/batches/b1/tasks",
    "/batches/b1/tasks/t1/bots",
  ]);
});

test("each bot's results: counts, filters and its leads", async () => {
  const results: BotResults = {
    bot: "gbp-full",
    bot_name: "GBP audit (DataForSEO)",
    outcomes: { done: 2800, skipped: 3, failed: 12, not_yet: 1168 },
    bands: { low: 1600, mid: 900, high: 300 },
    leads: [
      {
        lead_id: "L-000001",
        business_name: "Sparkle Home Cleaning",
        city: "Dallas",
        outcome: "done",
        status: "OK",
        score: 22,
        summary: "Few photos, no posts in 90 days.",
        at: "2026-10-28T04:00:00Z",
      },
    ],
    total: 1600,
    page: 1,
    pages: 16,
  };
  const calls = mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, [batch({ can_run: false, can_edit: false })]],
    "GET /lists": [200, []],
    "GET /imports?batch_id=b1": [200, []],
    "GET /batches/b1/pipeline": [200, pipeline({ can_start: false })],
    "GET /tasks": [200, TASKS],
    "GET /batches/b1/results?bot=gbp-full&page=1": [200, results],
    "GET /batches/b1/results?bot=gbp-full&band=low&page=1": [200, results],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Texas November" }));
  expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "Results" }));
  expect(await screen.findByText("Sparkle Home Cleaning")).toBeVisible();
  expect(screen.getByText("Few photos, no posts in 90 days.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /1,600\s*Score Under 40/ }));

  expect(screen.getByRole("button", { name: /1,600\s*Score Under 40/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(calls.some((c) => c.path === "/batches/b1/results?bot=gbp-full&band=low&page=1")).toBe(
    true,
  );
});

test("the running order: move a batch up", async () => {
  const second = batch({ id: "b2", name: "Florida December", position: 1 });
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": [200, [batch(), second]],
    "GET /lists": [200, []],
    "PUT /batches/order": [200, [second, batch()]],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Move Florida December up" }));

  expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ ids: ["b2", "b1"] });
  const rows = await screen.findAllByRole("row");
  expect(rows[1]).toHaveTextContent("Florida December");
});
