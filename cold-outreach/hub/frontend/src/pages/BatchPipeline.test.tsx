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
            job: "GBP Audit",
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
            job: "Opportunity Finder",
            name: "Opportunity Finder",
            needs: [{ task_id: "t1", name: "GBP Audit" }],
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
    bots: [
      { key: "gbp-full", name: "GBP audit (DataForSEO)", enabled: true, about: "" },
      { key: "gbp-quick", name: "GBP quick check", enabled: true, about: "" },
    ],
    batches: ["Texas November"],
  },
  {
    id: "t2",
    key: "opportunity",
    name: "Opportunity Finder",
    bots: [{ key: "opp", name: "Opportunity finder", enabled: true, about: "" }],
    batches: [],
  },
];

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];

beforeEach(() => window.history.pushState(null, "", "/batches"));
afterEach(() => vi.unstubAllGlobals());

test("a batch's tasks: add another agent to a task, choose how they share, then start", async () => {
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
  await userEvent.click(await screen.findByRole("tab", { name: "Tasks" })); // opens on Cities
  const gbp = await screen.findByRole("article", { name: "GBP Audit" });
  expect(within(gbp).getByText(/2,800 done · 10 ready · avg score 54/)).toBeVisible();
  const opportunity = screen.getByRole("article", { name: "Opportunity Finder" });
  expect(within(opportunity).getByText(/No agent yet/)).toBeVisible();
  expect(within(opportunity).getByText(/Needs: GBP Audit/)).toBeVisible();

  await userEvent.selectOptions(
    within(gbp).getByLabelText("Add another agent to GBP Audit"),
    "gbp-quick",
  );
  expect(await within(gbp).findByText("GBP quick check")).toBeVisible();
  await userEvent.selectOptions(within(gbp).getByLabelText(/How the agents share/), "split");
  await userEvent.click(screen.getByRole("button", { name: "Start" }));

  expect(await screen.findByRole("button", { name: "Pause" })).toBeVisible();
  expect(calls.find((c) => c.path === "/batches/b1/tasks/t1/bots")?.body).toEqual({
    key: "gbp-quick",
  });
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ share: "split" });
});

test("an agent from the library is added to its task, and the task first when missing", async () => {
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
  await userEvent.click(await screen.findByRole("tab", { name: "Tasks" })); // opens on Cities
  expect(await screen.findByText(/To start: Add a task first/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  const library = screen.getByRole("region", { name: "Agent library" });
  await userEvent.click(
    await within(library).findByRole("button", { name: "Add GBP audit (DataForSEO) to GBP Audit" }),
  );

  expect(await screen.findByRole("article", { name: "GBP Audit" })).toBeVisible();
  expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
    "/batches/b1/tasks",
    "/batches/b1/tasks/t1/bots",
  ]);
});

test("each agent's results: counts, filters and its leads", async () => {
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
  await userEvent.click(await screen.findByRole("tab", { name: "Tasks" })); // opens on Cities
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

test("add a task: its job, its name and what it needs first in this batch", async () => {
  const outreach: Task = {
    id: "t3",
    key: "outreach",
    name: "Outreach email",
    bots: [{ key: "mail", name: "Outreach email (friendly)", enabled: true, about: "" }],
    batches: [],
  };
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": [200, [batch()]],
    "GET /imports?batch_id=b1": [200, []],
    "GET /batches/b1/pipeline": [200, pipeline()],
    "GET /tasks": [200, [...TASKS, outreach]],
    "POST /batches/b1/tasks": [201, pipeline()],
    "PATCH /batches/b1/tasks/t2": [200, pipeline()],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Texas November" }));
  await userEvent.click(await screen.findByRole("tab", { name: "Tasks" })); // opens on Cities
  await userEvent.click(await screen.findByRole("button", { name: /\+ Add a task to this batch/ }));
  const form = screen.getByRole("form", { name: "Add a task" });
  // Only jobs the batch doesn't have yet.
  expect(
    within(form)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["Outreach email (1 agent)"]);
  expect(within(form).getByLabelText("Name")).toHaveValue("Outreach email");
  await userEvent.clear(within(form).getByLabelText("Name"));
  await userEvent.type(within(form).getByLabelText("Name"), "First email");
  await userEvent.click(within(form).getByRole("checkbox", { name: "Opportunity Finder" }));
  await userEvent.click(within(form).getByRole("button", { name: "Add task" }));

  expect(calls.find((c) => c.method === "POST" && c.path === "/batches/b1/tasks")?.body).toEqual({
    task_id: "t3",
    name: "First email",
    needs: ["t2"],
  });

  // Edit a task: its name and needs.
  const opportunity = await screen.findByRole("article", { name: "Opportunity Finder" });
  await userEvent.click(
    within(opportunity).getByRole("button", { name: "Edit Opportunity Finder" }),
  );
  const edit = within(opportunity).getByRole("form", { name: "Edit Opportunity Finder" });
  expect(within(edit).getByRole("checkbox", { name: "GBP Audit" })).toBeChecked();
  await userEvent.click(within(edit).getByRole("checkbox", { name: "GBP Audit" }));
  await userEvent.click(within(edit).getByRole("button", { name: "Save" }));
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    name: "Opportunity Finder",
    needs: [],
  });
});

test("a new batch starts from the standard steps, before any agent exists", async () => {
  const jobs: Task[] = [
    { id: "t1", key: "gbp-audit", name: "GBP Audit", bots: [], batches: [] },
    { id: "t2", key: "opportunity", name: "Opportunity Finder", bots: [], batches: [] },
  ];
  const empty = pipeline({ steps: [], can_start: false, start_problem: "Add a task first." });
  const standard = pipeline();
  const first = standard.steps[0]?.tasks[0];
  if (first) first.bots = []; // no agent does GBP Audit yet
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": [200, [batch()]],
    "GET /imports?batch_id=b1": [200, []],
    "GET /batches/b1/pipeline": [200, empty],
    "GET /tasks": [200, jobs],
    "POST /batches/b1/tasks/standard": [200, standard],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Texas November" }));
  await userEvent.click(await screen.findByRole("tab", { name: "Tasks" })); // opens on Cities
  const library = await screen.findByRole("region", { name: "Agent library" });
  expect(within(library).getByText(/No agents yet/)).toBeVisible();
  expect(within(library).getByRole("link", { name: "Add one on Agents" })).toHaveAttribute(
    "href",
    "/agents",
  );
  await userEvent.click(screen.getByRole("button", { name: "Use the standard steps" }));

  expect(calls.some((c) => c.method === "POST" && c.path === "/batches/b1/tasks/standard")).toBe(
    true,
  );
  const gbp = await screen.findByRole("article", { name: "GBP Audit" });
  expect(within(gbp).getByText(/No agent does this job yet/)).toBeVisible();
  expect(within(gbp).getByRole("link", { name: "add one on Agents" })).toBeVisible();
  expect(within(gbp).queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Use the standard steps" })).not.toBeInTheDocument();
});
