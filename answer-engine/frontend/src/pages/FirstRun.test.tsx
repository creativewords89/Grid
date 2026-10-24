import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

beforeEach(() => window.history.pushState(null, "", "/"));
afterEach(() => vi.unstubAllGlobals());

const signedOut = [401, { error: { code: "unauthenticated", message: "Sign in." } }] as [
  number,
  unknown,
];

test("a new install offers to create the Owner, then opens Settings", async () => {
  const calls = mockApi({
    "GET /auth/me": signedOut,
    "GET /setup": [200, { needed: true }],
    "POST /setup": [201, { user: makeUser({ role: "owner", name: "Olivia" }), csrf_token: "t" }],
    "GET /connections": [200, { groups: [] }],
  });
  render(<App />);

  expect(await screen.findByRole("heading", { name: "Create the Owner account" })).toBeVisible();
  expect(screen.getByText(/python -m app.cli setup-code/)).toBeVisible();
  await userEvent.type(screen.getByLabelText("Setup code"), "ABCD-EFGH-JKLM");
  await userEvent.type(screen.getByLabelText("Your name"), "Olivia");
  await userEvent.type(screen.getByLabelText("Email"), "olivia@example.com");
  await userEvent.type(screen.getByLabelText("Password"), "a long passphrase");
  await userEvent.click(screen.getByRole("button", { name: "Create the Owner account" }));

  expect(await screen.findByRole("heading", { name: "Settings" })).toBeVisible();
  expect(window.location.pathname).toBe("/settings");
  expect(calls.find((c) => c.method === "POST" && c.path === "/setup")?.body).toEqual({
    code: "ABCD-EFGH-JKLM",
    name: "Olivia",
    email: "olivia@example.com",
    password: "a long passphrase",
  });
});

test("a wrong setup code shows next to the field", async () => {
  mockApi({
    "GET /auth/me": signedOut,
    "GET /setup": [200, { needed: true }],
    "POST /setup": [
      403,
      {
        error: {
          code: "bad_code",
          message: "That setup code isn't right.",
          fields: { code: "Check the setup code." },
        },
      },
    ],
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Setup code"), "WRONG");
  await userEvent.click(screen.getByRole("button", { name: "Create the Owner account" }));
  expect(await screen.findByText("Check the setup code.")).toBeVisible();
});

test("once an account exists, it's the normal sign-in page", async () => {
  mockApi({ "GET /auth/me": signedOut, "GET /setup": [200, { needed: false }] });
  render(<App />);
  expect(
    await screen.findByRole("heading", { name: "Sign in to the Answer Engine" }),
  ).toBeVisible();
});
