import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "./App";
import { healthy, makeUser, mockApi, unauthenticated } from "./test/mockApi";

beforeEach(() => window.history.pushState(null, "", "/"));
afterEach(() => vi.unstubAllGlobals());

test("signed out people see only the sign-in screen", async () => {
  mockApi({ "GET /auth/me": unauthenticated, "GET /setup": [200, { needed: false }] });

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Sign in to the Agent Hub" })).toBeVisible();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
});

test("a wrong password shows the server's message", async () => {
  mockApi({
    "GET /auth/me": unauthenticated,
    "GET /setup": [200, { needed: false }],
    "POST /auth/login": [
      401,
      { error: { code: "bad_credentials", message: "Email or password is incorrect." } },
    ],
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Email"), "sara@example.com");
  await userEvent.type(screen.getByLabelText("Password"), "wrong");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect.");
});

test("signing in opens the Hub and later writes send the CSRF token", async () => {
  const calls = mockApi({
    "GET /auth/me": unauthenticated,
    "GET /setup": [200, { needed: false }],
    "GET /health": healthy,
    "POST /auth/login": [200, { user: makeUser(), csrf_token: "tok-123" }],
    "POST /auth/logout": [204],
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Email"), "sara@example.com");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(await screen.findByRole("heading", { name: "Overview" })).toBeVisible();
  expect(await screen.findByText(/Server is running/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Sara" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

  expect(await screen.findByRole("heading", { name: "Sign in to the Agent Hub" })).toBeVisible();
  expect(calls.find((c) => c.path === "/auth/login")?.body).toEqual({
    email: "sara@example.com",
    password: "correct horse",
  });
  expect(calls.find((c) => c.path === "/auth/logout")?.csrf).toBe("tok-123");
});

test.each([
  [
    "owner",
    [
      "Overview",
      "Benchmarks",
      "Batches",
      "Leads",
      "Agents",
      "Runs",
      "Connections",
      "Users",
      "History",
    ],
  ],
  ["admin", ["Overview", "Benchmarks", "Batches", "Leads", "Agents", "Runs"]],
  ["viewer", ["Overview", "Benchmarks", "Batches", "Leads", "Agents", "Runs"]],
] as const)("the %s sees their sidebar", async (role, items) => {
  mockApi({
    "GET /auth/me": [200, { user: makeUser({ role }), csrf_token: "t" }],
    "GET /health": healthy,
  });

  render(<App />);

  const nav = await screen.findByRole("navigation", { name: "Main" });
  expect(
    within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual(items);
});

test("forgot password sends the email and shows the neutral reply", async () => {
  const calls = mockApi({
    "GET /auth/me": unauthenticated,
    "GET /setup": [200, { needed: false }],
    "POST /auth/forgot": [200, { message: "If that email exists, we've sent a link." }],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("link", { name: "Forgot password?" }));
  await userEvent.type(screen.getByLabelText("Email"), "sara@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Send link" }));

  expect(await screen.findByText("If that email exists, we've sent a link.")).toBeVisible();
  expect(calls.at(-1)?.body).toEqual({ email: "sara@example.com" });
});
