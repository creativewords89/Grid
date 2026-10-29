import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { Agent } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    key: "gbp-audit",
    name: "GBP audit",
    kind: null,
    enabled: true,
    connected: true,
    last_seen_at: new Date().toISOString(),
    manifest: {
      name: "GBP audit",
      version: "1.0.0",
      description: "Audits Google Business Profiles.",
      settings: [
        {
          key: "batch_size",
          type: "int",
          label: "Batch size",
          help: "",
          default: 20,
          min: 1,
          max: 100,
          choices: [],
        },
        {
          key: "queue",
          type: "choice",
          label: "Queue",
          help: "",
          default: "standard",
          min: null,
          max: null,
          choices: ["standard", "priority"],
        },
        {
          key: "dry_run",
          type: "bool",
          label: "Dry run",
          help: "",
          default: false,
          min: null,
          max: null,
          choices: [],
        },
      ],
      connections: ["dataforseo"],
      result_label: "GBP",
      cost_per_item_usd: 0.01,
    },
    config: { batch_size: 20, queue: "standard", dry_run: false },
    daily_limit: 100,
    run_time: "02:00",
    time_zone: "Asia/Dhaka",
    daily_budget_usd: "5.00",
    task: { key: "gbp-audit", name: "GBP Audit" },
    batches: [],
    missing_connections: [],
    last_run: null,
    next_run_at: "2026-10-28T20:00:00Z",
    spent_today_usd: "0.4000",
    ...overrides,
  };
}

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role, name: "Sara" }), csrf_token: "t" }] as [number, unknown];

beforeEach(() => window.history.pushState(null, "", "/agents"));
afterEach(() => vi.unstubAllGlobals());

test("a card shows the agent, its connection and its last run", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /agents": [
      200,
      [
        agent({
          missing_connections: ["dataforseo"],
          last_run: {
            id: "r1",
            trigger: "manual",
            status: "succeeded",
            queued_at: new Date().toISOString(),
            started_at: null,
            finished_at: new Date().toISOString(),
            done: 98,
            failed: 2,
            skipped: 0,
            cost_usd: "0.9800",
            stop_reason: null,
            requested_by: "Sara",
            stop_requested: false,
            agent_key: "gbp-audit",
            agent_name: "GBP audit",
          },
        }),
      ],
    ],
  });
  render(<App />);

  const card = await screen.findByRole("article", { name: "GBP audit" });
  expect(within(card).getByText("Connected")).toBeVisible();
  expect(within(card).getByText(/Needs these connections first: DataForSEO/)).toBeVisible();
  expect(within(card).getByText(/98 done, 2 failed/)).toHaveTextContent("$0.98");
  expect(within(card).getByText(/Spent today: \$0.40 of \$5.00/)).toBeVisible();
  expect(within(card).getByText(/No batch yet/)).toBeVisible();
  // A Viewer looks but can't change anything.
  expect(within(card).getByRole("switch")).toBeDisabled();
  expect(within(card).queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
  expect(within(card).queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
});

test("an Admin switches an agent off and runs it", async () => {
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /agents": [200, [agent()]],
    "PUT /agents/gbp-audit/enabled": (body) => [
      200,
      agent({ enabled: (body as { enabled: boolean }).enabled }),
    ],
    "POST /agents/gbp-audit/run": [201, {}],
  });
  render(<App />);

  const card = await screen.findByRole("article", { name: "GBP audit" });
  await userEvent.click(within(card).getByRole("button", { name: "Run now" }));
  expect(await within(card).findByText(/Run queued/)).toBeVisible();
  expect(within(card).queryByRole("button", { name: "New token" })).not.toBeInTheDocument();
  await userEvent.click(within(card).getByRole("switch"));

  expect(await within(card).findByText("Off")).toBeVisible();
  expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: false });
  expect(calls.some((c) => c.path === "/agents/gbp-audit/run")).toBe(true);
});

test("the settings form is built from the manifest and sends typed values", async () => {
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /agents": [
      200,
      [
        agent({
          batches: [
            { id: "b2", name: "Batch 2", status: "running", ready: true, task_name: "GBP Audit" },
            { id: "b1", name: "Batch 1", status: "paused", ready: true, task_name: "Profiles" },
          ],
        }),
      ],
    ],
    "PATCH /agents/gbp-audit": [200, agent({ config: { batch_size: 50 } })],
  });
  render(<App />);

  const card = await screen.findByRole("article", { name: "GBP audit" });
  // Its job, and the batches and tasks it is on, running ones first.
  expect(within(card).getByText(/Does:/).parentElement).toHaveTextContent("Does: GBP Audit");
  expect(within(card).getByText(/Used in:/).parentElement).toHaveTextContent(
    "Used in: Batch 2 · GBP Audit, Batch 1 · Profiles (paused)",
  );
  await userEvent.click(within(card).getByRole("button", { name: "Settings" }));
  const dialog = screen.getByRole("dialog", { name: "GBP audit settings" });
  const batch = within(dialog).getByLabelText("Batch size");
  await userEvent.clear(batch);
  await userEvent.type(batch, "50");
  await userEvent.selectOptions(within(dialog).getByLabelText("Queue"), "priority");
  await userEvent.click(within(dialog).getByLabelText("Dry run"));
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

  expect(await within(card).findByText("Settings saved.")).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    config: { batch_size: 50, queue: "priority", dry_run: true },
    daily_limit: 100,
    run_time: "02:00",
    time_zone: "Asia/Dhaka",
    daily_budget_usd: "5.00",
  });
});

test("a settings error from the server shows under its field", async () => {
  mockApi({
    "GET /auth/me": as("owner"),
    "GET /agents": [200, [agent()]],
    "PATCH /agents/gbp-audit": [
      422,
      {
        error: {
          code: "invalid",
          message: "Batch size must be at most 100.",
          fields: { "config.batch_size": "Batch size must be at most 100." },
        },
      },
    ],
  });
  render(<App />);

  const card = await screen.findByRole("article", { name: "GBP audit" });
  await userEvent.click(within(card).getByRole("button", { name: "Settings" }));
  const dialog = screen.getByRole("dialog", { name: "GBP audit settings" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

  expect(await within(dialog).findAllByText("Batch size must be at most 100.")).toHaveLength(2);
});

const KINDS = [{ key: "demo", name: "Demo agent", about: "Pretends to do a job.", job: null }];
const JOBS = [
  { id: "t1", key: "gbp-audit", name: "GBP Audit", bots: [], batches: [] },
  { id: "t2", key: "website-audit", name: "Website Audit", bots: [], batches: [] },
];

test("the Owner adds a built-in agent: its kind and job, no token (step 25)", async () => {
  let added = false;
  const demo = agent({
    key: "demo-website",
    name: "Demo website",
    kind: "demo",
    manifest: null,
    connected: false,
    last_seen_at: null,
    task: { key: "website-audit", name: "Website Audit" },
  });
  const calls = mockApi({
    "GET /auth/me": as("owner"),
    "GET /agents": () => [200, added ? [demo] : []],
    "GET /agents/kinds": [200, KINDS],
    "GET /tasks": [200, JOBS],
    "POST /agents": () => {
      added = true;
      return [201, { agent: demo, token: null }];
    },
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "+ Add agent" }));
  const dialog = screen.getByRole("dialog", { name: "Add an agent" });
  expect(await within(dialog).findByText("Pretends to do a job.")).toBeVisible();
  expect(within(dialog).queryByLabelText("Key")).not.toBeInTheDocument();
  await userEvent.selectOptions(within(dialog).getByLabelText("Job it does"), "t2");
  await userEvent.type(within(dialog).getByLabelText("Name"), "Demo website");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add agent" }));

  const card = await screen.findByRole("article", { name: "Demo website" });
  expect(calls.find((c) => c.method === "POST")?.body).toEqual({
    kind: "demo",
    name: "Demo website",
    task_id: "t2",
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); // no token to show
  expect(within(card).getByText("Starting in the Hub…")).toBeVisible();
  expect(within(card).queryByRole("button", { name: "New token" })).not.toBeInTheDocument();
  expect(within(card).queryByText("How to start it")).not.toBeInTheDocument();
});

test("the Owner adds an agent of their own and sees its token once", async () => {
  const calls = mockApi({
    "GET /auth/me": as("owner"),
    "GET /agents": [200, []],
    "GET /agents/kinds": [200, KINDS],
    "GET /tasks": [200, JOBS],
    "POST /agents": [
      201,
      {
        agent: agent({ key: "web-audit", name: "Website audit", manifest: null }),
        token: "hub_agent_abc123",
      },
    ],
  });
  render(<App />);

  expect(await screen.findByText(/No agents yet/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "+ Add agent" }));
  const dialog = screen.getByRole("dialog", { name: "Add an agent" });
  await within(dialog).findByText("Pretends to do a job.");
  await userEvent.selectOptions(within(dialog).getByLabelText("Kind of agent"), "own");
  await userEvent.type(within(dialog).getByLabelText("Name"), "Website audit");
  await userEvent.type(within(dialog).getByLabelText("Key"), "web-audit");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add and show the token" }));

  const tokenDialog = await screen.findByRole("dialog", { name: "Token for Website audit" });
  expect(within(tokenDialog).getByRole("textbox", { name: "Agent token" })).toHaveValue(
    "hub_agent_abc123",
  );
  // The command that starts it on the server, with its token.
  const demo = within(tokenDialog).getByLabelText(/Demo agent \(pretends to work/);
  expect(demo).toHaveTextContent("--name web-audit");
  expect(demo).toHaveTextContent("AGENT_TOKEN=hub_agent_abc123");
  expect(demo).toHaveTextContent("--network agent-hub");
  expect(calls.find((c) => c.method === "POST")?.body).toEqual({
    key: "web-audit",
    name: "Website audit",
  });
});

test("each card says where the agent is in its setup", async () => {
  mockApi({
    "GET /auth/me": as("admin"),
    "GET /agents": [
      200,
      [
        agent({ key: "new-one", name: "New one", manifest: null, last_seen_at: null }),
        agent({ key: "idle", name: "Idle", batches: [] }),
        agent({
          key: "ready",
          name: "Ready",
          batches: [
            { id: "b1", name: "Batch 1", status: "running", ready: true, task_name: "GBP Audit" },
          ],
        }),
      ],
    ],
  });
  render(<App />);

  const fresh = await screen.findByRole("article", { name: "New one" });
  expect(within(fresh).getByText(/Setup: Waiting for its first connection/)).toBeVisible();
  expect(within(fresh).getByText("How to start it")).toBeVisible();
  const idle = screen.getByRole("article", { name: "Idle" });
  expect(within(idle).getByText(/Setup: Connected once/)).toBeVisible();
  const ready = screen.getByRole("article", { name: "Ready" });
  expect(within(ready).getByText("Setup: Ready: on, and in a running batch.")).toBeVisible();
});

test("an agent that never connected can't be run yet", async () => {
  mockApi({
    "GET /auth/me": as("owner"),
    "GET /agents": [200, [agent({ manifest: null, connected: false, last_seen_at: null })]],
  });
  render(<App />);

  const card = await screen.findByRole("article", { name: "GBP audit" });
  expect(within(card).getByText(/Never connected/)).toBeVisible();
  expect(within(card).getByRole("button", { name: "Run now" })).toBeDisabled();
});

test("Stop appears while a run is going and asks the server to stop it", async () => {
  const running = {
    id: "r2",
    trigger: "manual" as const,
    status: "running" as const,
    queued_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    done: 3,
    failed: 0,
    skipped: 0,
    cost_usd: "0.0300",
    stop_reason: null,
    requested_by: "Sara",
    stop_requested: false,
    agent_key: "gbp-audit",
    agent_name: "GBP audit",
  };
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /agents": [200, [agent({ last_run: running })]],
    "POST /agents/gbp-audit/stop": [200, { ...running, stop_requested: true }],
  });
  render(<App />);

  const card = await screen.findByRole("article", { name: "GBP audit" });
  expect(within(card).getByRole("button", { name: "Run now" })).toBeDisabled();
  await userEvent.click(within(card).getByRole("button", { name: "Stop" }));

  expect(await within(card).findByText(/Stop requested\. A running agent stops/)).toBeVisible();
  expect(calls.some((c) => c.method === "POST" && c.path === "/agents/gbp-audit/stop")).toBe(true);
});
