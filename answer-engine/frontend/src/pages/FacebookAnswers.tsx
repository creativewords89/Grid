import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  type FbComment,
  type FbItem,
  type FbPost,
  type FbStatus,
  type FbThreadDetail,
  type FbThreadList,
  type FbThreadRow,
} from "../api";
import { Alert } from "../components/ui";

// Facebook answers (SPEC section 6.9a, step 27): answer the group's questions one thread at a
// time. Each selected comment is its own answer (never merged); approving a thread turns its
// answers into verified answers.

type Filter = FbStatus | "all";
const STATUS_LABEL: Record<FbStatus, string> = {
  todo: "To do",
  draft: "Draft",
  approved: "Approved",
  skipped: "Skipped",
};
const CHIPS: [Filter, string][] = [
  ["todo", "To do"],
  ["draft", "Drafts"],
  ["approved", "Approved"],
  ["skipped", "Skipped"],
  ["all", "All"],
];
const KIND: Record<string, string> = { e: "Experience", t: "Technical", p: "Opinion" };

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The comment at "3.1" (the 4th comment's 2nd reply) of a post. */
function commentAt(post: FbPost, path: string): FbComment | null {
  let level = post.comments;
  let found: FbComment | null = null;
  for (const part of path.split(".")) {
    found = level[Number(part)] ?? null;
    if (!found) return null;
    level = found[2] ?? [];
  }
  return found;
}

function countAll(c: FbComment): number {
  return (c[2] ?? []).reduce((n, r) => n + 1 + countAll(r), 0);
}

export function FacebookAnswers() {
  const [list, setList] = useState<FbThreadList | null>(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState("");
  const [sub, setSub] = useState("");
  const [filter, setFilter] = useState<Filter>("todo");

  const reload = useCallback(() => {
    api
      .fbThreads()
      .then((data) => (setList(data), setError("")))
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, []);
  useEffect(reload, [reload]);

  const base = useMemo(() => {
    const words = q.trim().toLowerCase();
    return (list?.items ?? []).filter(
      (t) =>
        (!topic || t.topic === topic) &&
        (!sub || t.subtopic === sub) &&
        (!words ||
          t.title.toLowerCase().includes(words) ||
          t.rows.some((r) => String(r) === words)),
    );
  }, [list, q, topic, sub]);
  const view = filter === "all" ? base : base.filter((t) => t.status === filter);
  const topics = useMemo(
    () => [...new Set((list?.items ?? []).map((t) => t.topic))].filter(Boolean).sort(),
    [list],
  );
  const subtopics = useMemo(
    () =>
      [...new Set((list?.items ?? []).filter((t) => t.topic === topic).map((t) => t.subtopic))]
        .filter(Boolean)
        .sort(),
    [list, topic],
  );
  const tagLabel = (name: string, rows: FbThreadRow[]) => {
    const left = rows.filter((t) => t.status === "todo" || t.status === "draft").length;
    return left === 0
      ? `✓ ${name} — complete`
      : `${name} — ${rows.length - left} of ${rows.length} done`;
  };

  // The chosen thread stays open after saving, even when it leaves the filtered list.
  const shownId = openId ?? view[0]?.id ?? null;

  const onSaved = (row: FbThreadRow) => {
    setOpenId(row.id); // stays open even if it leaves the filtered list
    updateRow(row);
  };
  const updateRow = (row: FbThreadRow) =>
    setList((old) =>
      old
        ? {
            ...old,
            items: old.items.map((t) => (t.id === row.id ? { ...t, ...row } : t)),
            counts: old.items
              .map((t) => (t.id === row.id ? row.status : t.status))
              .reduce((acc, s) => ({ ...acc, [s]: acc[s] + 1 }), {
                todo: 0,
                draft: 0,
                approved: 0,
                skipped: 0,
              } as Record<FbStatus, number>),
          }
        : old,
    );

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!list) return <p className="loading">Loading…</p>;
  if (!list.items.length)
    return (
      <section className="page">
        <h1>Facebook answers</h1>
        {list.can_load ? (
          <LoadFile onLoaded={reload} />
        ) : (
          <p className="muted">
            Nothing to answer yet. An Owner loads the Facebook data file first.
          </p>
        )}
      </section>
    );

  const total = list.items.length;
  const done = list.counts.approved + list.counts.skipped;
  return (
    <div className="fb-page">
      <aside className="fb-list" aria-label="Threads">
        <div className="fb-head">
          <strong>Facebook answers</strong>
          <span className="muted small">
            {list.counts.approved} approved · {list.counts.draft} drafts · {list.counts.skipped}{" "}
            skipped · {total - done - list.counts.draft} to do
          </span>
          <div className="fb-bar" aria-hidden="true">
            <i style={{ width: `${(list.counts.approved / total) * 100}%` }} />
          </div>
        </div>
        <input
          type="search"
          className="input"
          placeholder="Search questions or a row number"
          aria-label="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="input"
          aria-label="Topic"
          value={topic}
          onChange={(e) => (setTopic(e.target.value), setSub(""))}
        >
          <option value="">All topics</option>
          {topics.map((t) => (
            <option key={t} value={t}>
              {tagLabel(
                t,
                list.items.filter((x) => x.topic === t),
              )}
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label="Subtopic"
          value={sub}
          disabled={!topic}
          onChange={(e) => setSub(e.target.value)}
        >
          <option value="">All subtopics</option>
          {subtopics.map((s) => (
            <option key={s} value={s}>
              {tagLabel(
                s,
                list.items.filter((x) => x.topic === topic && x.subtopic === s),
              )}
            </option>
          ))}
        </select>
        <div className="fb-chips" role="group" aria-label="Status">
          {CHIPS.map(([key, label]) => (
            <button
              key={key}
              className="fb-chip"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label} {key === "all" ? base.length : base.filter((t) => t.status === key).length}
            </button>
          ))}
        </div>
        <ul className="fb-threads">
          {view.map((t) => (
            <li key={t.id}>
              <button aria-current={t.id === shownId} onClick={() => setOpenId(t.id)}>
                <span className={`fb-dot fb-dot-${t.status}`} aria-label={STATUS_LABEL[t.status]} />
                <span className="fb-t">{t.title}</span>
                <span className="muted small">
                  Row {t.rows.join(", ")} · {plural(t.talk, "comment")} · {t.subtopic || t.topic}
                </span>
              </button>
            </li>
          ))}
          {!view.length && <li className="muted small">Nothing matches these filters.</li>}
        </ul>
      </aside>
      {shownId ? (
        <Thread key={shownId} id={shownId} onSaved={onSaved} />
      ) : (
        <p className="muted">Choose a thread.</p>
      )}
    </div>
  );
}

function LoadFile({ onLoaded }: { onLoaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  async function upload(file: File) {
    setError("");
    setProgress(0);
    try {
      await api.fbLoad(file, setProgress);
      onLoaded();
    } catch (err) {
      setError(message(err, "Not loaded."));
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div className="card stack">
      <p>
        Load the Facebook data file (facebook-data.json) to start. Answers already saved in it come
        too.
      </p>
      <input
        ref={input}
        type="file"
        accept=".json"
        className="sr-only"
        id="fb-load"
        aria-label="Facebook data file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <button
        className="button button-primary"
        disabled={progress !== null}
        onClick={() => input.current?.click()}
      >
        {progress !== null ? `Loading… ${progress}%` : "Load the data file"}
      </button>
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  );
}

type Undo = { index: number; text: string } | null;

function Thread({ id, onSaved }: { id: string; onSaved: (row: FbThreadRow) => void }) {
  const [t, setT] = useState<FbThreadDetail | null>(null);
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<FbItem[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(
    null,
  );
  const [undo, setUndo] = useState<Undo>(null);

  const apply = (data: FbThreadDetail) => {
    setT(data);
    setTitle(data.answer.title);
    setItems(data.answer.items);
  };
  useEffect(() => {
    api
      .fbThread(id)
      .then((data) => (apply(data), setShowAll(!data.posts.some((p) => p.picked.length))))
      .catch((err: unknown) => setNote({ kind: "error", text: message(err, "Not loaded.") }));
  }, [id]);

  const dirty =
    t !== null &&
    (title !== t.answer.title || JSON.stringify(items) !== JSON.stringify(t.answer.items));
  const byRow = useMemo(() => new Map((t?.posts ?? []).map((p) => [p.row, p])), [t]);
  const textOf = (key: string) => {
    const [rowText = "", path = ""] = key.split(":");
    const row = Number(rowText);
    const post = byRow.get(row);
    const c = post ? commentAt(post, path) : null;
    return c ? { name: c[0], text: c[1], row } : null;
  };
  const selected = new Set(items.flatMap((i) => i.picks));

  function toggle(key: string, text: string) {
    setUndo(null);
    const at = items.findIndex((i) => i.picks.length === 1 && i.picks[0] === key);
    setItems(
      at >= 0 ? items.filter((_, i) => i !== at) : [...items, { label: "", picks: [key], text }],
    );
  }
  const change = (index: number, patch: Partial<FbItem>) =>
    setItems(items.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  async function save(status: "draft" | "approved" | "skipped") {
    setNote(null);
    setBusy(true);
    try {
      const data = await api.fbSave(id, { title, items, status });
      apply(data);
      onSaved(data);
      setUndo(null);
      setNote({
        kind: "success",
        text:
          status === "approved"
            ? `Approved: ${plural(data.answer.items.filter((i) => i.text).length, "verified answer")} searchable within seconds.`
            : status === "draft"
              ? "Saved as a draft."
              : "Skipped.",
      });
    } catch (err) {
      setNote({ kind: "error", text: message(err, "Not saved.") });
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    setBusy(true);
    try {
      const data = await api.fbClear(id);
      apply(data);
      onSaved(data);
      setNote({ kind: "info", text: "Cleared." });
    } catch (err) {
      setNote({ kind: "error", text: message(err, "Not cleared.") });
    } finally {
      setBusy(false);
    }
  }
  async function rework(index: number, mode: "polish" | "fit") {
    const item = items[index];
    if (!item?.text.trim()) return;
    setBusy(true);
    setNote({
      kind: "info",
      text:
        mode === "fit"
          ? "Claude is fitting the answer to this post…"
          : "Claude is polishing the answer…",
    });
    try {
      const out = await api.fbRework(id, { mode, text: item.text, label: item.label, instruction });
      if (out.answer.replace(/\s+/g, " ") === item.text.trim().replace(/\s+/g, " ")) {
        setNote({ kind: "info", text: "It already fits this post. Nothing was changed." });
        return;
      }
      setUndo({ index, text: item.text });
      change(index, { text: out.answer });
      setNote({
        kind: "success",
        text:
          (mode === "fit" ? "Fitted to this post." : "Polished.") +
          (out.changes.length ? ` Changed: ${out.changes.join("; ")}.` : "") +
          " Check it, then approve.",
      });
    } catch (err) {
      setNote({ kind: "error", text: message(err, "That didn't work. Try again.") });
    } finally {
      setBusy(false);
    }
  }
  function reuse(fromItems: FbItem[], picksOnly: boolean) {
    setUndo(null);
    if (picksOnly) {
      const have = new Set(items.flatMap((i) => i.picks));
      const add = [...new Set(fromItems.flatMap((i) => i.picks))]
        .filter((k) => !have.has(k))
        .map((k) => ({ label: "", picks: [k], text: textOf(k)?.text ?? "" }))
        .filter((i) => i.text);
      setItems([...items, ...add]);
      return;
    }
    const have = new Set(items.map((i) => i.text.trim()));
    setItems([
      ...items,
      ...fromItems
        .filter((i) => i.text.trim() && !have.has(i.text.trim()))
        .map((i) => ({ ...i, picks: [] })),
    ]);
  }

  if (!t)
    return note ? <Alert kind={note.kind}>{note.text}</Alert> : <p className="loading">Loading…</p>;
  const multi = items.length > 1;
  const pickNo = (post: FbPost) => new Map(post.picked.map(([p], i) => [p, i]));
  const kindOf = (post: FbPost) => new Map(post.picked.map(([p, k]) => [p, k]));

  return (
    <>
      <main className="fb-thread">
        <p className="fb-crumbs">
          {[t.topic, t.subtopic].filter(Boolean).join(" › ")}
          {t.noise && <span className="tag tag-warn">Probably not a question</span>}
        </p>
        <h1>{t.answer.title}</h1>
        <h2 className="fb-h">Facebook thread</h2>
        <div className="fb-grid" data-n={Math.min(t.posts.length, 3)}>
          {t.posts.map((p) => (
            <PostCard key={p.row} post={p} />
          ))}
        </div>
        {t.similar.length > 0 && (
          <>
            <h2 className="fb-h">Similar threads ({t.similar.length})</h2>
            <div className="fb-similar">
              {t.similar.map((s) => (
                <article key={s.id} className={`card fb-sim fb-sim-${s.status}`}>
                  <strong>{s.title}</strong>
                  <span className="muted small">
                    Row {s.rows.join(", ")} · {STATUS_LABEL[s.status]}
                  </span>
                  {s.items
                    .filter((i) => i.text)
                    .map((i, n) => (
                      <p key={n} className="fb-sim-ans">
                        {i.label && <b>{i.label}: </b>}
                        {i.text}
                      </p>
                    ))}
                  {s.items.some((i) => i.text) && (
                    <div className="row">
                      <button className="button button-small" onClick={() => reuse(s.items, false)}>
                        Use{" "}
                        {s.items.filter((i) => i.text).length > 1 ? "these answers" : "this answer"}
                      </button>
                      {s.items.some((i) => i.picks.length) && (
                        <button
                          className="button button-small"
                          onClick={() => reuse(s.items, true)}
                        >
                          Use its selected comments
                        </button>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </>
        )}
        <div className="fb-h fb-h-row">
          <h2 className="fb-h">{showAll ? "All comments, as on Facebook" : "Picked answers"}</h2>
          <button className="button button-small" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show picked only" : "Show all comments"}
          </button>
        </div>
        <div className="fb-grid fb-comments">
          {t.posts.flatMap((p) => {
            const picks = pickNo(p);
            const kinds = kindOf(p);
            const tops: [string, FbComment][] =
              !showAll && p.picked.length
                ? p.picked
                    .map(([path]) => [path, commentAt(p, path)] as [string, FbComment | null])
                    .filter((x): x is [string, FbComment] => x[1] !== null)
                : p.comments.map((c, i) => [String(i), c]);
            return tops.map(([path, c]) => {
              const n = picks.get(path);
              return (
                <article
                  key={`${p.row}:${path}`}
                  className={`card fb-cmt${n !== undefined ? " fb-picked" : ""}`}
                >
                  <div className="muted small fb-meta">
                    <a href={p.url} target="_blank" rel="noopener noreferrer">
                      Row {p.row} ↗
                    </a>
                    {n !== undefined && n < p.pinned && <span className="tag">Pinned</span>}
                    {n !== undefined && <span>Pick {n + 1}</span>}
                    {countAll(c) > 0 && (
                      <span>thread with {plural(countAll(c), "reply", "replies")}</span>
                    )}
                    {kinds.get(path) && <span className="tag">{KIND[kinds.get(path) ?? ""]}</span>}
                  </div>
                  <CommentNode
                    post={p}
                    comment={c}
                    path={path}
                    depth={0}
                    selected={selected}
                    onToggle={toggle}
                  />
                </article>
              );
            });
          })}
          {t.posts.every((p) => !p.comments.length) && (
            <p className="muted">Nobody replied on Facebook. Write your own answer, or skip it.</p>
          )}
        </div>
      </main>

      <section className="fb-answer" aria-label="Your answer">
        <div className="row fb-between">
          <h2>Your answer</h2>
          <span className={`fb-state fb-state-${t.answer.status}`}>
            {STATUS_LABEL[t.answer.status]}
          </span>
        </div>
        {note && <Alert kind={note.kind}>{note.text}</Alert>}
        <label htmlFor="fb-title">Question, as it goes into the knowledge base</label>
        <input
          id="fb-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <h3>
          Answers{" "}
          <span className="muted small">{items.length ? plural(items.length, "answer") : ""}</span>
        </h3>
        {!items.length && (
          <p className="muted small">
            Click <b>Select</b> on a comment to add it as an answer. Select two and you get two
            answers, kept separate.
          </p>
        )}
        {items.map((it, i) => {
          const src = it.picks.length === 1 ? textOf(it.picks[0] ?? "") : null;
          const edited = src !== null && it.text !== src.text;
          return (
            <div key={i} className="fb-item">
              <div className="row fb-between">
                <span className="small">
                  <b>{multi ? `Answer ${i + 1}` : "Answer"}</b>
                  {src ? ` · from ${src.name || "a comment"}, row ${src.row}` : " · your own"}
                  {edited && <span className="tag tag-warn">Edited</span>}
                </span>
                <span className="row">
                  <button
                    className="button button-small"
                    disabled={busy}
                    title="Keep this answer, but adjust it to this post's industry and situation"
                    onClick={() => void rework(i, "fit")}
                  >
                    Fit to post
                  </button>
                  <button
                    className="button button-small"
                    disabled={busy}
                    onClick={() => void rework(i, "polish")}
                  >
                    Polish
                  </button>
                  {edited && (
                    <button
                      className="button button-small"
                      onClick={() => change(i, { text: src.text })}
                    >
                      Reset
                    </button>
                  )}
                  <button
                    className="button button-small"
                    onClick={() => (setUndo(null), setItems(items.filter((_, n) => n !== i)))}
                  >
                    Remove
                  </button>
                </span>
              </div>
              {multi && (
                <input
                  className="input"
                  aria-label={`When answer ${i + 1} applies`}
                  placeholder="When this answer applies (optional), e.g. If you have a storefront"
                  value={it.label}
                  onChange={(e) => change(i, { label: e.target.value })}
                />
              )}
              <textarea
                className="textarea"
                aria-label={multi ? `Answer ${i + 1}` : "Answer"}
                rows={6}
                value={it.text}
                onChange={(e) => change(i, { text: e.target.value })}
              />
            </div>
          );
        })}
        <button
          className="button button-small"
          onClick={() => setItems([...items, { label: "", picks: [], text: "" }])}
        >
          + Write your own answer
        </button>
        <input
          className="input"
          aria-label="Instruction for Claude"
          placeholder="Optional instruction for Polish or Fit, e.g. shorter"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
        {undo && (
          <button
            className="button button-small"
            onClick={() => (change(undo.index, { text: undo.text }), setUndo(null))}
          >
            Undo the last change by Claude
          </button>
        )}
        <p className="muted small">{dirty ? "Unsaved changes" : ""}</p>
        <div className="row">
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() => void save("approved")}
          >
            Approve
          </button>
          <button className="button" disabled={busy} onClick={() => void save("draft")}>
            Save draft
          </button>
          <button className="button" disabled={busy} onClick={() => void save("skipped")}>
            Skip
          </button>
          <button className="button" disabled={busy} onClick={() => void clear()}>
            Clear
          </button>
        </div>
      </section>
    </>
  );
}

function PostCard({ post }: { post: FbPost }) {
  const [more, setMore] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = post.question.length > 320 || post.question.split("\n").length > 6;
  return (
    <article className="card fb-post">
      <div className="muted small fb-meta">
        <a href={post.url} target="_blank" rel="noopener noreferrer">
          Row {post.row} ↗
        </a>
        {post.author && <span>asked by {post.author}</span>}
        <button
          className="button button-small fb-copy"
          onClick={() =>
            void navigator.clipboard
              .writeText(post.question)
              .then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))
              .catch(() => setMore(true))
          }
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <p className={`fb-q${long && !more ? " fb-clamp" : ""}`}>{post.question}</p>
      {long && (
        <button className="link-button" onClick={() => setMore(!more)}>
          {more ? "Show less" : "Show more"}
        </button>
      )}
    </article>
  );
}

function CommentNode({
  post,
  comment,
  path,
  depth,
  selected,
  onToggle,
}: {
  post: FbPost;
  comment: FbComment;
  path: string;
  depth: number;
  selected: Set<string>;
  onToggle: (key: string, text: string) => void;
}) {
  const key = `${post.row}:${path}`;
  const on = selected.has(key);
  const [name, text, replies] = comment;
  return (
    <div className={`${depth ? "fb-rep" : "fb-body"}${on ? " fb-used" : ""}`}>
      <div className="fb-who">
        <b>{name || "Name not captured"}</b>
        {post.author && name === post.author && <span className="tag">Asked the question</span>}
        {text && (
          <button
            className={`button button-small fb-sel${on ? " button-primary" : ""}`}
            aria-pressed={on}
            onClick={() => onToggle(key, text)}
          >
            {on ? "Selected ✓" : "Select"}
          </button>
        )}
      </div>
      <p className={text ? "fb-text" : "fb-text muted"}>
        {text || "No text (an image, sticker or link only)."}
      </p>
      {(replies ?? []).map((r, i) => (
        <CommentNode
          key={i}
          post={post}
          comment={r}
          path={`${path}.${i}`}
          depth={depth + 1}
          selected={selected}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}
