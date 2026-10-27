import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  ApiError,
  type Resolved,
  type ThreadDetail,
  type ThreadList,
  type ThreadMessage,
  type ThreadStatus,
} from "../api";
import { useAuth } from "../auth";
import { Alert, Confirm } from "../components/ui";
import { ago, formatDate } from "../format";
import { THREAD_STATUSES } from "../labels";
import { navigate, useSearch } from "../router";

// Marketing (SPEC sections 6.10 and 7.3). Reddit and Facebook threads are found by the
// post's link or code. The engine drafts; a person always posts.

const STATUS_NAME = Object.fromEntries(THREAD_STATUSES) as Record<ThreadStatus, string>;

function openThread(id: string, replyTo?: string | null, reply?: Prefill) {
  const q = new URLSearchParams({ thread: id });
  if (replyTo) q.set("reply_to", replyTo);
  prefill = reply ?? null;
  navigate(`/marketing?${q.toString()}`);
}

// What the "Add their reply" form starts with when a finder box just opened the thread.
type Prefill = { author: string; body: string };
let prefill: Prefill | null = null;
function takePrefill(): Prefill | null {
  const value = prefill;
  prefill = null;
  return value;
}

export function Marketing() {
  const query = new URLSearchParams(useSearch());
  const threadId = query.get("thread");
  return (
    <section className="page">
      {threadId ? (
        <ThreadView key={threadId} id={threadId} replyTo={query.get("reply_to")} />
      ) : (
        <Threads />
      )}
    </section>
  );
}

// --- the list and the URL box --------------------------------------------------------------------

function Threads() {
  const [status, setStatus] = useState<ThreadStatus>("waiting_for_us");
  const [platform, setPlatform] = useState("");
  const [community, setCommunity] = useState("");
  const [mine, setMine] = useState(false);
  const [data, setData] = useState<ThreadList | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    api
      .listThreads({ status, platform, community: community.trim(), mine })
      .then((list) => current && (setData(list), setError("")))
      .catch(
        (err: unknown) =>
          current && setError(err instanceof ApiError ? err.message : "Not loaded."),
      );
    return () => {
      current = false;
    };
  }, [status, platform, community, mine]);

  return (
    <>
      <div className="page-head">
        <h1>Marketing</h1>
      </div>
      <FindBox />
      <div className="tabs" role="tablist">
        {THREAD_STATUSES.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={status === key}
            onClick={() => setStatus(key)}
          >
            {label}
            {data && ` (${data.counts[key] ?? 0})`}
          </button>
        ))}
      </div>
      <div className="filters">
        <select
          aria-label="Platform"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
        >
          <option value="">All platforms</option>
          <option value="reddit">Reddit</option>
          <option value="facebook">Facebook</option>
        </select>
        <input
          className="input"
          aria-label="Community"
          placeholder="Community, e.g. r/localseo"
          value={community}
          onChange={(e) => setCommunity(e.target.value)}
        />
        <label className="inline">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Mine only
        </label>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {data && data.items.length === 0 && <p className="muted">No threads here.</p>}
      {data && data.items.length > 0 && (
        <ul className="review-list">
          {data.items.map((t) => (
            <li key={t.id} className="card thread-row">
              <button className="review-row" onClick={() => openThread(t.id)}>
                <span className={`platform-badge platform-${t.platform}`}>{t.platform_name}</span>
                <span className="review-main">
                  <strong>{t.title}</strong>
                  <span className="muted small">
                    {t.person ? `${t.person} · ` : ""}
                    {t.community ? `${t.community} · ` : ""}
                    {ago(t.last_activity_at)}
                    {t.posted_by.length > 0 &&
                      ` · posted by ${t.posted_by.map((p) => p.name).join(", ")}`}
                  </span>
                </span>
              </button>
              {t.original_url && (
                <a
                  className="small"
                  href={t.original_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open on {t.platform_name}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// Paste the post's link or its code, for Reddit and Facebook alike (SPEC 6.10).
function FindBox() {
  const { user } = useAuth();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState<Resolved | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError("");
    setFresh(null);
    try {
      const found = await api.resolveThread(url.trim());
      if (found.error) setError(found.error);
      else if (found.found && found.thread) {
        const by = found.thread.created_by;
        const note =
          by && by.id !== user?.id
            ? `${by.name} started this thread on ${formatDate(found.thread.created_at)}.`
            : found.reopened
              ? "This thread was closed; it's open again."
              : "";
        if (note) setFlash(note);
        // Opened to add their latest message: the reply form is ready.
        openThread(found.thread.id, found.matched_message_id, { author: "", body: "" });
      } else setFresh(found);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack url-box">
      <form className="row" onSubmit={submit}>
        <label className="sr-only" htmlFor="thread-url">
          Paste a Reddit or Facebook link or the post's code
        </label>
        <input
          id="thread-url"
          className="input grow"
          placeholder="Paste a Reddit or Facebook link, or the post's code"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="button button-primary" disabled={busy || !url.trim()}>
          {busy ? "Checking…" : "Go"}
        </button>
      </form>
      {error && <Alert kind="error">{error}</Alert>}
      {fresh?.parsed && (
        <NewThread url={url.trim()} found={fresh} onCancel={() => setFresh(null)} />
      )}
    </div>
  );
}

/** Create a thread and draft straight away: that's what the person came for. */
async function createAndDraft(body: Parameters<typeof api.createThread>[0]): Promise<void> {
  const thread = await api.createThread(body);
  try {
    await api.draftReply(thread.id, thread.messages[0]!.id);
  } catch (err) {
    setFlash(
      err instanceof ApiError ? `The draft didn't work: ${err.message}` : "The draft didn't work.",
    );
  }
  openThread(thread.id);
}

// A one-time note shown at the top of the thread the URL box just opened.
let flash = "";
function setFlash(note: string) {
  flash = note;
}
function takeFlash(): string {
  const note = flash;
  flash = "";
  return note;
}

function NewThread({
  url,
  found,
  onCancel,
}: {
  url: string;
  found: Resolved;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [author, setAuthor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parsed = found.parsed!;
  const facebook = parsed.platform === "facebook";

  async function create() {
    setBusy(true);
    setError("");
    try {
      await createAndDraft({
        url,
        question,
        title: title.trim() || undefined,
        author_name: author.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <p>
        <strong>New thread</strong> · {parsed.platform_name}
        {parsed.community && ` · ${parsed.community}`}
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      <label htmlFor="nt-question">Their question</label>
      <textarea
        id="nt-question"
        className="textarea"
        rows={5}
        required
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
      />
      <div className="row">
        <div className="grow">
          <label htmlFor="nt-title">Title (optional)</label>
          <input
            id="nt-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="grow">
          <label htmlFor="nt-author">
            {facebook ? "Their name (optional)" : "Their username (optional)"}
          </label>
          <input
            id="nt-author"
            className="input"
            placeholder={facebook ? "Dan Miller" : "u/john_smb"}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>
      </div>
      <div className="row">
        <button className="button button-primary" disabled={busy || !question.trim()}>
          {busy ? "Drafting…" : "Draft reply"}
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- one thread ---------------------------------------------------------------------------------------

function ThreadView({ id, replyTo }: { id: string; replyTo: string | null }) {
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [note] = useState(takeFlash);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    api
      .getThread(id)
      .then(setThread)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [id]);
  useEffect(load, [load]);

  async function run(key: string, call: () => Promise<ThreadDetail | void>) {
    setBusy(key);
    setError("");
    try {
      const next = await call();
      if (next) setThread(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  if (!thread) {
    return (
      <>
        <button className="link-button" onClick={() => navigate("/marketing")}>
          ← Marketing
        </button>
        {error && <Alert kind="error">{error}</Alert>}
      </>
    );
  }
  const children = (parent: string | null) => thread.messages.filter((m) => m.parent_id === parent);
  const closed = thread.status === "closed";

  const tree = (message: ThreadMessage, depth: number): ReactNode => (
    <div key={message.id} className={`tree-node depth-${Math.min(depth, 4)}`}>
      <Message
        message={message}
        thread={thread}
        busy={busy}
        closed={closed}
        onRun={run}
        onChanged={load}
      />
      {children(message.id).map((c) => tree(c, depth + 1))}
    </div>
  );

  return (
    <>
      <button className="link-button" onClick={() => navigate("/marketing")}>
        ← Marketing
      </button>
      {note && <Alert kind="info">{note}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      <div className="thread-head">
        <h1>{thread.title}</h1>
        <p className="muted">
          <span className={`platform-badge platform-${thread.platform}`}>
            {thread.platform_name}
          </span>{" "}
          {thread.community && `${thread.community} · `}
          <span className={`pill pill-thread-${thread.status}`}>{STATUS_NAME[thread.status]}</span>
          {thread.person && ` · ${thread.person}`}
          {thread.created_by && ` · started by ${thread.created_by.name} ${ago(thread.created_at)}`}
          {thread.original_url && (
            <>
              {" "}
              ·{" "}
              <a href={thread.original_url} target="_blank" rel="noopener noreferrer">
                Open on {thread.platform_name}
              </a>
            </>
          )}
        </p>
        <div className="row">
          {thread.can_close &&
            (closed ? (
              <button
                className="button button-small"
                onClick={() => void run("reopen", () => api.reopenThread(id))}
              >
                Reopen
              </button>
            ) : (
              <button
                className="button button-small"
                onClick={() => void run("close", () => api.closeThread(id))}
              >
                Close
              </button>
            ))}
          {thread.can_delete && (
            <button className="button button-small button-danger" onClick={() => setDeleting(true)}>
              Delete
            </button>
          )}
        </div>
      </div>
      <div className="thread-tree">{children(null).map((m) => tree(m, 0))}</div>
      <AddReply thread={thread} replyTo={replyTo} onAdded={setThread} />
      {deleting && (
        <Confirm
          title="Delete this thread?"
          message="It goes to the trash for 30 days. Drafts waiting for review are withdrawn."
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void api.deleteThread(id).then(() => navigate("/marketing"));
          }}
        />
      )}
    </>
  );
}

function Message({
  message,
  thread,
  busy,
  closed,
  onRun,
  onChanged,
}: {
  message: ThreadMessage;
  thread: ThreadDetail;
  busy: string | null;
  closed: boolean;
  onRun: (key: string, call: () => Promise<ThreadDetail | void>) => Promise<void>;
  onChanged: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const when = message.posted_at ?? message.created_at;

  if (message.author === "them") {
    // Answered already (a draft, or our posted reply): drafting starts from the newest message.
    const hasDraft = thread.messages.some((m) => m.parent_id === message.id && m.author === "us");
    return (
      <div className="bubble bubble-them">
        <div className="muted small">
          {message.author_name ?? "Them"} · {formatDate(message.created_at)}
        </div>
        <div className="pre">{message.body}</div>
        {!closed && !hasDraft && (
          <div className="row draft-ask">
            <input
              className="input grow"
              aria-label="Instruction for the draft (optional)"
              placeholder="Optional: e.g. shorter, mention the free audit"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <button
              className="button button-small button-primary"
              disabled={busy !== null}
              onClick={() =>
                void onRun(`draft-${message.id}`, () =>
                  api.draftReply(thread.id, message.id, instruction.trim() || undefined),
                )
              }
            >
              {busy === `draft-${message.id}` ? "Drafting…" : "Draft reply"}
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <OurReply
      message={message}
      thread={thread}
      busy={busy}
      closed={closed}
      onRun={onRun}
      onChanged={onChanged}
      when={when}
    />
  );
}

function OurReply({
  message,
  thread,
  busy,
  closed,
  onRun,
  onChanged,
  when,
}: {
  message: ThreadMessage;
  thread: ThreadDetail;
  busy: string | null;
  closed: boolean;
  onRun: (key: string, call: () => Promise<ThreadDetail | void>) => Promise<void>;
  onChanged: () => void;
  when: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.body);
  const [posting, setPosting] = useState(false);
  const [postUrl, setPostUrl] = useState("");
  const [instruction, setInstruction] = useState("");
  const [copied, setCopied] = useState(false);
  const [reply, setReply] = useState("");
  const draft = message.draft;
  const inReview = message.state === "in_review";

  function copy(value: string) {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (message.state === "posted") {
    return (
      <div className="bubble bubble-us">
        <div className="muted small">
          Posted by {message.posted_by?.name ?? "us"} · {formatDate(when)}
          {message.external_url && (
            <>
              {" · "}
              <a href={message.external_url} target="_blank" rel="noopener noreferrer">
                our comment
              </a>
            </>
          )}
        </div>
        <div className="pre">{message.body}</div>
        {draft?.corrected_after_post && (
          <Alert kind="info">
            This reply was corrected after posting — consider editing your comment on{" "}
            {thread.platform_name}:<div className="pre corrected">{draft.corrected_after_post}</div>
            <button
              className="button button-small"
              onClick={() => copy(draft.corrected_after_post!)}
            >
              {copied ? "Copied" : "Copy the corrected reply"}
            </button>
          </Alert>
        )}
      </div>
    );
  }

  return (
    <div className="bubble bubble-us draft">
      <div className="muted small">
        Draft · {message.created_by?.name ?? "us"} · {ago(message.created_at)}
        {inReview && <span className="tag tag-warn">Being checked by our team</span>}
        {message.state === "ready" && <span className="tag tag-ok">Ready to post</span>}
      </div>
      {editing ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(`edit-${message.id}`, () => api.editDraft(message.id, text)).then(() =>
              setEditing(false),
            );
          }}
        >
          <textarea
            className="textarea"
            aria-label="Draft"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row">
            <button className="button button-small button-primary">Save</button>
            <button type="button" className="button button-small" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="pre">{message.body}</div>
      )}
      {draft?.needs_info && (
        <form
          className="needs-info"
          onSubmit={(event) => {
            event.preventDefault();
            void api.needsInfoReply(draft.answer_id, reply.trim()).then(onChanged);
          }}
        >
          <p>
            <strong>❓ {draft.needs_info.asked_by} from our team asks:</strong>{" "}
            {draft.needs_info.question}
          </p>
          <textarea
            aria-label="Your reply"
            rows={2}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <div>
            <button className="button button-small button-primary" disabled={!reply.trim()}>
              Send reply
            </button>
          </div>
        </form>
      )}
      {!editing && !closed && (
        <div className="row draft-tools">
          <button
            className="button button-small button-primary"
            disabled={inReview}
            title={inReview ? "Waiting for review – don't post yet" : undefined}
            onClick={() => copy(message.body)}
          >
            {inReview ? "Waiting for review – don't post yet" : copied ? "Copied" : "Copy"}
          </button>
          <button className="button button-small" onClick={() => setEditing(true)}>
            Edit
          </button>
          {!inReview && (
            <button className="button button-small" onClick={() => setPosting(!posting)}>
              Mark as posted
            </button>
          )}
          <input
            className="input grow"
            aria-label="Instruction for a new draft"
            placeholder="Regenerate: e.g. shorter"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <button
            className="button button-small"
            disabled={busy !== null || !message.parent_id}
            onClick={() =>
              void onRun(`draft-${message.parent_id}`, () =>
                api.draftReply(thread.id, message.parent_id!, instruction.trim() || undefined),
              )
            }
          >
            {busy === `draft-${message.parent_id}` ? "Drafting…" : "Regenerate"}
          </button>
        </div>
      )}
      {posting && (
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(`post-${message.id}`, () =>
              api.markPosted(message.id, postUrl.trim() || undefined),
            ).then(() => setPosting(false));
          }}
        >
          <input
            className="input grow"
            aria-label="Link to our posted comment (optional)"
            placeholder="Link to our posted comment (helps match their replies)"
            value={postUrl}
            onChange={(e) => setPostUrl(e.target.value)}
          />
          <button className="button button-small button-primary">Save as posted</button>
        </form>
      )}
    </div>
  );
}

function AddReply({
  thread,
  replyTo,
  onAdded,
}: {
  thread: ThreadDetail;
  replyTo: string | null;
  onAdded: (thread: ThreadDetail) => void;
}) {
  const latestPosted = [...thread.messages].reverse().find((m) => m.state === "posted");
  const [start] = useState(takePrefill);
  const [parent, setParent] = useState(replyTo ?? latestPosted?.id ?? thread.messages[0]?.id ?? "");
  const [body, setBody] = useState(start?.body ?? "");
  const [author, setAuthor] = useState(start?.author ?? "");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(Boolean(replyTo) || start !== null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      onAdded(
        await api.addReply(thread.id, {
          body,
          parent_id: parent || undefined,
          author_name: author.trim() || undefined,
          url: url.trim() || undefined,
        }),
      );
      setBody("");
      setAuthor("");
      setUrl("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not added.");
    }
  }

  if (!open) {
    return (
      <div>
        <button
          className="button"
          onClick={() => {
            // Default: the comment their link pointed to, else our latest posted reply.
            setParent(replyTo ?? latestPosted?.id ?? thread.messages[0]?.id ?? "");
            setOpen(true);
          }}
        >
          + Add their reply
        </button>
      </div>
    );
  }
  const label = (m: ThreadMessage) =>
    `${m.author === "us" ? "Our reply" : (m.author_name ?? "Their message")}: ${m.body.slice(0, 60)}`;
  return (
    <form className="card stack" onSubmit={submit}>
      <h3>Add their reply</h3>
      {error && <Alert kind="error">{error}</Alert>}
      <label htmlFor="ar-parent">Replying to</label>
      <select id="ar-parent" value={parent} onChange={(e) => setParent(e.target.value)}>
        {thread.messages
          .filter((m) => m.author === "them" || m.state === "posted")
          .map((m) => (
            <option key={m.id} value={m.id}>
              {label(m)}
            </option>
          ))}
      </select>
      <label htmlFor="ar-body">Their reply</label>
      <textarea
        id="ar-body"
        className="textarea"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="row">
        <div className="grow">
          <label htmlFor="ar-author">
            {thread.platform === "facebook" ? "Their name (optional)" : "Their username (optional)"}
          </label>
          <input
            id="ar-author"
            className="input"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>
        <div className="grow">
          <label htmlFor="ar-url">Link to their comment (optional)</label>
          <input
            id="ar-url"
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
      </div>
      <div className="row">
        <button className="button button-primary" disabled={!body.trim()}>
          Add reply
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
