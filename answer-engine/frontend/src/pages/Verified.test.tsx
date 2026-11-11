import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { VerifiedDetail, VerifiedPage } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const reviewer = [200, { user: makeUser({ role: "reviewer", name: "Ali" }), csrf_token: "t" }] as [
  number,
  unknown,
];
const row = {
  id: "v1",
  question: "How long does GBP verification take?",
  answer: "Usually 1-2 weeks.\nSometimes longer.",
  status: "active" as const,
  expires_at: null,
  needs_check: true,
  needs_check_reason: "Source deleted: Onboarding.pdf",
  approved_by: { id: "u2", name: "Ali" },
  origin: "review" as const,
  version: 2,
  updated_at: "2026-10-08T10:00:00Z",
  applies_when: null,
  also_asked: null,
  answer_group: null,
  topic: "Google Business Profile",
  subtopic: "Verification",
};
const page: VerifiedPage = {
  items: [row],
  can_manage: true,
  can_import: false,
  counts: { active: 1, disabled: 0, expired: 0, needs_check: 1, all: 1 },
  topics: [
    {
      name: "Google Business Profile",
      count: 1,
      subtopics: [{ name: "Verification", count: 1 }],
    },
  ],
};
const detail: VerifiedDetail = {
  ...row,
  origin_thread: null,
  group: [{ id: "v1", answer: row.answer, applies_when: null, status: "active" }],
  sources: [{ file_id: "f1", name: "Onboarding.pdf", available: false }],
  origin_answer_id: "a1",
  created_at: "2026-10-01T10:00:00Z",
  can_manage: true,
};

beforeEach(() => window.history.pushState(null, "", "/verified"));
afterEach(() => vi.unstubAllGlobals());

test("the list shows counts, the first line and why to check", async () => {
  mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /verified?show=active": [200, page],
  });
  render(<App />);

  expect(await screen.findByText(row.question)).toBeVisible();
  expect(screen.getByText("Usually 1-2 weeks.")).toBeVisible();
  expect(screen.getByText("Source deleted: Onboarding.pdf")).toBeVisible();
  expect(screen.getByRole("tab", { name: "Needs check (1)" })).toBeVisible();
});

test("editing saves the new answer", async () => {
  window.history.pushState(null, "", "/verified?id=v1");
  const calls = mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /verified/v1": [200, detail],
    "GET /verified/v1/history": [
      200,
      [
        {
          version: 2,
          question: row.question,
          answer: row.answer,
          changed_by: null,
          at: row.updated_at,
        },
        {
          version: 1,
          question: row.question,
          answer: "Old.",
          changed_by: null,
          at: row.updated_at,
        },
      ],
    ],
    "PATCH /verified/v1": [200, detail],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Edit answer" }));
  const box = screen.getByLabelText("Answer");
  await userEvent.clear(box);
  await userEvent.type(box, "Two weeks.");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Saved. Search is updated.")).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    question: row.question,
    answer: "Two weeks.",
    applies_when: "",
    also_asked: "",
    topic: "Google Business Profile",
    subtopic: "Verification",
  });
  expect(screen.getByText("Onboarding.pdf (deleted)")).toBeVisible();
  expect(screen.getByRole("button", { name: "Restore this version" })).toBeVisible();
});

test("people who can't manage only read", async () => {
  window.history.pushState(null, "", "/verified?id=v1");
  mockApi({
    "GET /auth/me": [200, { user: makeUser(), csrf_token: "t" }],
    "GET /verified/v1": [200, { ...detail, can_manage: false }],
    "GET /verified/v1/history": [200, []],
  });
  render(<App />);

  expect(await screen.findByText("Usually 1-2 weeks.", { exact: false })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Mark as checked" })).toBeNull();
});

/** Uploads go through XMLHttpRequest (for progress). */
function fakeUpload(body: unknown) {
  const sent: string[] = [];
  class FakeXHR {
    status = 0;
    responseText = "";
    upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open(_method: string, url: string) {
      sent.push(url);
    }
    setRequestHeader() {}
    send() {
      setTimeout(() => {
        this.status = 200;
        this.responseText = JSON.stringify(body);
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  return sent;
}

test("an Owner imports a file and sees what was added, updated and skipped", async () => {
  const sent = fakeUpload({
    created: 2,
    updated: 1,
    unchanged: 0,
    skipped: [{ row: 7, reason: "No question or no answer." }],
  });
  const imported = {
    ...row,
    id: "v2",
    question: "Should I show my address?",
    applies_when: "If customers visit you",
    origin: "import" as const,
    needs_check: false,
  };
  mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "owner" }), csrf_token: "t" }],
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /verified?show=active": [200, { ...page, items: [imported], can_import: true }],
  });
  render(<App />);

  expect(await screen.findByText("When it applies: If customers visit you")).toBeVisible();
  await userEvent.upload(
    screen.getByLabelText("Import verified answers"),
    new File(["question,answer"], "facebook-answers.csv"),
  );

  expect(await screen.findByText(/Added 2 answers, updated 1, unchanged 0\./)).toBeVisible();
  expect(screen.getByText("Row 7: No question or no answer.")).toBeVisible();
  expect(sent).toEqual(["/api/verified/import"]);
});

test("people who can't import don't see the button", async () => {
  mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /verified?show=active": [200, page],
  });
  render(<App />);

  expect(await screen.findByText(row.question)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Import from a file" })).toBeNull();
});

test("answers are grouped by topic and a topic can be chosen", async () => {
  const citations = {
    ...row,
    id: "v3",
    question: "Is Yext worth it?",
    topic: "Citations",
    subtopic: "Tools",
    needs_check: false,
  };
  const loose = { ...row, id: "v4", question: "Is SEO dead?", topic: "", subtopic: "" };
  mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /verified?show=active": [
      200,
      {
        ...page,
        items: [citations, row, loose],
        topics: [
          { name: "Citations", count: 1, subtopics: [{ name: "Tools", count: 1 }] },
          ...page.topics,
          { name: "", count: 1, subtopics: [{ name: "", count: 1 }] },
        ],
      },
    ],
  });
  render(<App />);

  const topics = await screen.findByRole("navigation", { name: "Topics" });
  expect(
    within(topics)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["All topics3", "Citations1", "Google Business Profile1", "No topic1"]);
  expect(screen.getByRole("region", { name: "Citations" })).toHaveTextContent("Is Yext worth it?");
  expect(screen.getByRole("region", { name: "No topic" })).toHaveTextContent("Is SEO dead?");

  await userEvent.click(within(topics).getByRole("button", { name: /Google Business Profile/ }));

  expect(screen.queryByText("Is Yext worth it?")).toBeNull();
  expect(screen.getByRole("region", { name: "Verification" })).toHaveTextContent(row.question);
});

test("every answer to a question sits side by side, each with its own actions", async () => {
  window.history.pushState(null, "", "/verified?id=v1");
  const group = [
    { id: "v1", answer: "Yes, show it.", applies_when: "If customers visit you", status: "active" },
    {
      id: "v2",
      answer: "No, hide it.\n\nSet service areas.",
      applies_when: "If you travel to customers",
      status: "active",
    },
    { id: "v3", answer: "It depends.", applies_when: null, status: "disabled" },
  ] as VerifiedDetail["group"];
  const two: VerifiedDetail = {
    ...detail,
    question: "Should I show my address?",
    answer: "Yes, show it.",
    applies_when: "If customers visit you",
    also_asked: "Hi all, I run a shop and wonder about my address",
    group,
  };
  const calls = mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /verified/v1": [200, two],
    "GET /verified/v1/history": [200, []],
    "POST /verified/v2/disable": [200, two],
    "GET /verified/v2": [200, { ...two, id: "v2", answer: group[1]!.answer }],
    "GET /verified/v2/history": [200, []],
    "GET /verified?show=all": [200, page],
  });
  render(<App />);

  const answers = await screen.findByRole("region", { name: "Answers" });
  expect(answers.querySelector(".va-grid")).toHaveAttribute("data-n", "3");
  const second = within(answers).getByRole("article", { name: "Answer 2" });
  expect(within(second).getByText("When it applies: If you travel to customers")).toBeVisible();
  expect(within(second).getByText("Set service areas.")).toBeVisible();
  expect(within(answers).getByRole("article", { name: "Answer 3" })).toHaveTextContent("Disabled");
  expect(screen.getByText("Also asked as")).toBeVisible();

  await userEvent.click(within(second).getByRole("button", { name: "Disable" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/verified/v2/disable")).toBe(true);

  // Edit on another answer opens it, ready to edit.
  await userEvent.click(within(second).getByRole("button", { name: "Edit answer 2" }));
  expect(await screen.findByLabelText("Answer")).toHaveValue("No, hide it.\n\nSet service areas.");
  expect(window.location.search).toBe("?id=v2");
});

test("a breadcrumb shows the topic and leads back to it, and the source thread is linked", async () => {
  window.history.pushState(null, "", "/verified?id=v1");
  mockApi({
    "GET /auth/me": reviewer,
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /verified/v1": [
      200,
      {
        ...detail,
        origin_thread: { id: "t9", set_id: "s1", set_name: "Facebook group", rows: [604] },
      },
    ],
    "GET /verified/v1/history": [200, []],
    "GET /verified?show=active": [200, page],
  });
  render(<App />);

  const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
  await within(crumbs).findByRole("button", { name: "Verification" });
  expect(crumbs).toHaveTextContent(
    `Verified Answers›Google Business Profile›Verification›${row.question}`,
  );
  expect(screen.getByRole("link", { name: "Facebook group · Row 604" })).toHaveAttribute(
    "href",
    "/question-bank?set=s1&thread=t9",
  );

  await userEvent.click(within(crumbs).getByRole("button", { name: "Google Business Profile" }));

  const topics = await screen.findByRole("navigation", { name: "Topics" });
  expect(within(topics).getByRole("button", { name: /Google Business Profile/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
});
