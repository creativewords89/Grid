import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { LogDetail, LogPage, LogRow } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const owner = [200, { user: makeUser({ role: "owner", name: "Olivia" }), csrf_token: "t" }] as [
  number,
  unknown,
];
const row: LogRow = {
  id: "a1",
  created_at: "2026-10-08T10:00:00Z",
  asked_by: { id: "u1", name: "Sara" },
  kind: "chat",
  question: "How long does GBP verification take?",
  confidence: 62,
  outcome: "low",
  status: "in_review",
  flagged: true,
  feedback: "down",
  source_count: 1,
};
const page: LogPage = {
  items: [
    row,
    {
      ...row,
      id: "a2",
      question: "Office dog?",
      outcome: "no_answer",
      confidence: null,
      status: "auto",
      flagged: false,
      feedback: null,
    },
  ],
  total: 2,
  page: 1,
  page_size: 50,
  stats: { answers_this_month: 12, high_pct: 75, corrected_pct: 8, avg_review_minutes: null },
  people: [{ id: "u1", name: "Sara" }],
  can_review: true,
};
const detail: LogDetail = {
  ...row,
  retrieval_query: row.question,
  original_text: "It takes 3-5 days [1].",
  current_text: "It takes 3-5 days [1].",
  sources: [],
  confidence_parts: {
    retrieval: 81,
    support: "partial",
    unsupported_claims: ["3-5 days"],
    reason: null,
  },
  explanation: "Search match 81 · Support: partial",
  flag_note: "It took two weeks",
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  cost_usd: 0.061,
  conversation_id: "c1",
  can_review: true,
};

beforeEach(() => window.history.pushState(null, "", "/answer-log"));
afterEach(() => vi.unstubAllGlobals());

test("the Answer Log lists answers with stats, and filters ask the server", async () => {
  const calls = mockApi({
    "GET /auth/me": owner,
    "GET /answer-log?page=1": [200, page],
    "GET /answer-log?page=1&outcome=low": [200, { ...page, items: [row], total: 1 }],
  });
  render(<App />);

  const table = await screen.findByRole("table");
  expect(within(table).getByText("🟠 62")).toBeVisible();
  expect(within(table).getByText("🔴 No answer")).toBeVisible();
  expect(within(table).getByText("Flagged")).toBeVisible();
  expect(screen.getByText("12")).toBeVisible();
  expect(screen.getByText("75%")).toBeVisible();

  await userEvent.selectOptions(screen.getByLabelText("Confidence"), "low");

  await waitFor(() => expect(screen.queryByText("Office dog?")).toBeNull());
  expect(calls.map((c) => c.path)).toContain("/answer-log?page=1&outcome=low");
});

test("opening an answer explains its score", async () => {
  mockApi({
    "GET /auth/me": owner,
    "GET /answer-log?page=1": [200, page],
    "GET /answer-log/a1": [200, detail],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: row.question }));

  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("Search match 81 · Support: partial")).toBeVisible();
  expect(within(dialog).getByText("3-5 days")).toBeVisible();
  expect(within(dialog).getByText(/It took two weeks/)).toBeVisible();
});

test("knowledge gaps show grouped questions with counts", async () => {
  mockApi({
    "GET /auth/me": owner,
    "GET /answer-log?page=1": [200, page],
    "GET /answer-log/gaps": [
      200,
      [
        {
          question: "What is the office wifi password?",
          count: 3,
          last_asked_at: "2026-10-08T10:00:00Z",
          answer_ids: ["x1", "x2", "x3"],
          examples: ["What is the office wifi password?", "office wifi password?"],
        },
      ],
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("tab", { name: "Knowledge gaps" }));

  expect(await screen.findByText("What is the office wifi password?")).toBeVisible();
  expect(screen.getByText("3 times")).toBeVisible();
  expect(screen.getByText("office wifi password?")).toBeVisible();
});

test("users don't get the Answer Log", async () => {
  mockApi({
    "GET /auth/me": [200, { user: makeUser(), csrf_token: "t" }],
    "GET /conversations": [200, []],
  });
  render(<App />);

  expect(await screen.findByText("Ask anything about GridRankers' documents.")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Answer Log" })).toBeNull();
});
