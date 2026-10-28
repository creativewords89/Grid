import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import type { Lead, LeadDetail, LeadPage } from "../api";
import { BatchLeads } from "./Leads";
import { makeUser, mockApi } from "../test/mockApi";

function lead(id: string, overrides: Partial<Lead> = {}): Lead {
  return {
    lead_id: id,
    batch_id: "b1",
    batch_name: "Batch 1",
    niche: "Cleaning",
    city: "Tulsa",
    business_name: "Multi-Clean",
    level: "",
    gbp_link: "https://share.google/mc",
    emails: ["kevin@mc.com", "info@mc.com"],
    data: { phone: "(918) 523-8300", website: "https://mc.com/", address: "12 Elm St" },
    extra: {},
    results: {},
    ...overrides,
  };
}

function leadPage(leads: Lead[], overrides: Partial<LeadPage> = {}): LeadPage {
  return {
    leads,
    total: leads.length,
    page: 1,
    pages: 1,
    agents: {},
    extra_columns: [],
    ...overrides,
  };
}

function detail(overrides: Partial<LeadDetail> = {}): LeadDetail {
  return { ...lead("L-000001"), files: [], can_edit: true, ...overrides };
}

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];

afterEach(() => vi.unstubAllGlobals());

test("the leads show like a sheet, with the agents' scores, filters and pages", async () => {
  const calls = mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": [
      200,
      leadPage(
        [
          lead("L-000001", {
            results: {
              "gbp-audit": {
                status: "OK",
                score: 61,
                summary: "Posts are rare.",
                details: {},
                benchmark_id: null,
                benchmark_version: 1,
                at: "2026-10-28T08:00:00Z",
              },
            },
          }),
          lead("L-000002", { business_name: "Top Shine", level: "Top", emails: [] }),
        ],
        { total: 230, pages: 3, agents: { "gbp-audit": "GBP" } },
      ),
    ],
    "GET /leads?batch_id=b1&page=1&q=shine": [200, leadPage([])],
    "GET /leads?batch_id=b1&page=1&q=shine&level=top": [200, leadPage([])],
    "GET /leads?batch_id=b1&page=2": [
      200,
      leadPage([lead("L-000101")], { total: 230, page: 2, pages: 3 }),
    ],
  });
  render(<BatchLeads batchId="b1" />);

  const rows = await screen.findAllByRole("row");
  expect(screen.getByText("230 leads · page 1 of 3")).toBeVisible();
  expect(within(rows[0]!).getByText("GBP")).toBeVisible();
  expect(within(rows[1]!).getByText("61")).toBeVisible();
  // Every field of the lead file is a column, links open in a new tab.
  const headers = within(rows[0]!)
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
  expect(headers).toEqual([
    "Lead ID",
    "Business name",
    "GBP link",
    "Address",
    "City",
    "Website",
    "Phone",
    "WhatsApp",
    "Email",
    "Facebook",
    "Instagram",
    "Reviews",
    "Rating",
    "Level",
    "Notes",
    "Batch",
    "GBP",
  ]);
  expect(within(rows[1]!).getByText("kevin@mc.com, info@mc.com")).toBeVisible();
  expect(within(rows[1]!).getByText("12 Elm St")).toBeVisible();
  expect(within(rows[1]!).getByRole("link", { name: "mc.com/" })).toHaveAttribute(
    "href",
    "https://mc.com/",
  );
  expect(within(rows[1]!).getByRole("link", { name: "Open map" })).toHaveAttribute(
    "target",
    "_blank",
  );
  expect(within(rows[2]!).getByText("Top")).toBeVisible();
  expect(screen.getByRole("link", { name: "Download Excel" })).toHaveAttribute(
    "href",
    "/api/leads/export?batch_id=b1",
  );

  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("L-000101")).toBeVisible();

  await userEvent.type(screen.getByLabelText("Search"), "shine");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("No leads match.")).toBeVisible();
  await userEvent.selectOptions(screen.getByLabelText("Top"), "top");
  await screen.findByText("No leads match.");
  expect(calls.some((c) => c.path === "/leads?batch_id=b1&page=1&q=shine&level=top")).toBe(true);
  expect(screen.getByRole("link", { name: "Download Excel" })).toHaveAttribute(
    "href",
    "/api/leads/export?batch_id=b1&q=shine&level=top",
  );
});

test("sorting by an agent's score", async () => {
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": [200, leadPage([lead("L-000001")], { agents: { demo: "Demo" } })],
    "GET /leads?batch_id=b1&sort=score&score_of=demo&page=1": [200, leadPage([])],
  });
  render(<BatchLeads batchId="b1" />);

  expect(await screen.findByText("Multi-Clean")).toBeVisible();
  await userEvent.selectOptions(screen.getByLabelText("Sort by"), "score:demo");
  await screen.findByText("No leads match.");
  expect(calls.some((c) => c.path.includes("sort=score&score_of=demo"))).toBe(true);
});

test("open a lead, change it and mark it Top", async () => {
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": [200, leadPage([lead("L-000001")])],
    "GET /leads/L-000001": [
      200,
      detail({
        files: [
          {
            id: "f1",
            agent_key: "gbp-audit",
            name: "gbp-report.pdf",
            content_type: "application/pdf",
            size: 20480,
            created_at: "2026-10-28T08:00:00Z",
          },
        ],
      }),
    ],
    "PATCH /leads/L-000001": [200, detail({ level: "Top", emails: ["owner@mc.com"] })],
  });
  render(<BatchLeads batchId="b1" />);

  await userEvent.click(await screen.findByRole("button", { name: "Multi-Clean" }));
  const dialog = await screen.findByRole("dialog", { name: "Multi-Clean" });
  expect(within(dialog).getByText("12 Elm St")).toBeVisible();
  expect(within(dialog).getByText("No agent has checked this lead yet.")).toBeVisible();
  expect(within(dialog).getByRole("link", { name: "gbp-report.pdf" })).toHaveAttribute(
    "href",
    "/api/leads/L-000001/files/f1",
  );
  const email = within(dialog).getByLabelText("Email(s)");
  expect(email).toHaveValue("kevin@mc.com, info@mc.com");
  await userEvent.clear(email);
  await userEvent.type(email, "owner@mc.com");
  await userEvent.click(within(dialog).getByLabelText("Top (never contacted)"));
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

  expect(await within(dialog).findByText("Saved.")).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    email: "owner@mc.com",
    phone: "(918) 523-8300",
    website: "https://mc.com/",
    level: "Top",
    notes: "",
  });
});

test("deleting a lead asks once more", async () => {
  let deleted = false;
  mockApi({
    "GET /auth/me": as("owner"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": () => [200, leadPage(deleted ? [] : [lead("L-000001")])],
    "GET /leads/L-000001": [200, detail()],
    "DELETE /leads/L-000001": () => {
      deleted = true;
      return [204];
    },
  });
  render(<BatchLeads batchId="b1" />);

  await userEvent.click(await screen.findByRole("button", { name: "Multi-Clean" }));
  const dialog = await screen.findByRole("dialog", { name: "Multi-Clean" });
  await userEvent.click(await within(dialog).findByRole("button", { name: "Delete this lead" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete L-000001 for good" }));

  expect(await screen.findByText("No leads match.")).toBeVisible();
});

test("a viewer sees a lead but can't change it", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": [200, leadPage([lead("L-000001")])],
    "GET /leads/L-000001": [200, detail({ can_edit: false })],
  });
  render(<BatchLeads batchId="b1" />);

  await userEvent.click(await screen.findByRole("button", { name: "Multi-Clean" }));
  const dialog = await screen.findByRole("dialog", { name: "Multi-Clean" });

  expect(await within(dialog).findByLabelText("Email(s)")).toBeDisabled();
  expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
});

test("only web addresses become links", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": [
      200,
      leadPage([
        lead("L-000001", {
          gbp_link: "",
          data: { website: "javascript:alert(1)", facebook: "sparkle.cleaning" },
        }),
      ]),
    ],
  });
  render(<BatchLeads batchId="b1" />);

  const row = (await screen.findAllByRole("row"))[1]!;
  expect(within(row).getByText("javascript:alert(1)").closest("a")).toBeNull();
  expect(within(row).getByRole("link", { name: "sparkle.cleaning" })).toHaveAttribute(
    "href",
    "https://sparkle.cleaning",
  );
});
