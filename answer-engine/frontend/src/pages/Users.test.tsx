import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const owner = makeUser({ id: "o1", name: "Olivia", role: "owner" });
const people = [
  makeUser({ id: "a1", name: "Ann", email: "ann@example.com", invited: true }),
  makeUser({ id: "b1", name: "Bob", email: "bob@example.com", role: "reviewer", active: false }),
  owner,
];
const signedIn = [200, { user: owner, csrf_token: "t" }] as [number, unknown];

beforeEach(() => window.history.pushState(null, "", "/users"));
afterEach(() => vi.unstubAllGlobals());

test("lists people with their role and status", async () => {
  mockApi({ "GET /auth/me": signedIn, "GET /users": [200, people] });

  render(<App />);

  const rows = await screen.findAllByRole("row");
  expect(rows.slice(1).map((row) => within(row).getAllByRole("cell")[2]?.textContent)).toEqual([
    "Invited",
    "Deactivated",
    "Active",
  ]);
  expect(within(rows[1]!).getByRole("button", { name: "Resend invite" })).toBeVisible();
  expect(within(rows[3]!).getByText("You")).toBeVisible();
});

test("inviting while email isn't set up shows a link to copy", async () => {
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /users": [200, people],
    "POST /users/invite": [
      201,
      {
        user: makeUser({ id: "n1", name: "Nadia", email: "nadia@example.com", invited: true }),
        email_sent: false,
        link: "https://answers.example.com/invite#abc",
      },
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "+ Invite" }));
  const dialog = screen.getByRole("dialog", { name: "Invite someone" });
  await userEvent.type(within(dialog).getByLabelText("Name"), "Nadia");
  await userEvent.type(within(dialog).getByLabelText("Email"), "nadia@example.com");
  await userEvent.selectOptions(within(dialog).getByLabelText("Role"), "reviewer");
  await userEvent.click(within(dialog).getByRole("button", { name: "Send invite" }));

  expect(await screen.findByText(/copy this link and send it to Nadia/)).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Link" })).toHaveValue(
    "https://answers.example.com/invite#abc",
  );
  expect(calls.find((c) => c.path === "/users/invite")?.body).toEqual({
    name: "Nadia",
    email: "nadia@example.com",
    role: "reviewer",
  });
});

test("field errors from the server appear in the invite form", async () => {
  mockApi({
    "GET /auth/me": signedIn,
    "GET /users": [200, people],
    "POST /users/invite": [
      409,
      {
        error: {
          code: "email_taken",
          message: "Someone with that email already has an account.",
          fields: { email: "Already used." },
        },
      },
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "+ Invite" }));
  await userEvent.type(screen.getByLabelText("Name"), "Ann");
  await userEvent.type(screen.getByLabelText("Email"), "ann@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Send invite" }));

  expect(await screen.findByText("Already used.")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("already has an account");
});

test("the last-Owner rule is explained when demoting yourself", async () => {
  mockApi({
    "GET /auth/me": signedIn,
    "GET /users": [200, people],
    "PATCH /users/o1": [
      409,
      { error: { code: "last_owner", message: "There must always be at least one active Owner." } },
    ],
  });
  render(<App />);

  const rows = await screen.findAllByRole("row");
  await userEvent.click(within(rows[3]!).getByRole("button", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit Olivia" });
  expect(within(dialog).queryByLabelText(/Active/)).not.toBeInTheDocument();
  await userEvent.selectOptions(within(dialog).getByLabelText("Role"), "user");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

  expect(await within(dialog).findByRole("alert")).toHaveTextContent("at least one active Owner");
});

test("non-owners never see the Users screen", async () => {
  const calls = mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "reviewer" }), csrf_token: "t" }],
  });

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Ask" })).toBeVisible();
  expect(calls.some((c) => c.path === "/users")).toBe(false);
});
