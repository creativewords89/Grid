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
