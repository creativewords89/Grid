import { render, screen, within } from "@testing-library/react";
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
  },
  telegram: {
    configured: true,
    bot_username: "gr_answers_bot",
    seen_chats: [{ id: -100123, title: "GR reviewers" }],
  },
};

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
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Saved.")).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    values: {
      confidence_threshold: 80,
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
