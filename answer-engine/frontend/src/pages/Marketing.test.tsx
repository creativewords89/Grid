import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { ThreadDetail, ThreadMessage, ThreadRow } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const me = [200, { user: makeUser(), csrf_token: "t" }] as [number, unknown];
const URL = "https://www.reddit.com/r/localseo/comments/1abc2de/how_long/";
const row: ThreadRow = {
  id: "reddit:1abc2de",
  platform: "reddit",
  platform_name: "Reddit",
  community: "r/localseo",
  title: "How long does GBP verification take?",
  original_url: URL,
  person: "u/dentist_dan",
  status: "ready_to_post",
  created_by: { id: "u1", name: "Sara" },
  posted_by: [],
  last_activity_at: new Date().toISOString(),
  created_at: "2026-10-20T10:00:00Z",
};
const question: ThreadMessage = {
  id: "m1",
  parent_id: null,
  author: "them",
  author_name: "u/dentist_dan",
  body: "How long does GBP verification take?",
  external_url: URL,
  state: null,
  posted_by: null,
  posted_at: null,
  created_by: { id: "u1", name: "Sara" },
  created_at: "2026-10-20T10:00:00Z",
  draft: null,
};
const draftMsg = (state: "ready" | "in_review" | "posted"): ThreadMessage => ({
  ...question,
  id: "m2",
  parent_id: "m1",
  author: "us",
  author_name: null,
  body: "Usually 1-2 weeks.",
  external_url: null,
  state,
  posted_by: state === "posted" ? { id: "u1", name: "Sara" } : null,
  posted_at: state === "posted" ? "2026-10-20T11:00:00Z" : null,
  created_at: "2026-10-20T10:01:00Z",
  draft: {
    answer_id: "a1",
    confidence: state === "in_review" ? 55 : 90,
    outcome: state === "in_review" ? "low" : "high",
    status: state === "in_review" ? "in_review" : "auto",
    sources: [],
    needs_info: null,
    corrected_after_post: null,
  },
});
const detail = (messages: ThreadMessage[], over: Partial<ThreadDetail> = {}): ThreadDetail => ({
  ...row,
  closed_at: null,
  close_reason: null,
  messages,
  can_close: true,
  can_delete: false,
  ...over,
});
const counts = {
  waiting_for_us: 2,
  in_review: 0,
  ready_to_post: 1,
  waiting_for_them: 0,
  closed: 0,
};

beforeEach(() => {
  window.history.pushState(null, "", "/marketing");
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const FB_URL = "https://www.facebook.com/groups/localbiz/posts/1234567890123456/";
const fbRow: ThreadRow = {
  ...row,
  id: "facebook:1234567890123456",
  platform: "facebook",
  platform_name: "Facebook",
  community: "localbiz",
  title: "Can I use a PO box for my GBP?",
  original_url: FB_URL,
  person: "Dan Miller",
  status: "waiting_for_them",
};
const platform = (slug: string, name: string, parser: "reddit" | "facebook") => ({
  id: slug,
  slug,
  name,
  enabled: true,
  parser,
  hosts: [],
  style_prompt: "",
  disclosure_line: null,
  position: 1,
  communities: [],
});
const platforms: [number, unknown] = [
  200,
  [platform("reddit", "Reddit", "reddit"), platform("facebook", "Facebook", "facebook")],
];
const empty: [number, unknown] = [200, { items: [], counts }];
const lists = (reddit = empty, facebook = empty) => ({
  "GET /platforms": platforms,
  "GET /threads?platform=reddit": reddit,
  "GET /threads?platform=facebook": facebook,
});
const none = { waiting_for_us: 0, in_review: 0, ready_to_post: 0, waiting_for_them: 0, closed: 0 };
const newPost = (p: string, name: string, threadId: string, community: string) => ({
  found: false,
  parsed: { platform: p, platform_name: name, thread_id: threadId, community, comment_id: null },
  thread: null,
  matched_message_id: null,
  reopened: false,
  error: null,
});

test("Facebook and Reddit tabs, each with a status filter", async () => {
  const calls = mockApi({
    "GET /auth/me": me,
    ...lists(
      [200, { items: [row], counts: { ...none, ready_to_post: 1 } }],
      [200, { items: [fbRow], counts: { ...none, waiting_for_them: 1, closed: 1 } }],
    ),
    "GET /threads?status=closed&platform=facebook": [
      200,
      { items: [], counts: { ...none, waiting_for_them: 1, closed: 1 } },
    ],
  });
  render(<App />);

  const side = await screen.findByRole("complementary", { name: "Conversations" });
  expect(await within(side).findByText(row.title)).toBeVisible();
  expect(within(side).getByRole("tab", { name: "Reddit 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(within(side).getByRole("heading", { name: "Reddit conversations" })).toBeVisible();
  expect(within(side).queryByText(fbRow.title)).toBeNull();
  expect(within(side).queryByRole("button", { name: /New conversation/ })).toBeNull();
  // With nothing open, the right side asks where the new post is.
  expect(screen.getByRole("heading", { name: "Where is the post?" })).toBeVisible();

  await userEvent.click(within(side).getByRole("tab", { name: "Facebook 2" }));
  expect(await within(side).findByText(fbRow.title)).toBeVisible();
  expect(within(side).getByText("Dan Miller · localbiz")).toBeVisible();
  expect(within(side).queryByText(row.title)).toBeNull();
  expect(window.localStorage.getItem("marketing-platform")).toBe("facebook");

  const filter = within(side).getByRole("button", { name: /Filter: All/ });
  await userEvent.click(filter);
  const menu = within(side).getByRole("menu", { name: "Filter by status" });
  expect(within(menu).getByRole("menuitemradio", { name: "All 2" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await userEvent.click(within(menu).getByRole("menuitemradio", { name: "Closed 1" }));

  expect(await within(side).findByText("No conversations are “Closed”.")).toBeVisible();
  expect(calls.some((c) => c.path === "/threads?status=closed&platform=facebook")).toBe(true);
  const active = within(side).getByRole("button", { name: /Filter: Closed/ });
  expect(active).toHaveClass("active");
  expect(within(side).queryByRole("menu")).toBeNull();
});

test("the last tab used is remembered", async () => {
  window.localStorage.setItem("marketing-platform", "facebook");
  mockApi({ "GET /auth/me": me, ...lists(empty, [200, { items: [fbRow], counts }]) });
  render(<App />);

  const side = await screen.findByRole("complementary", { name: "Conversations" });
  expect(await within(side).findByText(fbRow.title)).toBeVisible();
  expect(within(side).getByRole("tab", { name: /Facebook/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("Reddit: pick the platform, paste the code, and it drafts straight away", async () => {
  const calls = mockApi({
    "GET /auth/me": me,
    ...lists(),
    "POST /threads/resolve": [200, newPost("reddit", "Reddit", row.id, "r/localseo")],
    "POST /threads": [201, detail([question], { status: "waiting_for_us" })],
    "POST /threads/reddit%3A1abc2de/draft": [200, detail([question, draftMsg("ready")])],
    "GET /threads/reddit%3A1abc2de": [200, detail([question, draftMsg("ready")])],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: /^Reddit/ }));
  expect(await screen.findByRole("heading", { name: /Paste the post's code/ })).toBeVisible();
  await userEvent.type(screen.getByLabelText("Post code or link"), "1abc2de");
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(await screen.findByText(/we haven't answered it/)).toBeVisible();
  await userEvent.type(screen.getByLabelText("Their question"), question.body);
  await userEvent.type(screen.getByLabelText("Their username (optional)"), "u/dentist_dan");
  await userEvent.click(screen.getByRole("button", { name: "Start and draft reply" }));

  expect(await screen.findByText("Usually 1-2 weeks.")).toBeVisible();
  expect(window.location.search).toBe("?thread=reddit%3A1abc2de");
  expect(calls.find((c) => c.method === "POST" && c.path === "/threads")?.body).toEqual({
    url: "1abc2de",
    question: question.body,
    author_name: "u/dentist_dan",
  });
  expect(calls.find((c) => c.path.endsWith("/draft"))?.body).toEqual({ parent_id: "m1" });
  expect(screen.getByText(/Ready to post · 90% sure/)).toBeVisible();
});

test("Facebook: the permalink starts a conversation under the person's name", async () => {
  window.history.pushState(null, "", "/marketing?new=facebook");
  const calls = mockApi({
    "GET /auth/me": me,
    ...lists(),
    "POST /threads/resolve": [200, newPost("facebook", "Facebook", fbRow.id, "localbiz")],
    "POST /threads": [201, detail([question], { ...fbRow, status: "waiting_for_us" })],
    "POST /threads/facebook%3A1234567890123456/draft": [
      200,
      detail([question, draftMsg("ready")], fbRow),
    ],
    "GET /threads/facebook%3A1234567890123456": [200, detail([question, draftMsg("ready")], fbRow)],
  });
  render(<App />);

  expect(await screen.findByText(/click the post's date/)).toBeVisible();
  await userEvent.type(screen.getByLabelText("Post code or link"), FB_URL);
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(await screen.findByText(/localbiz · we haven't answered it/)).toBeVisible();
  await userEvent.type(screen.getByLabelText("Their question"), "Can I use a PO box?");
  await userEvent.type(screen.getByLabelText("Their name (optional)"), "Dan Miller");
  await userEvent.click(screen.getByRole("button", { name: "Start and draft reply" }));

  expect(await screen.findByText("Usually 1-2 weeks.")).toBeVisible();
  expect(calls.find((c) => c.method === "POST" && c.path === "/threads")?.body).toEqual({
    url: FB_URL,
    question: "Can I use a PO box?",
    author_name: "Dan Miller",
  });
  expect(screen.getByRole("link", { name: "Open on Facebook" })).toHaveAttribute("href", FB_URL);
  expect(screen.getByText(/post 1234567890123456/)).toBeVisible();
});

test("a code for the other platform says so", async () => {
  window.history.pushState(null, "", "/marketing?new=facebook");
  mockApi({
    "GET /auth/me": me,
    ...lists(),
    "POST /threads/resolve": [200, newPost("reddit", "Reddit", row.id, "")],
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Post code or link"), "1abc2de");
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(await screen.findByText(/That isn't a Facebook post: it looks like Reddit/)).toBeVisible();
  expect(screen.queryByLabelText("Their question")).toBeNull();
});

test("a share link explains what to paste instead", async () => {
  window.history.pushState(null, "", "/marketing?new=reddit");
  mockApi({
    "GET /auth/me": me,
    ...lists(),
    "POST /threads/resolve": [
      200,
      {
        ...newPost("reddit", "Reddit", "", ""),
        parsed: null,
        error: "This is a share link. Open it and copy the full address from the browser bar.",
      },
    ],
  });
  render(<App />);

  await userEvent.type(
    await screen.findByLabelText("Post code or link"),
    "https://www.reddit.com/r/x/s/abc",
  );
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(await screen.findByText(/This is a share link/)).toBeVisible();
});

test("a known post's code in the finder opens it, ready for their reply", async () => {
  mockApi({
    "GET /auth/me": me,
    ...lists(),
    "POST /threads/resolve": [
      200,
      {
        found: true,
        parsed: null,
        thread: { ...row, created_by: { id: "u9", name: "Ali" } },
        matched_message_id: "m2",
        reopened: false,
        error: null,
      },
    ],
    "GET /threads/reddit%3A1abc2de": [200, detail([question, draftMsg("posted")])],
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Find by post code or link"), "1abc2de{enter}");

  expect(await screen.findByText(/Ali started this conversation on/)).toBeVisible();
  expect(screen.getByLabelText("Paste their new reply")).toHaveFocus();
  expect(screen.getByLabelText("Replying to")).toHaveValue("m2");
});

test("a draft being checked can't be copied", async () => {
  window.history.pushState(null, "", "/marketing?thread=reddit%3A1abc2de");
  mockApi({
    "GET /auth/me": me,
    ...lists(),
    "GET /threads/reddit%3A1abc2de": [200, detail([question, draftMsg("in_review")])],
  });
  render(<App />);

  const copy = await screen.findByRole("button", { name: "Waiting for review – don't post yet" });
  expect(copy).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Mark as posted" })).toBeNull();
  expect(screen.getByText("Being checked by our team")).toBeVisible();
});

test("mark as posted, then send their reply: it lands under ours and is drafted", async () => {
  window.history.pushState(null, "", "/marketing?thread=reddit%3A1abc2de");
  const posted = draftMsg("posted");
  const theirs: ThreadMessage = {
    ...question,
    id: "m3",
    parent_id: "m2",
    body: "And video?",
    created_at: "2026-10-21T10:00:00Z",
  };
  const followUp: ThreadMessage = {
    ...draftMsg("ready"),
    id: "m4",
    parent_id: "m3",
    body: "Video is often quicker.",
    created_at: "2026-10-21T10:01:00Z",
  };
  const calls = mockApi({
    "GET /auth/me": me,
    ...lists(),
    "GET /threads/reddit%3A1abc2de": [200, detail([question, draftMsg("ready")])],
    "POST /thread-messages/m2/posted": [
      200,
      detail([question, posted], { status: "waiting_for_them" }),
    ],
    "POST /threads/reddit%3A1abc2de/replies": [200, detail([question, posted, theirs])],
    "POST /threads/reddit%3A1abc2de/draft": [200, detail([question, posted, theirs, followUp])],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Mark as posted" }));
  await userEvent.type(
    screen.getByLabelText("Link to our posted comment (optional)"),
    `${URL}kx9z0p1/`,
  );
  await userEvent.click(screen.getByRole("button", { name: "Save as posted" }));
  expect(await screen.findByText(/Posted by Sara/)).toBeVisible();

  expect(screen.getByLabelText("Replying to")).toHaveValue(""); // our latest posted reply
  await userEvent.type(screen.getByLabelText("Paste their new reply"), "And video?");
  await userEvent.click(screen.getByRole("button", { name: "Send and draft" }));

  expect(await screen.findByText("Video is often quicker.")).toBeVisible();
  expect(calls.find((c) => c.path.endsWith("/replies"))?.body).toEqual({
    body: "And video?",
    parent_id: "m2",
  });
  expect(calls.find((c) => c.path.endsWith("/draft"))?.body).toEqual({ parent_id: "m3" });
  expect(calls.find((c) => c.path === "/thread-messages/m2/posted")?.body).toEqual({
    url: `${URL}kx9z0p1/`,
  });
  expect(screen.getByLabelText("Paste their new reply")).toHaveValue("");
});

test("redraft with an instruction", async () => {
  window.history.pushState(null, "", "/marketing?thread=reddit%3A1abc2de");
  const calls = mockApi({
    "GET /auth/me": me,
    ...lists(),
    "GET /threads/reddit%3A1abc2de": [200, detail([question, draftMsg("ready")])],
    "POST /threads/reddit%3A1abc2de/draft": [
      200,
      detail([question, { ...draftMsg("ready"), id: "m5", body: "Shorter: 1-2 weeks." }]),
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Redraft…" }));
  await userEvent.type(screen.getByLabelText("Instruction for a new draft"), "shorter");
  await userEvent.click(screen.getByRole("button", { name: "Redraft" }));

  expect(await screen.findByText("Shorter: 1-2 weeks.")).toBeVisible();
  expect(calls.find((c) => c.path.endsWith("/draft"))?.body).toEqual({
    parent_id: "m1",
    instruction: "shorter",
  });
});

test("a reply corrected after posting offers the new text", async () => {
  window.history.pushState(null, "", "/marketing?thread=reddit%3A1abc2de");
  const posted = draftMsg("posted");
  mockApi({
    "GET /auth/me": me,
    ...lists(),
    "GET /threads/reddit%3A1abc2de": [
      200,
      detail([
        question,
        { ...posted, draft: { ...posted.draft!, corrected_after_post: "2-3 weeks now." } },
      ]),
    ],
  });
  render(<App />);

  expect(await screen.findByText(/corrected after posting/)).toBeVisible();
  expect(screen.getByText("2-3 weeks now.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Copy the corrected reply" })).toBeVisible();
});
