import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

beforeEach(() => window.history.pushState(null, "", "/profile"));
afterEach(() => vi.unstubAllGlobals());

test("shows the role and saves a new name", async () => {
  const calls = mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "admin" }), csrf_token: "t" }],
    "PATCH /me": (body) => [200, makeUser({ role: "admin", ...(body as object) })],
  });
  render(<App />);

  expect(await screen.findByText("sara@example.com · Admin")).toBeVisible();
  const name = screen.getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "Sara K");
  await userEvent.click(screen.getByRole("button", { name: "Save name" }));

  expect(await screen.findByText("Saved.")).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Sara K" });
  expect(screen.getByRole("button", { name: "Sara K" })).toBeVisible();
});

test("a wrong current password is shown next to its field", async () => {
  mockApi({
    "GET /auth/me": [200, { user: makeUser(), csrf_token: "t" }],
    "POST /me/password": [
      422,
      {
        error: {
          code: "invalid",
          message: "Your current password is incorrect.",
          fields: { current_password: "Your current password is incorrect." },
        },
      },
    ],
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Current password"), "nope nope nope");
  await userEvent.type(screen.getByLabelText("New password"), "a brand new passphrase");
  await userEvent.click(screen.getByRole("button", { name: "Change password" }));

  expect(await screen.findByText("Your current password is incorrect.")).toBeVisible();
});

test("switch off alert emails", async () => {
  const calls = mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "admin" }), csrf_token: "t" }],
    "PATCH /me": (body) => [200, makeUser({ role: "admin", ...(body as object) })],
  });
  render(<App />);

  const box = await screen.findByLabelText("Email me alerts");
  expect(box).toBeChecked();
  await userEvent.click(box);

  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ alert_email: false });
  expect(await screen.findByLabelText("Email me alerts")).not.toBeChecked();
});
