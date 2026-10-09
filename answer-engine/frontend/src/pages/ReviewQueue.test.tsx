import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { ReviewDetail, ReviewRow } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const reviewer = [200, { user: makeUser({ role: "reviewer", name: "Ali" }), csrf_token: "t" }] as [
  number,
  unknown,
];
const row: ReviewRow = {
  id: "r1",
  number: 142,
  reason: "low_confidence",
  reason_label: "Low confidence (62)",
  state: "open",
  created_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  question: "How long does GBP verification take?",
  kind: "chat",
  asked_by: { id: "u1", name: "Sara" },
  claimed_by: null,
  answer_id: "a1",
};
const detail: ReviewDetail = {
  ...row,
  original_text: "It takes 3-5 days [1].",
  current_text: "It takes 3-5 days [1].",
  sources: [],
  confidence: 62,
  explanation: "Search match 70 · Support: partial",
  unsupported_claims: ["3-5 days"],
  no_answer: false,
  notes: [],
  decided_by: null,
  decided_at: null,
  final_text: null,
  note: null,
  mine: false,
};

beforeEach(() => window.history.pushState(null, "", "/reviews"));
afterEach(() => vi.unstubAllGlobals());

test("the queue lists waiting reviews and the sidebar shows how many", async () => {
  mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 3 }],
    "GET /reviews?show=waiting": [200, [row]],
  });
  render(<App />);

  expect(await screen.findByText(row.question)).toBeVisible();
  expect(screen.getByText(/Low confidence \(62\) · Sara · Chat · 3 h ago/)).toBeVisible();
  expect(await screen.findByLabelText("3 waiting")).toBeVisible();
});

test("correcting an answer sends the new text", async () => {
  const calls = mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 1 }],
    "GET /reviews?show=waiting": [200, [row]],
    "GET /reviews/r1": [200, detail],
    "POST /reviews/r1/decide": (body) => [
      200,
      {
        ...detail,
        state: "edited",
        current_text: (body as { text: string }).text,
        decided_by: { id: "u2", name: "Ali" },
        decided_at: "2026-10-09T10:00:00Z",
        mine: true,
      },
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: /How long does GBP/ }));
  expect(await screen.findByText("Search match 70 · Support: partial")).toBeVisible();
  expect(window.location.search).toBe("?id=r1");
  await userEvent.click(screen.getByRole("button", { name: "✏️ Edit" }));
  const box = screen.getByLabelText("Corrected answer");
  expect(box).toHaveValue("It takes 3-5 days [1].");
  await userEvent.clear(box);
  await userEvent.type(box, "Usually 1-2 weeks.");
  await userEvent.type(screen.getByLabelText("Note for the log (optional)"), "Google is slow");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText(/Corrected by Ali/)).toBeVisible();
  expect(calls.find((c) => c.path === "/reviews/r1/decide")?.body).toEqual({
    action: "edit",
    text: "Usually 1-2 weeks.",
    note: "Google is slow",
  });
});

test("someone else's review can't be acted on", async () => {
  window.history.pushState(null, "", "/reviews?id=r1");
  mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 1 }],
    "GET /reviews/r1": [
      200,
      { ...detail, state: "claimed", claimed_by: { id: "u3", name: "Bea" }, mine: false },
    ],
  });
  render(<App />);

  expect(await screen.findByText("Bea is handling this.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "✅ Approve" })).toBeNull();
});

test("a no-answer review offers Answer and No answer known", async () => {
  window.history.pushState(null, "", "/reviews?id=r1");
  const calls = mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 1 }],
    "GET /reviews/r1": [200, { ...detail, no_answer: true, reason: "no_answer" }],
    "POST /reviews/r1/decide": [200, { ...detail, state: "rejected" }],
  });
  render(<App />);

  await screen.findByRole("button", { name: "✏️ Answer" });
  expect(screen.queryByRole("button", { name: "✅ Approve" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "🚫 No answer known" }));

  expect(calls.find((c) => c.path === "/reviews/r1/decide")?.body).toEqual({ action: "no_answer" });
});

test("users don't get the Review Queue", async () => {
  mockApi({
    "GET /auth/me": [200, { user: makeUser(), csrf_token: "t" }],
    "GET /conversations": [200, []],
  });
  render(<App />);
  const nav = await screen.findByRole("navigation", { name: "Main" });
  expect(within(nav).queryByText("Review Queue")).toBeNull();
});

test("a duplicate verified answer asks whether to update it", async () => {
  window.history.pushState(null, "", "/reviews?id=r1");
  let first = true;
  const calls = mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 1 }],
    "GET /reviews/r1": [200, detail],
    "POST /reviews/r1/decide": () => {
      if (first) {
        first = false;
        return [
          409,
          {
            error: {
              code: "duplicate",
              message: "A verified answer to this question exists. Update it instead?",
              details: { id: "v9", question: "GBP verification time?", answer: "1-2 weeks." },
            },
          },
        ];
      }
      return [200, { ...detail, state: "approved", decided_by: { id: "u2", name: "Ali" } }];
    },
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "✅ Approve" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("GBP verification time?")).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "Update the existing one" }));

  expect(await screen.findByText(/Approved by Ali/)).toBeVisible();
  const sent = calls.filter((c) => c.path === "/reviews/r1/decide").map((c) => c.body);
  expect(sent).toEqual([
    { action: "approve" },
    { action: "approve", verified_choice: "update:v9" },
  ]);
});
