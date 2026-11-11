import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { FbThreadDetail, FbThreadList, QuestionSet } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const owner = [200, { user: makeUser({ role: "owner", name: "Olivia" }), csrf_token: "t" }] as [
  number,
  unknown,
];
const row = {
  id: "t1",
  key: "s315",
  title: "Should a roofer's GBP description list every town?",
  topic: "Google Business Profile",
  subtopic: "Profile Edits & Info",
  status: "todo" as const,
  noise: false,
  rows: [315],
  talk: 3,
};
const fbSet: QuestionSet = {
  id: "s1",
  name: "Local SEO group",
  source: "Facebook group",
  url: "",
  total: 1,
  counts: { todo: 1, draft: 0, approved: 0, skipped: 0 },
  created_at: "2026-11-01T10:00:00Z",
};
const reddit: QuestionSet = {
  ...fbSet,
  id: "s2",
  name: "Reddit r/localseo",
  source: "Reddit",
  total: 0,
  counts: { todo: 0, draft: 0, approved: 0, skipped: 0 },
};
const sets = [200, { items: [fbSet, reddit], can_manage: true }] as [number, unknown];
const list: FbThreadList = {
  set: fbSet,
  items: [row],
  counts: { todo: 1, draft: 0, approved: 0, skipped: 0 },
  can_manage: true,
};
const detail: FbThreadDetail = {
  ...row,
  set_id: "s1",
  set_name: "Local SEO group",
  posts: [
    {
      row: 315,
      url: "https://facebook.com/groups/g/permalink/315/",
      author: "Dan",
      question: "I'm a roofer. Should my description list towns?",
      summary: "",
      note: null,
      pinned: 1,
      comments: [
        ["Ann", "It depends how broad your area is.", [["Dan", "Thanks!", []]]],
        ["Bob", "Mention the main town naturally.", []],
      ],
      picked: [
        ["0", "e"],
        ["1", "t"],
      ],
    },
  ],
  similar: [
    {
      id: "t2",
      title: "Can a plumber add city names to services?",
      status: "approved",
      rows: [316],
      items: [{ label: "", picks: [], text: "Only where you really work." }],
    },
  ],
  answer: { title: row.title, items: [], status: "todo", answered_by: null, answered_at: null },
};

const earlierPath = `/qb/answers?${new URLSearchParams({ q: row.title, other_than: "t1" }).toString()}`;
const base = {
  "GET /auth/me": owner,
  "GET /reviews/count": [200, { waiting: 0 }] as [number, unknown],
  "GET /qb/sets": sets,
  "GET /qb/sets/s1/threads": [200, list] as [number, unknown],
  "GET /qb/threads/t1": [200, detail] as [number, unknown],
};

beforeEach(() => {
  window.localStorage.removeItem("qb-set");
  window.history.pushState(null, "", "/question-bank");
});
afterEach(() => vi.unstubAllGlobals());

test("two selected comments are saved as two answers when approved", async () => {
  const calls = mockApi({
    ...base,
    "PUT /qb/threads/t1/answer": (body) => [
      200,
      {
        ...detail,
        status: "approved",
        answer: { ...detail.answer, ...(body as object), status: "approved" },
      },
    ],
  });
  render(<App />);

  expect(await screen.findByText("I'm a roofer. Should my description list towns?")).toBeVisible();
  expect(screen.getByText("Only where you really work.")).toBeVisible();
  const select = screen.getAllByRole("button", { name: "Select" });
  await userEvent.click(select[0]!); // Ann
  await userEvent.click(screen.getAllByRole("button", { name: "Select" }).at(-1)!); // Bob
  expect(screen.getByText("Answer 1")).toBeVisible();
  expect(screen.getByText("Answer 2")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));

  expect(await screen.findByText(/Approved: 2 verified answers/)).toBeVisible();
  expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
    title: row.title,
    status: "approved",
    items: [
      { label: "", picks: ["315:0"], text: "It depends how broad your area is." },
      { label: "", picks: ["315:1"], text: "Mention the main town naturally." },
    ],
  });
});

test("fit to post keeps the answer and lists what changed", async () => {
  const calls = mockApi({
    ...base,
    "POST /qb/threads/t1/rework": [
      200,
      {
        answer: "As a roofer, mention your main town naturally.",
        changes: ["Made it about roofing"],
      },
    ],
  });
  render(<App />);

  await userEvent.click((await screen.findAllByRole("button", { name: "Select" })).at(-1)!);
  await userEvent.click(screen.getByRole("button", { name: "Fit to post" }));

  expect(await screen.findByText(/Changed: Made it about roofing/)).toBeVisible();
  expect(screen.getByLabelText("Answer")).toHaveValue(
    "As a roofer, mention your main town naturally.",
  );
  expect(calls.find((c) => c.method === "POST")?.body).toEqual({
    mode: "fit",
    text: "Mention the main town naturally.",
    label: "",
    instruction: "",
  });
  await userEvent.click(screen.getByRole("button", { name: "Undo the last change by Claude" }));
  expect(screen.getByLabelText("Answer")).toHaveValue("Mention the main town naturally.");
});

test("answers given before in another set can be reused", async () => {
  mockApi({
    ...base,
    [`GET ${earlierPath}`]: [
      200,
      [
        {
          id: "t9",
          set_name: "Reddit r/localseo",
          title: "Should I list towns in my GBP?",
          status: "approved",
          items: [{ label: "", picks: [], text: "List the main town only." }],
        },
      ],
    ],
  });
  render(<App />);

  const before = await screen.findByText("Answered before (1)");
  await userEvent.click(before);
  const box = within(before.closest("details")!);
  expect(box.getByText(/Reddit r\/localseo · Approved/)).toBeVisible();
  await userEvent.click(box.getByRole("button", { name: "Use this answer" }));

  expect(screen.getByLabelText("Answer")).toHaveValue("List the main town only.");
});

test("a similar thread opens when its title is clicked", async () => {
  const other = {
    ...detail,
    id: "t2",
    key: "s316",
    title: "Can a plumber add city names to services?",
    rows: [316],
    similar: [],
    answer: { ...detail.answer, title: "Can a plumber add city names to services?" },
  };
  mockApi({ ...base, "GET /qb/threads/t2": [200, other] });
  render(<App />);

  await userEvent.click(
    await screen.findByRole("button", { name: "Can a plumber add city names to services?" }),
  );

  expect(
    await screen.findByRole("heading", { name: "Can a plumber add city names to services?" }),
  ).toBeVisible();
});

test("a link from a verified answer opens its set and thread", async () => {
  window.history.pushState(null, "", "/question-bank?set=s1&thread=t1");
  window.localStorage.setItem("qb-set", "s2");
  mockApi(base);
  render(<App />);

  expect(await screen.findByRole("heading", { name: row.title })).toBeVisible();
  expect(screen.getByLabelText("Question set")).toHaveValue("s1");
  expect(screen.getByRole("button", { name: "All 1", pressed: true })).toBeVisible();
});

test("the thread's breadcrumb filters the list to its topic", async () => {
  const other = { ...row, id: "t5", key: "s5", title: "How do I get reviews?", topic: "Reviews" };
  mockApi({
    ...base,
    "GET /qb/sets/s1/threads": [
      200,
      { ...list, items: [row, other], counts: { ...list.counts, todo: 2 } },
    ],
  });
  render(<App />);

  const list_ = await screen.findByRole("complementary", { name: "Questions" });
  expect(await within(list_).findByText("How do I get reviews?")).toBeVisible();
  const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
  expect(crumbs).toHaveTextContent("Local SEO group›Google Business Profile›Profile Edits & Info");

  await userEvent.click(within(crumbs).getByRole("button", { name: "Google Business Profile" }));

  expect(screen.getByLabelText("Topic")).toHaveValue("Google Business Profile");
  expect(within(list_).queryByText("How do I get reviews?")).toBeNull();
  await userEvent.click(within(crumbs).getByRole("button", { name: "Local SEO group" }));
  expect(within(list_).getByText("How do I get reviews?")).toBeVisible();
});

test("the set picker switches sets and is remembered", async () => {
  mockApi({
    ...base,
    "GET /qb/sets/s2/threads": [
      200,
      { set: reddit, items: [], counts: reddit.counts, can_manage: true },
    ],
  });
  render(<App />);

  await userEvent.selectOptions(await screen.findByLabelText("Question set"), "s2");

  expect(await screen.findByRole("heading", { name: "Reddit r/localseo" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Upload the questions" })).toBeVisible();
  expect(window.localStorage.getItem("qb-set")).toBe("s2");
});

test("an Owner creates a new set, then uploads its questions", async () => {
  const made = { ...reddit, id: "s3", name: "Client emails" };
  let created = false;
  const calls = mockApi({
    ...base,
    "GET /qb/sets": () => [
      200,
      { items: created ? [fbSet, reddit, made] : [fbSet, reddit], can_manage: true },
    ],
    "POST /qb/sets": () => ((created = true), [201, made]),
    "GET /qb/sets/s3/threads": [
      200,
      { set: made, items: [], counts: made.counts, can_manage: true },
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "+ New set" }));
  await userEvent.type(screen.getByLabelText("Name"), "Client emails");
  await userEvent.type(screen.getByLabelText(/Where the questions come from/), "Email");
  await userEvent.click(screen.getByRole("button", { name: "Create the set" }));

  expect(calls.find((c) => c.method === "POST")?.body).toEqual({
    name: "Client emails",
    source: "Email",
    url: "",
  });
  expect(await screen.findByRole("heading", { name: "Upload the questions" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Choose a file" })).toBeVisible();
});

test("deleting a set needs its name typed", async () => {
  const calls = mockApi({ ...base, "DELETE /qb/sets/s1": [204] });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Set settings" }));
  const remove = screen.getByRole("button", { name: "Delete the set" });
  expect(remove).toBeDisabled();
  await userEvent.type(screen.getByLabelText("Type the set's name to confirm"), "Local SEO group");
  await userEvent.click(remove);

  expect(calls.some((c) => c.method === "DELETE" && c.path === "/qb/sets/s1")).toBe(true);
});

test("with no sets yet an Owner starts the first one", async () => {
  mockApi({ ...base, "GET /qb/sets": [200, { items: [], can_manage: true }] });
  render(<App />);

  expect(await screen.findByRole("button", { name: "Create the set" })).toBeVisible();
});

test("Reviewers work sets but don't manage them", async () => {
  mockApi({
    ...base,
    "GET /auth/me": [200, { user: makeUser({ role: "reviewer" }), csrf_token: "t" }],
    "GET /qb/sets": [200, { items: [fbSet], can_manage: false }],
    "GET /qb/sets/s1/threads": [200, { ...list, can_manage: false }],
  });
  render(<App />);

  const nav = await screen.findByRole("complementary", { name: "Questions" });
  expect(await within(nav).findByText(row.title)).toBeVisible();
  expect(screen.queryByRole("button", { name: "+ New set" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Set settings" })).toBeNull();
});

test("Users don't see the page", async () => {
  mockApi({
    "GET /auth/me": [200, { user: makeUser(), csrf_token: "t" }],
    "GET /conversations": [200, []],
  });
  render(<App />);

  expect(await screen.findByRole("link", { name: "Ask" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "Question Bank" })).toBeNull();
});
