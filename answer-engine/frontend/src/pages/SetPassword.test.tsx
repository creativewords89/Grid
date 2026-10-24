import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { App } from "../App";
import { makeUser, mockApi, unauthenticated } from "../test/mockApi";

afterEach(() => vi.unstubAllGlobals());

const person = { name: "Nadia", email: "nadia@example.com" };

async function fill(password: string, repeat = password) {
  await userEvent.type(await screen.findByLabelText("New password"), password);
  await userEvent.type(screen.getByLabelText("Repeat password"), repeat);
}

test("accepting an invite sets the password and signs in", async () => {
  window.history.pushState(null, "", "/invite#secret-token-123");
  const calls = mockApi({
    "GET /auth/me": unauthenticated,
    "POST /auth/check-token": [200, person],
    "POST /auth/accept-invite": [200, { user: makeUser({ name: "Nadia" }), csrf_token: "t" }],
  });
  render(<App />);

  expect(await screen.findByText("Nadia · nadia@example.com")).toBeVisible();
  await fill("blue kettle on mondays");
  await userEvent.click(screen.getByRole("button", { name: "Set password and sign in" }));

  expect(await screen.findByRole("heading", { name: "Ask" })).toBeVisible();
  expect(calls.find((c) => c.path === "/auth/check-token")?.body).toEqual({
    token: "secret-token-123",
    kind: "invite",
  });
  expect(window.location.pathname).toBe("/");
  expect(window.location.hash).toBe("");
});

test("passwords that don't match are caught before sending", async () => {
  window.history.pushState(null, "", "/invite#secret-token-123");
  const calls = mockApi({
    "GET /auth/me": unauthenticated,
    "POST /auth/check-token": [200, person],
  });
  render(<App />);

  await fill("blue kettle on mondays", "blue kettle on tuesdays");
  await userEvent.click(screen.getByRole("button", { name: "Set password and sign in" }));

  expect(await screen.findByText("The passwords don't match.")).toBeVisible();
  expect(calls.some((c) => c.path === "/auth/accept-invite")).toBe(false);
});

test("the server's password rule is shown under the field", async () => {
  window.history.pushState(null, "", "/reset#secret-token-123");
  mockApi({
    "GET /auth/me": unauthenticated,
    "POST /auth/check-token": [200, person],
    "POST /auth/reset": [
      422,
      {
        error: {
          code: "invalid",
          message: "That password is too common.",
          fields: { password: "That password is too common." },
        },
      },
    ],
  });
  render(<App />);

  await fill("qwertyuiop");
  await userEvent.click(screen.getByRole("button", { name: "Save new password" }));

  expect(await screen.findByText("That password is too common.")).toBeVisible();
});

test("a finished reset returns to sign-in with a message", async () => {
  window.history.pushState(null, "", "/reset#secret-token-123");
  mockApi({
    "GET /auth/me": unauthenticated,
    "POST /auth/check-token": [200, person],
    "POST /auth/reset": [200, { message: "Your password has been changed. Please sign in." }],
  });
  render(<App />);

  await fill("blue kettle on mondays");
  await userEvent.click(screen.getByRole("button", { name: "Save new password" }));

  expect(await screen.findByText("Your password has been changed. Please sign in.")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Sign in to the Answer Engine" })).toBeVisible();
});

test("an expired link explains what to do", async () => {
  window.history.pushState(null, "", "/invite#old-token-1234");
  mockApi({
    "GET /auth/me": unauthenticated,
    "POST /auth/check-token": [
      400,
      { error: { code: "invalid_token", message: "This link has expired or was already used." } },
    ],
  });
  render(<App />);

  expect(await screen.findByRole("alert")).toHaveTextContent("This link has expired");
  expect(screen.getByRole("link", { name: "Ask for a new link" })).toBeVisible();
});

test("a link without its secret is refused without calling the server", async () => {
  window.history.pushState(null, "", "/invite");
  const calls = mockApi({ "GET /auth/me": unauthenticated });
  render(<App />);

  expect(await screen.findByRole("alert")).toHaveTextContent("This link is incomplete.");
  expect(calls.some((c) => c.path === "/auth/check-token")).toBe(false);
});
