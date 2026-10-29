import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "../App";
import type { HandedInFile, HandedInFileDetail } from "../api";
import { makeUser, mockApi } from "../test/mockApi";

const collector = makeUser({ id: "c1", name: "Cal", role: "collector" });
const owner = makeUser({ id: "o1", name: "Olivia", role: "owner" });
const me = (user: typeof owner) => [200, { user, csrf_token: "t" }] as [number, unknown];

function file(overrides: Partial<HandedInFile> = {}): HandedInFile {
  return {
    id: "f1",
    file_name: "tulsa.xlsx",
    niche: "Cleaning",
    version: 1,
    businesses: 120,
    errors: 2,
    warnings: 1,
    status: "errors",
    uploaded_by: "Cal",
    mine: true,
    created_at: "2026-10-29T10:00:00Z",
    updated_at: "2026-10-29T10:00:00Z",
    batch: null,
    same_as: null,
    ...overrides,
  };
}

const detail: HandedInFileDetail = {
  ...file(),
  tabs: { Tulsa: { errors: 2, warnings: 1, columns: [] } },
  problems: [
    {
      code: "PHONE_HAS_LETTERS",
      field: "phone",
      severity: "error",
      message: "Phone holds letters",
      tab: "Tulsa",
      line: 14,
      business: "Bad Co",
      value: "call us",
    },
  ],
};

const batch = {
  id: "b1",
  name: "Batch 01",
  niche: "Cleaning",
  benchmark: null,
  leads: 0,
  top: 0,
  files: 0,
  bots: [],
  status: "not_started",
  position: 0,
  progress_pct: null,
  created_at: "2026-10-01T10:00:00Z",
  can_edit: true,
  can_run: true,
  can_rename: true,
  can_delete: true,
};

beforeEach(() => window.history.pushState(null, "", "/files"));
afterEach(() => vi.unstubAllGlobals());

test("a collector lands on Files whatever the address, and hands in a file", async () => {
  window.history.pushState(null, "", "/batches");
  const calls = mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": [200, []],
    "GET /submissions/niches": [200, ["Cleaning", "Roofing"]],
    "POST /submissions": [201, detail],
    "GET /submissions/f1": [200, detail],
  });
  render(<App />);

  expect(await screen.findByRole("heading", { name: "Files" })).toBeVisible();
  expect(calls.some((c) => c.path.startsWith("/batches"))).toBe(false);
  await userEvent.selectOptions(await screen.findByLabelText("Niche"), "Cleaning");
  const upload = new File(["x"], "tulsa.xlsx");
  await userEvent.upload(screen.getByLabelText(/Excel file/), upload);
  await userEvent.click(screen.getByRole("button", { name: "Upload and check" }));

  const dialog = await screen.findByRole("dialog", { name: "tulsa.xlsx" });
  expect(within(dialog).getByText(/2 errors to fix/)).toBeVisible();
  expect(within(dialog).getByRole("cell", { name: /Phone holds letters/ })).toBeVisible();
  expect(within(dialog).getByRole("link", { name: /Download problems to fix/ })).toHaveAttribute(
    "href",
    "/api/submissions/f1/marked.xlsx",
  );
  expect(within(dialog).getByText(/Upload revised version/)).toBeVisible();
  const sent = calls.find((c) => c.method === "POST" && c.path === "/submissions");
  expect(sent?.body).toMatchObject({ niche: "Cleaning" });
});

test("a used file says where, and can't be changed", async () => {
  const used = file({
    status: "used",
    errors: 0,
    batch: { batch_id: "b1", batch_name: "Batch 01", import_id: "i1", at: null, by: "Olivia" },
  });
  mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": [200, [used]],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "GET /submissions/f1": [200, { ...detail, ...used, problems: [] }],
  });
  render(<App />);

  expect(await screen.findByText("Batch 01")).toBeVisible();
  expect(screen.getByText(/Used in/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "tulsa.xlsx" }));
  const dialog = await screen.findByRole("dialog", { name: "tulsa.xlsx" });
  expect(within(dialog).queryByText(/Upload revised version/)).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
});

test("an owner adds a ready file to a batch of its niche", async () => {
  const ready = file({ status: "ready", errors: 0, warnings: 0 });
  const calls = mockApi({
    "GET /auth/me": me(owner),
    "GET /submissions": [200, [ready]],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "GET /batches": [200, [batch, { ...batch, id: "b2", name: "Roofs 01", niche: "Roofing" }]],
    "GET /submissions/f1": [200, { ...detail, ...ready, problems: [] }],
    "POST /submissions/f1/use": [200, { ...ready, status: "adding" }],
  });
  render(<App />);

  const aside = await screen.findByRole("complementary", { name: "Batches" });
  expect(await within(aside).findByText("Batch 01")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "tulsa.xlsx" }));
  const dialog = await screen.findByRole("dialog", { name: "tulsa.xlsx" });
  const select = within(dialog).getByLabelText("Add to batch");
  expect(within(select).queryByRole("option", { name: "Roofs 01" })).toBeNull();
  await userEvent.selectOptions(select, "b1");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add to batch" }));

  expect(calls.find((c) => c.path === "/submissions/f1/use")?.body).toEqual({ batch_id: "b1" });
  expect(window.location.search).toBe("?batch=b1&tab=files");
});
