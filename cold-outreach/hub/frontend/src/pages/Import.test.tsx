import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { LeadImport } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

function preview(overrides: Partial<LeadImport> = {}): LeadImport {
  return {
    id: "i1",
    file_name: "GBP_Data_2.xlsx",
    niche: "Cleaning",
    status: "preview",
    uploaded_by: "Sara",
    created_at: "2026-10-27T10:00:00Z",
    confirmed_at: null,
    counts: {
      tabs: 248,
      leads: 3995,
      new: 3995,
      updated: 0,
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
      no_gbp_link: ["MOLLY MAID (San Jose row 9)"],
      top: [],
      new_lists: ["Tulsa"],
    },
    ...overrides,
  };
}

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];

beforeEach(() => window.history.pushState(null, "", "/import"));
afterEach(() => vi.unstubAllGlobals());

test("upload a file, read the preview, send it to the Master Sheet", async () => {
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /imports": [200, []],
    "GET /lists": [200, []],
    "GET /niches": [200, ["Cleaning"]],
    "POST /imports": [201, preview()],
    "POST /imports/i1/confirm": [
      200,
      preview({
        status: "confirmed",
        counts: { ...preview().counts, sheet_added: 3995, sheet_updated: 0 },
      }),
    ],
  });
  render(<App />);

  const form = await screen.findByRole("form", { name: "Upload a lead file" });
  await userEvent.type(within(form).getByLabelText("Niche (one per file)"), "Cleaning");
  fireEvent.change(within(form).getByLabelText("Excel file"), {
    target: { files: [new File(["xlsx"], "GBP_Data_2.xlsx")] },
  });
  await userEvent.click(within(form).getByRole("button", { name: "Read the file" }));

  const card = await screen.findByRole("article", { name: "Preview" });
  // 3,995 businesses, all of them new.
  expect(within(card).getAllByText("3,995", { selector: ".count-value" })).toHaveLength(2);
  expect(within(card).getByText("without a GBP link").previousSibling).toHaveTextContent("2");
  expect(within(card).getByText(/no Level column/)).toBeVisible();
  await userEvent.click(within(card).getByText("Columns that were ignored"));
  expect(within(card).getByText("Operation Hour (in 1 tab)")).toBeVisible();
  await userEvent.click(
    within(card).getByRole("button", { name: "Send 3,995 businesses to the Master Sheet" }),
  );

  expect(await screen.findByText(/3995 rows added and 0 updated/)).toBeVisible();
  const posted = calls.find((c) => c.path === "/imports" && c.method === "POST");
  expect(posted?.csrf).toBe("t");
  expect((posted?.body as { niche: string }).niche).toBe("Cleaning");
});

test("an unreadable file shows why", async () => {
  mockApi({
    "GET /auth/me": as("owner"),
    "GET /imports": [200, []],
    "GET /lists": [200, []],
    "GET /niches": [200, []],
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

  const form = await screen.findByRole("form", { name: "Upload a lead file" });
  fireEvent.change(within(form).getByLabelText("Excel file"), {
    target: { files: [new File(["a,b"], "leads.csv")] },
  });
  await userEvent.click(within(form).getByRole("button", { name: "Read the file" }));

  expect(await within(form).findAllByText("This isn't an Excel file (.xlsx).")).toHaveLength(2);
});

test("a viewer sees the history and lists but can't upload or switch", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /imports": [200, [preview({ status: "confirmed" })]],
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

  expect(await screen.findByText("Sent to the Master Sheet")).toBeVisible();
  expect(screen.queryByRole("form", { name: "Upload a lead file" })).not.toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Tulsa · Cleaning on or off" })).toBeDisabled();
});

test("a waiting preview opens again and can be discarded", async () => {
  let discarded = false;
  const calls = mockApi({
    "GET /auth/me": as("owner"),
    "GET /imports": () => [200, [preview(discarded ? { status: "discarded" } : {})]],
    "GET /lists": [200, []],
    "GET /niches": [200, []],
    "POST /imports/i1/discard": () => {
      discarded = true;
      return [200, preview({ status: "discarded" })];
    },
  });
  render(<App />);

  const card = await screen.findByRole("article", { name: "Preview" });
  await userEvent.click(within(card).getByRole("button", { name: "Discard" }));

  expect(await screen.findByRole("form", { name: "Upload a lead file" })).toBeVisible();
  expect(calls.some((c) => c.path === "/imports/i1/discard")).toBe(true);
});
