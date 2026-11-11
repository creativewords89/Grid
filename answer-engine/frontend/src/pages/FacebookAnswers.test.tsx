import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { FbThreadDetail, FbThreadList } from "../api";
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
const list: FbThreadList = {
  items: [row],
  counts: { todo: 1, draft: 0, approved: 0, skipped: 0 },
  can_load: true,
};
const detail: FbThreadDetail = {
  ...row,
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

beforeEach(() => window.history.pushState(null, "", "/facebook"));
afterEach(() => vi.unstubAllGlobals());

test("two selected comments are saved as two answers when approved", async () => {
  const calls = mockApi({
    "GET /auth/me": owner,
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /fb/threads": [200, list],
    "GET /fb/threads/t1": [200, detail],
    "PUT /fb/threads/t1/answer": (body) => [
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
    "GET /auth/me": owner,
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /fb/threads": [200, list],
    "GET /fb/threads/t1": [200, detail],
    "POST /fb/threads/t1/rework": [
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

test("before the data is loaded an Owner can load it", async () => {
  mockApi({
    "GET /auth/me": owner,
    "GET /reviews/count": [200, { waiting: 0 }],
    "GET /fb/threads": [200, { ...list, items: [] }],
  });
  render(<App />);

  expect(await screen.findByRole("button", { name: "Load the data file" })).toBeVisible();
});

test("Users don't see the page", async () => {
  mockApi({
    "GET /auth/me": [200, { user: makeUser(), csrf_token: "t" }],
    "GET /conversations": [200, []],
  });
  render(<App />);

  expect(await screen.findByRole("link", { name: "Ask" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "Facebook answers" })).toBeNull();
});
