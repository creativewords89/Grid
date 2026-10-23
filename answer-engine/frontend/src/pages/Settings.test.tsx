import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { KbStatus } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const owner = [200, { user: makeUser({ role: "owner" }), csrf_token: "t" }] as [number, unknown];

function kb(overrides: Partial<KbStatus> = {}): KbStatus {
  return {
    configured: true,
    index: "answer-engine",
    files_ready: 12,
    chunks: 340,
    pending_ops: 0,
    pending_records: 0,
    oldest_pending_at: null,
    retrying: false,
    last_error: null,
    last_check: null,
    ...overrides,
  };
}

beforeEach(() => window.history.pushState(null, "", "/settings"));
afterEach(() => vi.unstubAllGlobals());

test("shows the knowledge base status", async () => {
  mockApi({ "GET /auth/me": owner, "GET /kb/status": [200, kb()] });

  render(<App />);

  expect(await screen.findByText("12 files · 340 chunks")).toBeVisible();
  expect(screen.getByText("Nothing — Pinecone is up to date")).toBeVisible();
  expect(screen.getByText(/Not run yet/)).toBeVisible();
});

test("explains how to set Pinecone up when it isn't", async () => {
  mockApi({
    "GET /auth/me": owner,
    "GET /kb/status": [200, kb({ configured: false, pending_ops: 2, pending_records: 9 })],
  });

  render(<App />);

  expect(await screen.findByText(/Pinecone isn't set up yet/)).toBeVisible();
  expect(screen.getByText(/9 records in 2 changes/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Rebuild index" })).toBeDisabled();
});

test("counts of one read naturally", async () => {
  mockApi({
    "GET /auth/me": owner,
    "GET /kb/status": [200, kb({ files_ready: 1, chunks: 1, pending_ops: 1, pending_records: 1 })],
  });

  render(<App />);

  expect(await screen.findByText("1 file · 1 chunk")).toBeVisible();
  expect(screen.getByText(/1 record in 1 change/)).toBeVisible();
});

test("shows that sync is retrying and why", async () => {
  mockApi({
    "GET /auth/me": owner,
    "GET /kb/status": [
      200,
      kb({
        pending_ops: 1,
        pending_records: 3,
        retrying: true,
        last_error: "ConnectionError: timed out",
      }),
    ],
  });

  render(<App />);

  expect(await screen.findByText(/retried automatically/)).toHaveTextContent(
    "ConnectionError: timed out",
  );
});

test("rebuild asks first", async () => {
  const calls = mockApi({
    "GET /auth/me": owner,
    "GET /kb/status": [200, kb()],
    "POST /kb/rebuild": [202, { message: "Rebuild started. Answers keep working while it runs." }],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Rebuild index" }));
  await userEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Rebuild" }),
  );

  expect(
    await screen.findByText("Rebuild started. Answers keep working while it runs."),
  ).toBeVisible();
  expect(calls.find((c) => c.path === "/kb/rebuild")?.csrf).toBe("t");
});

test("non-owners get no settings screen", async () => {
  const calls = mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "reviewer" }), csrf_token: "t" }],
  });

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Ask" })).toBeVisible();
  expect(calls.some((c) => c.path === "/kb/status")).toBe(false);
});

const reviewSettings = {
  values: {
    confidence_threshold: 75,
    min_relevance: 0.2,
    review_reminder_hours: 4,
    review_escalation_hours: 24,
    telegram_group_chat_id: null,
    verified_match: 0.9,
    answer_model: null,
    rewrite_model: null,
    check_model: null,
    answer_effort: "medium",
    max_upload_mb: 50,
    questions_per_user_per_day: 200,
    monthly_cost_alert_usd: 100,
    thread_auto_close_days: 14,
  },
  telegram: {
    configured: true,
    bot_username: "gr_answers_bot",
    seen_chats: [{ id: -100123, title: "GR reviewers" }],
  },
  models: {
    choices: [
      { id: "claude-opus-5-5", input_usd: 4, output_usd: 20 },
      { id: "claude-sonnet-5-5", input_usd: 2, output_usd: 10 },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    server: {
      answer_model: "claude-opus-5-5",
      rewrite_model: "claude-opus-5-5",
      check_model: "claude-opus-5-5",
    },
  },
};

function card(heading: string): HTMLElement {
  return screen.getByRole("heading", { name: heading }).closest(".card") as HTMLElement;
}

test("review settings: choose the group the bot has seen and save", async () => {
  const calls = mockApi({
    "GET /auth/me": owner,
    "GET /kb/status": [200, kb()],
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /settings": [200, reviewSettings],
    "PATCH /settings": (body) => [
      200,
      {
        ...reviewSettings,
        values: { ...reviewSettings.values, ...(body as { values: object }).values },
      },
    ],
  });
  render(<App />);

  await userEvent.selectOptions(await screen.findByLabelText("Telegram review group"), "-100123");
  const threshold = screen.getByLabelText("Confidence threshold");
  await userEvent.clear(threshold);
  await userEvent.type(threshold, "80");
  await userEvent.click(within(card("Reviews")).getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Saved.")).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    values: {
      confidence_threshold: 80,
      verified_match: 0.9,
      review_reminder_hours: 4,
      review_escalation_hours: 24,
      telegram_group_chat_id: "-100123",
    },
  });
});

test("review settings explain how to set up Telegram", async () => {
  mockApi({
    "GET /auth/me": owner,
    "GET /kb/status": [200, kb()],
    "GET /settings": [
      200,
      { ...reviewSettings, telegram: { configured: false, bot_username: "", seen_chats: [] } },
    ],
  });
  render(<App />);

  expect(await screen.findByText(/Telegram isn't set up/)).toBeVisible();
  expect(screen.queryByLabelText("Telegram review group")).toBeNull();
});

test("answering: choose a cheaper model and a higher effort", async () => {
  const calls = mockApi({
    "GET /auth/me": owner,
    "GET /kb/status": [200, kb()],
    "GET /settings": [200, reviewSettings],
    "PATCH /settings": (body) => [
      200,
      {
        ...reviewSettings,
        values: { ...reviewSettings.values, ...(body as { values: object }).values },
      },
    ],
  });
  render(<App />);

  const model = await screen.findByLabelText("Model for answers and marketing drafts");
  expect(
    within(model).getByRole("option", { name: /Server default \(claude-opus-5-5\)/ }),
  ).toBeTruthy();
  await userEvent.selectOptions(model, "claude-sonnet-5-5");
  await userEvent.selectOptions(screen.getByLabelText("Effort for answers"), "high");
  await userEvent.click(within(card("Answering")).getByRole("button", { name: "Save" }));

  expect(await within(card("Answering")).findByText("Saved.")).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    values: {
      answer_model: "claude-sonnet-5-5",
      rewrite_model: null,
      check_model: null,
      answer_effort: "high",
      min_relevance: 0.2,
    },
  });
});

test("limits: a refused value shows next to its field", async () => {
  mockApi({
    "GET /auth/me": owner,
    "GET /kb/status": [200, kb()],
    "GET /settings": [200, reviewSettings],
    "PATCH /settings": [
      422,
      {
        error: {
          code: "invalid",
          message: "Enter a number from 1 to 10000.",
          fields: { questions_per_user_per_day: "Enter a number from 1 to 10000." },
        },
      },
    ],
  });
  render(<App />);

  const daily = await screen.findByLabelText("Questions per person per day");
  expect(daily).toHaveValue(200);
  await userEvent.clear(daily);
  await userEvent.type(daily, "10001");
  await userEvent.click(within(card("Limits")).getByRole("button", { name: "Save" }));

  expect(
    await within(card("Limits")).findAllByText("Enter a number from 1 to 10000."),
  ).toHaveLength(2);
  expect(daily).toHaveAttribute("aria-invalid", "true");
});

const usage = {
  month: "2026-10",
  total: { requests: 40, tokens_in: 90000, tokens_out: 9000, cost_usd: 120.5 },
  alert_usd: 100,
  by_kind: [{ kind: "answer", requests: 30, tokens_in: 80000, tokens_out: 8000, cost_usd: 110 }],
  by_day: [
    { date: "2026-10-02", requests: 40, tokens_in: 90000, tokens_out: 9000, cost_usd: 120.5 },
  ],
  by_person: [
    {
      user_id: "u1",
      name: "Sara",
      requests: 40,
      tokens_in: 90000,
      tokens_out: 9000,
      cost_usd: 120.5,
    },
  ],
};

test("usage: the month's total against the alert, by kind and person", async () => {
  mockApi({
    "GET /auth/me": owner,
    "GET /kb/status": [200, kb()],
    "GET /settings": [200, reviewSettings],
    [`GET /usage?month=${usage.month}`]: [200, usage],
    "GET /usage?month=2026-09": [
      200,
      { ...usage, month: "2026-09", by_day: [], by_kind: [], by_person: [] },
    ],
  });
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  render(<App />);

  const box = await screen.findByRole("heading", { name: "Usage" });
  const usageCard = box.closest(".card") as HTMLElement;
  expect(
    await within(usageCard).findByText("$120.50", { selector: ".usage-total-value" }),
  ).toBeVisible();
  expect(within(usageCard).getByText(/alert at \$100\.00/)).toBeVisible();
  expect(within(usageCard).getByRole("img", { name: "Cost per day in 2026-10" })).toBeTruthy();
  expect(within(usageCard).getByRole("cell", { name: "Answers" })).toBeVisible();
  expect(within(usageCard).getByRole("cell", { name: "Sara" })).toBeVisible();

  const month = within(usageCard).getByLabelText("Month");
  fireEvent.change(month, { target: { value: "2026-09" } });
  expect(await within(usageCard).findByText("Nothing used this month.")).toBeVisible();
  vi.useRealTimers();
});

test("system: a failed backup and failed jobs are shown", async () => {
  mockApi({
    "GET /auth/me": owner,
    "GET /kb/status": [200, kb()],
    "GET /settings": [200, reviewSettings],
    "GET /system": [
      200,
      {
        version: "0.1.0",
        environment: "production",
        queued_jobs: 0,
        oldest_queued_at: null,
        failed_jobs_7d: 1,
        failed_jobs: [
          {
            id: "j1",
            kind: "ingest_file",
            attempts: 3,
            error: "ValueError: bad PDF",
            at: "2026-10-22T10:00:00Z",
          },
        ],
        backup: {
          found: true,
          ok: false,
          at: "2026-10-22T02:30:00Z",
          size_bytes: null,
          off_server: false,
          message: "pg_dump failed",
          late: false,
        },
      },
    ],
  });
  render(<App />);

  expect(await screen.findByText("The last backup failed: pg_dump failed")).toBeVisible();
  expect(screen.getByText("0.1.0 (production)")).toBeVisible();
  expect(screen.getByText("ValueError: bad PDF")).toBeVisible();
  expect(screen.getByText("(3 tries)")).toBeVisible();
});

test("history: changes with old and new values, and older pages", async () => {
  const entry = (n: number) => ({
    id: `e${n}`,
    actor: "Olivia",
    action: "update",
    entity: "settings",
    entity_id: null,
    title: "Settings",
    changes: [{ field: "confidence_threshold", from: 75, to: 80 }],
    at: `2026-10-${String(1 + (n % 20)).padStart(2, "0")}T10:00:00Z`,
  });
  const page = Array.from({ length: 30 }, (_, n) => entry(n));
  const calls = mockApi({
    "GET /auth/me": owner,
    "GET /kb/status": [200, kb()],
    "GET /settings": [200, reviewSettings],
    "GET /audit?limit=30": [200, page],
    [`GET /audit?limit=30&before=${encodeURIComponent(page[29]!.at)}`]: [
      200,
      [
        {
          ...entry(99),
          id: "old",
          actor: null,
          action: "purge",
          entity: "file",
          title: "Old.pdf",
          changes: [],
        },
      ],
    ],
  });
  render(<App />);

  const history = (await screen.findByRole("heading", { name: "History" })).closest(
    ".card",
  ) as HTMLElement;
  expect((await within(history).findAllByText("confidence_threshold: 75 → 80")).length).toBe(30);
  await userEvent.click(within(history).getByRole("button", { name: "Show older" }));
  expect(await within(history).findByText(/Old\.pdf/)).toBeVisible();
  expect(within(history).queryByRole("button", { name: "Show older" })).toBeNull();
  expect(calls.some((c) => c.path.startsWith("/audit?limit=30&before="))).toBe(true);
});
