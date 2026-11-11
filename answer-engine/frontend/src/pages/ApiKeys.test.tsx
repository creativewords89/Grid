import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { ApiKeys } from "./ApiKeys";
import { mockApi } from "../test/mockApi";

const scopes = {
  question_bank:
    "Question Bank: manage sets, upload questions, read and save threads, Polish and Fit",
  verified_import: "Import verified answers from a file",
};
const key = {
  id: "k1",
  name: "Claude data sync",
  prefix: "ae_AbCdE",
  scopes: ["question_bank"],
  made_by: { id: "u1", name: "Olivia" },
  created_at: "2026-11-11T10:00:00Z",
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
};

afterEach(() => vi.unstubAllGlobals());

test("creating a key shows it once, with the chosen scopes and expiry", async () => {
  const calls = mockApi({
    "GET /api-keys": [200, { items: [], scopes }],
    "POST /api-keys": [201, { key, token: "ae_AbCdEfGh-the-whole-secret" }],
  });
  render(<ApiKeys />);

  await userEvent.type(await screen.findByLabelText("Name"), "Claude data sync");
  await userEvent.click(screen.getByLabelText(/Import verified answers/));
  await userEvent.selectOptions(screen.getByLabelText("Expires after"), "never");
  await userEvent.click(screen.getByRole("button", { name: "Create a key" }));

  expect(await screen.findByText("ae_AbCdEfGh-the-whole-secret")).toBeVisible();
  expect(screen.getByText(/You won't see it again/)).toBeVisible();
  expect(calls.find((c) => c.method === "POST")?.body).toEqual({
    name: "Claude data sync",
    scopes: ["question_bank", "verified_import"],
    expires_days: null,
  });
  await userEvent.click(screen.getByRole("button", { name: "I've saved it" }));
  expect(screen.queryByText("ae_AbCdEfGh-the-whole-secret")).toBeNull();
});

test("revoking asks first", async () => {
  const calls = mockApi({
    "GET /api-keys": [200, { items: [key], scopes }],
    "DELETE /api-keys/k1": [204],
  });
  render(<ApiKeys />);

  expect(await screen.findByText("ae_AbCdE…")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await userEvent.click(revokeInDialog());

  expect(await screen.findByText(/is revoked/)).toBeVisible();
  expect(calls.some((c) => c.method === "DELETE" && c.path === "/api-keys/k1")).toBe(true);
});

function revokeInDialog() {
  const buttons = screen.getAllByRole("button", { name: "Revoke" });
  return buttons[buttons.length - 1]!;
}
