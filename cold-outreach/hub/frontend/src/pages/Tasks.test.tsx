import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { Task } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    key: "gbp-audit",
    name: "GBP Audit",
    about: "Checks the Google Business Profile",
    needs: [],
    bots: [{ key: "gbp-full", name: "GBP audit (DataForSEO)", enabled: true }],
    batches: ["Texas November"],
    can_edit: true,
    can_delete: false,
    ...overrides,
  };
}

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];

beforeEach(() => window.history.pushState(null, "", "/tasks"));
afterEach(() => vi.unstubAllGlobals());

test("an Admin makes a task that needs another first", async () => {
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /tasks": [200, [task()]],
    "POST /tasks": [201, task({ id: "t2", key: "review-check", name: "Review Check" })],
  });
  render(<App />);

  expect(await screen.findByRole("cell", { name: /GBP Audit/ })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "+ New task" }));
  const form = screen.getByRole("form", { name: "New task" });
  await userEvent.type(within(form).getByLabelText("Name"), "Review Check");
  await userEvent.type(within(form).getByLabelText("Key"), "review-check");
  await userEvent.click(within(form).getByLabelText("GBP Audit"));
  await userEvent.click(within(form).getByRole("button", { name: "Save task" }));

  expect(calls.find((c) => c.method === "POST")?.body).toEqual({
    key: "review-check",
    name: "Review Check",
    about: "",
    needs: ["gbp-audit"],
  });
});

test("a circle is refused with the reason", async () => {
  mockApi({
    "GET /auth/me": as("owner"),
    "GET /tasks": [
      200,
      [task(), task({ id: "t2", key: "opportunity", name: "Opportunity Finder" })],
    ],
    "PATCH /tasks/t1": [
      422,
      {
        error: {
          code: "circle",
          message: "A task can't wait for itself, also not through other tasks.",
          fields: { needs: "Makes a circle." },
        },
      },
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Edit GBP Audit" }));
  const form = screen.getByRole("form", { name: "Edit GBP Audit" });
  await userEvent.click(within(form).getByLabelText("Opportunity Finder"));
  await userEvent.click(within(form).getByRole("button", { name: "Save task" }));

  expect(await within(form).findByText("Makes a circle.")).toBeVisible();
});

test("a viewer sees the tasks but can't change them", async () => {
  mockApi({ "GET /auth/me": as("viewer"), "GET /tasks": [200, [task({ can_edit: false })]] });
  render(<App />);

  expect(await screen.findByText("GBP audit (DataForSEO)")).toBeVisible();
  expect(screen.queryByRole("button", { name: "+ New task" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit GBP Audit" })).not.toBeInTheDocument();
});
