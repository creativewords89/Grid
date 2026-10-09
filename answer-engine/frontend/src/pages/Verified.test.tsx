import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { VerifiedDetail, VerifiedPage } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const reviewer = [200, { user: makeUser({ role: "reviewer", name: "Ali" }), csrf_token: "t" }] as [
  number,
  unknown,
];
const row = {
  id: "v1",
  question: "How long does GBP verification take?",
  answer: "Usually 1-2 weeks.\nSometimes longer.",
  status: "active" as const,
  expires_at: null,
  needs_check: true,
  needs_check_reason: "Source deleted: Onboarding.pdf",
  approved_by: { id: "u2", name: "Ali" },
  origin: "review" as const,
  version: 2,
  updated_at: "2026-10-08T10:00:00Z",
};
const page: VerifiedPage = {
  items: [row],
  can_manage: true,
  counts: { active: 1, disabled: 0, expired: 0, needs_check: 1, all: 1 },
};
const detail: VerifiedDetail = {
  ...row,
  sources: [{ file_id: "f1", name: "Onboarding.pdf", available: false }],
  origin_answer_id: "a1",
  created_at: "2026-10-01T10:00:00Z",
  can_manage: true,
};

beforeEach(() => window.history.pushState(null, "", "/verified"));
afterEach(() => vi.unstubAllGlobals());

test("the list shows counts, the first line and why to check", async () => {
  mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /verified?show=active": [200, page],
  });
  render(<App />);

  expect(await screen.findByText(row.question)).toBeVisible();
  expect(screen.getByText("Usually 1-2 weeks.")).toBeVisible();
  expect(screen.getByText("Source deleted: Onboarding.pdf")).toBeVisible();
  expect(screen.getByRole("tab", { name: "Needs check (1)" })).toBeVisible();
});

test("editing saves the new answer", async () => {
  window.history.pushState(null, "", "/verified?id=v1");
  const calls = mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /verified/v1": [200, detail],
    "GET /verified/v1/history": [
      200,
      [
        {
          version: 2,
          question: row.question,
          answer: row.answer,
          changed_by: null,
          at: row.updated_at,
        },
        {
          version: 1,
          question: row.question,
          answer: "Old.",
          changed_by: null,
          at: row.updated_at,
        },
      ],
    ],
    "PATCH /verified/v1": [200, detail],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const box = screen.getByLabelText("Answer");
  await userEvent.clear(box);
  await userEvent.type(box, "Two weeks.");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Saved. Search is updated.")).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    question: row.question,
    answer: "Two weeks.",
  });
  expect(screen.getByText("Onboarding.pdf (deleted)")).toBeVisible();
  expect(screen.getByRole("button", { name: "Restore this version" })).toBeVisible();
});

test("people who can't manage only read", async () => {
  window.history.pushState(null, "", "/verified?id=v1");
  mockApi({
    "GET /auth/me": [200, { user: makeUser(), csrf_token: "t" }],
    "GET /verified/v1": [200, { ...detail, can_manage: false }],
    "GET /verified/v1/history": [200, []],
  });
  render(<App />);

  expect(await screen.findByText("Usually 1-2 weeks.", { exact: false })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Mark as checked" })).toBeNull();
});
