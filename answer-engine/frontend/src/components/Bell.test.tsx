import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { NotificationItem, Updates } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const me = [200, { user: makeUser(), csrf_token: "t" }] as [number, unknown];
const note: NotificationItem = {
  id: "n1",
  kind: "answer_reviewed",
  title: "Our team corrected an answer you got",
  body: "What does Pro cost?",
  link: "/?c=c1",
  created_at: new Date().toISOString(),
  read_at: null,
};
const updates = (over: Partial<Updates> = {}): Updates => ({
  cursor: "2026-10-22T10:00:00Z",
  answers: [],
  notifications: [],
  unread: 1,
  files_changed: false,
  reviews_waiting: null,
  ...over,
});

beforeEach(() => window.history.pushState(null, "", "/documents"));
afterEach(() => vi.unstubAllGlobals());

test("the bell shows unread notifications and opens them", async () => {
  const calls = mockApi({
    "GET /auth/me": me,
    "GET /updates": [200, updates()],
    "GET /files": [200, { files: [], totals: { files: 0, pages: 0, ocr_pages_this_month: 0 } }],
    "GET /notifications": [200, { unread: 1, items: [note] }],
    "POST /notifications/read": [200, { unread: 0, items: [{ ...note, read_at: "now" }] }],
    "GET /conversations": [200, []],
    "GET /conversations/c1": [200, { id: "c1", title: "Pro", last_message_at: "", messages: [] }],
  });
  render(<App />);

  const bell = await screen.findByRole("button", { name: "Notifications, 1 unread" });
  await userEvent.click(bell);
  const menu = await screen.findByRole("menu");
  await userEvent.click(within(menu).getByRole("menuitem", { name: /Our team corrected/ }));

  expect(window.location.pathname + window.location.search).toBe("/?c=c1");
  expect(calls.find((c) => c.path === "/notifications/read")?.body).toEqual({ ids: ["n1"] });
  expect(await screen.findByRole("button", { name: "Notifications" })).toBeVisible();
});

test("mark all read", async () => {
  const calls = mockApi({
    "GET /auth/me": me,
    "GET /updates": [200, updates({ unread: 3 })],
    "GET /files": [200, { files: [], totals: { files: 0, pages: 0, ocr_pages_this_month: 0 } }],
    "GET /notifications": [200, { unread: 3, items: [note] }],
    "POST /notifications/read": [200, { unread: 0, items: [{ ...note, read_at: "now" }] }],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Notifications, 3 unread" }));
  await userEvent.click(await screen.findByRole("button", { name: "Mark all read" }));

  expect(calls.find((c) => c.path === "/notifications/read")?.body).toEqual({});
  expect(await screen.findByRole("button", { name: "Notifications" })).toBeVisible();
});

test("live updates refresh the review badge", async () => {
  mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "reviewer" }), csrf_token: "t" }],
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /updates": [200, updates({ unread: 0, reviews_waiting: 4 })],
    "GET /files": [200, { files: [], totals: { files: 0, pages: 0, ocr_pages_this_month: 0 } }],
  });
  render(<App />);

  expect(await screen.findByLabelText("4 waiting")).toBeVisible();
});
