import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { Batch, Benchmark, LeadImport } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

function preview(overrides: Partial<LeadImport> = {}): LeadImport {
  return {
    id: "i1",
    file_name: "GBP_Data_2.xlsx",
    niche: "Cleaning",
    batch_id: "b1",
    batch_name: "Batch 1",
    status: "preview",
    uploaded_by: "Sara",
    created_at: "2026-10-27T10:00:00Z",
    confirmed_at: null,
    counts: {
      tabs: 248,
      leads: 3995,
      new: 3990,
      updated: 0,
      other_batch: 5,
      merged: 0,
      top: 0,
      no_gbp_link: 2,
      no_website: 877,
      skipped_rows: 1,
      invalid_emails: 14,
      cities: 236,
      new_lists: 236,
    },
    preview: {
      has_level_column: false,
      empty_tabs: ["Jackson"],
      unknown_columns: { "Operation Hour": ["Henderson"] },
      skipped_rows: ["Enterprise row 4"],
      invalid_emails: ["Columbus row 16: http:"],
      merged_rows: [],
      updated: [],
      other_batch: ["Sparkle (L-000004, in Spring batch)"],
      no_gbp_link: ["MOLLY MAID (San Jose row 9)"],
      top: [],
      new_lists: ["Tulsa"],
    },
    ...overrides,
  };
}

function batch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: "b1",
    name: "Batch 1",
    niche: "Cleaning",
    benchmark: { id: "m1", name: "Cleaning Benchmark 1", version: 2 },
    leads: 0,
    top: 0,
    files: 0,
    agents: [],
    created_at: "2026-10-27T10:00:00Z",
    can_edit: true,
    can_rename: true,
    can_delete: true,
    ...overrides,
  };
}

function benchmark(id: string, name: string, niche = "Cleaning"): Benchmark {
  return {
    id,
    name,
    niche,
    version: 1,
    gbp: {},
    website: {},
    batches: [],
    updated_by: null,
    updated_at: "2026-10-27T10:00:00Z",
    can_edit: true,
  };
}

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];

beforeEach(() => window.history.pushState(null, "", "/batches"));
afterEach(() => vi.unstubAllGlobals());

test("make a batch: a name, its niche and a benchmark of that niche", async () => {
  let made = false;
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": () => [200, made ? [batch({ name: "Texas November" })] : []],
    "GET /lists": [200, []],
    "GET /benchmarks": [
      200,
      [
        benchmark("m1", "Cleaning Benchmark 1"),
        benchmark("m2", "Cleaning Benchmark 2"),
        benchmark("m3", "Roofing Benchmark 1", "Roofing"),
      ],
    ],
    "GET /imports?batch_id=b1": [200, []],
    "POST /batches": () => {
      made = true;
      return [201, batch({ name: "Texas November" })];
    },
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "+ New batch" }));
  const form = screen.getByRole("form", { name: "New batch" });
  await userEvent.type(within(form).getByLabelText("Batch name"), "Texas November");
  await userEvent.type(within(form).getByLabelText("Niche (one per batch)"), "cleaning");
  const select = within(form).getByLabelText("Benchmark");
  // Only this niche's benchmarks are offered.
  expect(
    within(select)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["Choose…", "Cleaning Benchmark 1", "Cleaning Benchmark 2"]);
  await userEvent.selectOptions(select, "m2");
  await userEvent.click(within(form).getByRole("button", { name: "Make the batch" }));

  expect(await screen.findByRole("heading", { name: "Texas November" })).toBeVisible();
  expect(screen.getByRole("form", { name: "Add a lead file" })).toBeVisible();
  expect(calls.find((c) => c.path === "/batches" && c.method === "POST")?.body).toEqual({
    name: "Texas November",
    niche: "cleaning",
    benchmark_id: "m2",
  });
});

test("a niche without a benchmark points to the Benchmarks screen", async () => {
  mockApi({
    "GET /auth/me": as("owner"),
    "GET /batches": [200, []],
    "GET /lists": [200, []],
    "GET /benchmarks": [200, [benchmark("m1", "Cleaning Benchmark 1")]],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "+ New batch" }));
  await userEvent.type(screen.getByLabelText("Niche (one per batch)"), "Plumbing");

  expect(screen.getByText(/No benchmark for this niche yet/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Make one on Benchmarks" })).toBeVisible();
  expect(screen.getByLabelText("Benchmark")).toBeDisabled();
});

test("add a file to a batch, read the preview, send it to the Master Sheet", async () => {
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": [200, [batch({ leads: 12, files: 1, can_rename: false, can_delete: false })]],
    "GET /lists": [200, []],
    "GET /benchmarks": [200, [benchmark("m1", "Cleaning Benchmark 1")]],
    "GET /imports?batch_id=b1": [200, []],
    "POST /imports": [201, preview()],
    "POST /imports/i1/confirm": [
      200,
      preview({
        status: "confirmed",
        counts: { ...preview().counts, sheet_added: 3990, sheet_updated: 5 },
      }),
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Batch 1" }));
  const form = await screen.findByRole("form", { name: "Add a lead file" });
  fireEvent.change(within(form).getByLabelText("Excel file"), {
    target: { files: [new File(["xlsx"], "GBP_Data_2.xlsx")] },
  });
  await userEvent.click(within(form).getByRole("button", { name: "Read the file" }));

  const card = await screen.findByRole("article", { name: "Preview" });
  expect(within(card).getByText("3,995", { selector: ".count-value" })).toBeVisible();
  expect(within(card).getByText("already in another batch").previousSibling).toHaveTextContent("5");
  await userEvent.click(within(card).getByText(/Already in another batch/));
  expect(within(card).getByText("Sparkle (L-000004, in Spring batch)")).toBeVisible();
  expect(within(card).getByText("without a GBP link").previousSibling).toHaveTextContent("2");
  expect(within(card).getByText(/no Level column/)).toBeVisible();
  await userEvent.click(within(card).getByText("Columns that were ignored"));
  expect(within(card).getByText("Operation Hour (in 1 tab)")).toBeVisible();
  await userEvent.click(
    within(card).getByRole("button", { name: "Send 3,995 businesses to the Master Sheet" }),
  );

  expect(await screen.findByText(/3990 rows added and 5 updated/)).toBeVisible();
  const posted = calls.find((c) => c.path === "/imports" && c.method === "POST");
  expect(posted?.csrf).toBe("t");
  expect((posted?.body as { batch_id: string }).batch_id).toBe("b1");
  // A batch with leads keeps its name and can't be deleted.
  expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
});

test("an unreadable file shows why", async () => {
  mockApi({
    "GET /auth/me": as("owner"),
    "GET /batches": [200, [batch()]],
    "GET /lists": [200, []],
    "GET /benchmarks": [200, []],
    "GET /imports?batch_id=b1": [200, []],
    "POST /imports": [
      422,
      {
        error: {
          code: "unreadable",
          message: "This isn't an Excel file (.xlsx).",
          fields: { file: "This isn't an Excel file (.xlsx)." },
        },
      },
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Batch 1" }));
  const form = await screen.findByRole("form", { name: "Add a lead file" });
  fireEvent.change(within(form).getByLabelText("Excel file"), {
    target: { files: [new File(["a,b"], "leads.csv")] },
  });
  await userEvent.click(within(form).getByRole("button", { name: "Read the file" }));

  expect(await within(form).findAllByText("This isn't an Excel file (.xlsx).")).toHaveLength(2);
});

test("change a batch's benchmark, and delete an empty batch", async () => {
  let deleted = false;
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": () => [200, deleted ? [] : [batch()]],
    "GET /lists": [200, []],
    "GET /benchmarks": [
      200,
      [benchmark("m1", "Cleaning Benchmark 1"), benchmark("m2", "Cleaning Benchmark 2")],
    ],
    "GET /imports?batch_id=b1": [200, []],
    "PATCH /batches/b1": [
      200,
      batch({ benchmark: { id: "m2", name: "Cleaning Benchmark 2", version: 1 } }),
    ],
    "DELETE /batches/b1": () => {
      deleted = true;
      return [204];
    },
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Batch 1" }));
  const settings = await screen.findByRole("generic", { name: "Batch settings" });
  await userEvent.selectOptions(
    await within(settings).findByLabelText("Benchmark"),
    await within(settings).findByRole("option", { name: "Cleaning Benchmark 2 (v1)" }),
  );
  await userEvent.click(within(settings).getByRole("button", { name: "Use this benchmark" }));
  expect(await within(settings).findByText(/Benchmark changed/)).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ benchmark_id: "m2" });

  await userEvent.click(within(settings).getByRole("button", { name: "Delete this empty batch" }));
  expect(await screen.findByText(/No batches yet/)).toBeVisible();
});

test("a viewer sees batches, files and lists but can't add or switch", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, [batch({ leads: 27, can_edit: false, can_rename: false })]],
    "GET /imports?batch_id=b1": [200, [preview({ status: "confirmed" })]],
    "GET /lists": [
      200,
      [
        {
          id: "l1",
          city: "Tulsa",
          niche: "Cleaning",
          active: true,
          daily_limit: null,
          leads: 27,
          top: 2,
        },
      ],
    ],
  });
  render(<App />);

  expect(await screen.findByText("Cleaning Benchmark 1 (v2)")).toBeVisible();
  expect(screen.queryByRole("button", { name: "+ New batch" })).not.toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Tulsa · Cleaning on or off" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Batch 1" }));
  expect(await screen.findByText("Sent to the Master Sheet")).toBeVisible();
  expect(screen.queryByRole("form", { name: "Add a lead file" })).not.toBeInTheDocument();
});

test("a waiting preview opens again and can be discarded", async () => {
  let discarded = false;
  const calls = mockApi({
    "GET /auth/me": as("owner"),
    "GET /batches": [200, [batch({ can_delete: false })]],
    "GET /lists": [200, []],
    "GET /benchmarks": [200, []],
    "GET /imports?batch_id=b1": () => [200, [preview(discarded ? { status: "discarded" } : {})]],
    "POST /imports/i1/discard": () => {
      discarded = true;
      return [200, preview({ status: "discarded" })];
    },
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Batch 1" }));
  const card = await screen.findByRole("article", { name: "Preview" });
  await userEvent.click(within(card).getByRole("button", { name: "Discard" }));

  expect(await screen.findByRole("form", { name: "Add a lead file" })).toBeVisible();
  expect(calls.some((c) => c.path === "/imports/i1/discard")).toBe(true);
});
