import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type VerifiedDetail,
  type VerifiedImport,
  type VerifiedPage,
  type VerifiedRow,
  type VerifiedTopic,
  type VerifiedVersion,
} from "../api";
import { Markdown } from "../components/Markdown";
import { Alert, Confirm } from "../components/ui";
import { formatDate } from "../format";
import { navigate } from "../router";

// Verified Answers (SPEC sections 6.9 and 7.4).

type Show = "active" | "disabled" | "expired" | "needs_check";

const TABS: [Show, string][] = [
  ["active", "Active"],
  ["disabled", "Disabled"],
  ["expired", "Expired"],
  ["needs_check", "Needs check"],
];

function idFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("id");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

const NO_TOPIC = "No topic";

/** The chosen topic and subtopic; null is "all". "" is "No topic". */
type Pick = { topic: string | null; subtopic: string | null };

export function Verified() {
  const [openId, setOpenId] = useState<string | null>(idFromUrl);
  // Kept here so going back from an answer returns to the same topic.
  const [pick, setPick] = useState<Pick>({ topic: null, subtopic: null });
  const [editOnOpen, setEditOnOpen] = useState(false);
  const open = (id: string | null, edit = false) => {
    setEditOnOpen(edit);
    setOpenId(id);
    navigate(id ? `/verified?id=${id}` : "/verified", true);
  };
  return (
    <section className="page page-wide">
      {openId ? (
        <Detail
          key={openId}
          id={openId}
          startEditing={editOnOpen}
          onBack={() => open(null)}
          onOpen={open}
        />
      ) : (
        <List onOpen={open} pick={pick} onPick={setPick} />
      )}
    </section>
  );
}

/** Rows in groups: by topic, or by subtopic once a topic is chosen. Rows come sorted. */
function groupsOf(rows: VerifiedRow[], bySubtopic: boolean): [string, VerifiedRow[]][] {
  const groups: [string, VerifiedRow[]][] = [];
  for (const row of rows) {
    const name = bySubtopic ? row.subtopic : row.topic;
    const last = groups.at(-1);
    if (last && last[0] === name) last[1].push(row);
    else groups.push([name, [row]]);
  }
  return groups;
}

function TopicNav({
  topics,
  total,
  pick,
  onPick,
}: {
  topics: VerifiedTopic[];
  total: number;
  pick: Pick;
  onPick: (p: Pick) => void;
}) {
  return (
    <nav className="va-topics" aria-label="Topics">
      <button
        className="va-topic"
        aria-current={pick.topic === null}
        onClick={() => onPick({ topic: null, subtopic: null })}
      >
        <span>All topics</span>
        <span className="va-count">{total}</span>
      </button>
      {topics.map((t) => (
        <div key={t.name}>
          <button
            className="va-topic"
            aria-current={pick.topic === t.name && pick.subtopic === null}
            aria-expanded={pick.topic === t.name}
            onClick={() => onPick({ topic: t.name, subtopic: null })}
          >
            <span>{t.name || NO_TOPIC}</span>
            <span className="va-count">{t.count}</span>
          </button>
          {pick.topic === t.name &&
            t.subtopics.length > 1 &&
            t.subtopics.map((sub) => (
              <button
                key={sub.name}
                className="va-topic va-subtopic"
                aria-current={pick.subtopic === sub.name}
                onClick={() => onPick({ topic: t.name, subtopic: sub.name })}
              >
                <span>{sub.name || "Other"}</span>
                <span className="va-count">{sub.count}</span>
              </button>
            ))}
        </div>
      ))}
    </nav>
  );
}

function List({
  onOpen,
  pick,
  onPick,
}: {
  onOpen: (id: string) => void;
  pick: Pick;
  onPick: (p: Pick) => void;
}) {
  const [show, setShow] = useState<Show>("active");
  const [q, setQ] = useState("");
  const [page, setPage] = useState<VerifiedPage | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    api
      .listVerified(show, q.trim())
      .then((data) => current && (setPage(data), setError("")))
      .catch(
        (err: unknown) =>
          current && setError(err instanceof ApiError ? err.message : "Not loaded."),
      );
    return () => {
      current = false;
    };
  }, [show, q, reload]);

  const shown = (page?.items ?? []).filter(
    (row) =>
      (pick.topic === null || row.topic === pick.topic) &&
      (pick.subtopic === null || row.subtopic === pick.subtopic),
  );

  return (
    <>
      <div className="page-head">
        <h1>Verified Answers</h1>
        {page?.can_import && <ImportButton onDone={() => setReload((n) => n + 1)} />}
      </div>
      <p className="muted">
        Answers our team has checked. They are used first when answering, and they win when a
        document says something different.
      </p>
      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={show === key} onClick={() => setShow(key)}>
            {label}
            {page && ` (${page.counts[key]})`}
          </button>
        ))}
      </div>
      <div className="filters">
        <input
          type="search"
          className="input"
          placeholder="Search questions and answers"
          aria-label="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {page && page.items.length === 0 && <p className="muted">Nothing here.</p>}
      {page && page.items.length > 0 && (
        <div className="va-layout">
          <TopicNav topics={page.topics} total={page.items.length} pick={pick} onPick={onPick} />
          <div className="va-groups">
            {groupsOf(shown, pick.topic !== null).map(([name, rows]) => {
              const label = name || (pick.topic === null ? NO_TOPIC : "Other");
              return (
                <section key={name} className="va-group" aria-label={label}>
                  <h2 className="va-group-head">
                    {label}
                    <span className="va-count">{rows.length}</span>
                  </h2>
                  <ul className="review-list">
                    {rows.map((row) => (
                      <li key={row.id} className="card">
                        <button
                          className="review-row"
                          title={row.question}
                          onClick={() => onOpen(row.id)}
                        >
                          <span className="review-main">
                            <strong className="review-q">{row.question}</strong>
                            {row.applies_when && (
                              <span className="tag">When it applies: {row.applies_when}</span>
                            )}
                            <span className="muted small va-answer">{firstLine(row.answer)}</span>
                            <span className="muted small">
                              {pick.topic === null && row.subtopic ? `${row.subtopic} · ` : ""}
                              {row.approved_by ? `Approved by ${row.approved_by.name} · ` : ""}
                              {formatDate(row.updated_at)}
                              {row.expires_at && ` · Expires ${formatDate(row.expires_at)}`}
                            </span>
                            {row.needs_check && (
                              <span className="tag tag-warn">
                                {row.needs_check_reason ?? "Needs check"}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {shown.length === 0 && <p className="muted">Nothing in this topic here.</p>}
          </div>
        </div>
      )}
    </>
  );
}

/** Import verified answers from a CSV or Excel file: one per row, never merged (step 26). */
function ImportButton({ onDone }: { onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<VerifiedImport | null>(null);
  const [error, setError] = useState("");

  async function upload(file: File) {
    setError("");
    setResult(null);
    setProgress(0);
    try {
      setResult(await api.importVerified(file, setProgress));
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not imported.");
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return (
    <div className="va-import">
      <input
        ref={input}
        type="file"
        accept=".xlsx,.csv"
        className="sr-only"
        id="va-import"
        aria-label="Import verified answers"
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
        {progress !== null ? `Importing… ${progress}%` : "Import from a file"}
      </button>
      {error && <Alert kind="error">{error}</Alert>}
      {result && (
        <Alert kind="success">
          Added {plural(result.created, "answer")}, updated {result.updated}, unchanged{" "}
          {result.unchanged}.
          {result.skipped.length > 0 && (
            <>
              {" "}
              Skipped {plural(result.skipped.length, "row")}:
              <ul className="small">
                {result.skipped.slice(0, 20).map((s) => (
                  <li key={s.row}>
                    Row {s.row}: {s.reason}
                  </li>
                ))}
                {result.skipped.length > 20 && <li>…and {result.skipped.length - 20} more.</li>}
              </ul>
            </>
          )}
        </Alert>
      )}
    </div>
  );
}

/** The post's own wording: long, so two lines until opened. */
function AlsoAsked({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > 220;
  return (
    <div className="va-also">
      <span className="va-label">Also asked as</span>
      <p className={long && !more ? "va-clamp" : undefined}>{text}</p>
      {long && (
        <button className="link-button small" onClick={() => setMore(!more)}>
          {more ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function Detail({
  id,
  startEditing = false,
  onBack,
  onOpen,
}: {
  id: string;
  startEditing?: boolean;
  onBack: () => void;
  onOpen: (id: string, edit?: boolean) => void;
}) {
  const [va, setVa] = useState<VerifiedDetail | null>(null);
  const [versions, setVersions] = useState<VerifiedVersion[]>([]);
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [applies, setApplies] = useState("");
  const [also, setAlso] = useState("");
  const [topic, setTopic] = useState("");
  const [subtopic, setSubtopic] = useState("");
  const [known, setKnown] = useState<VerifiedTopic[]>([]);
  const [expiry, setExpiry] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const load = useCallback(() => {
    api
      .getVerified(id)
      .then((data) => {
        setVa(data);
        setExpiry(data.expires_at ? data.expires_at.slice(0, 10) : "");
        if (startEditing) edit(data);
      })
      .catch((err: unknown) =>
        setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not loaded." }),
      );
    api
      .verifiedHistory(id)
      .then(setVersions)
      .catch(() => setVersions([]));
    // Only on the first load: opened with "Edit" from another answer's box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(load, [load]);

  function edit(data: VerifiedDetail) {
    setQuestion(data.question);
    setAnswer(data.answer);
    setApplies(data.applies_when ?? "");
    setAlso(data.also_asked ?? "");
    setTopic(data.topic);
    setSubtopic(data.subtopic);
    setEditing(true);
    // The topics already used, to pick from.
    api
      .listVerified("all", "")
      .then((found) => setKnown(found.topics))
      .catch(() => undefined);
  }

  async function run(call: () => Promise<unknown>, done: string) {
    setNotice(null);
    try {
      await call();
      setNotice({ kind: "success", text: done });
      setEditing(false);
      load();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not saved." });
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void run(
      () =>
        api.updateVerified(id, {
          question,
          answer,
          applies_when: applies,
          also_asked: also,
          topic,
          subtopic,
        }),
      "Saved. Search is updated.",
    );
  }

  function saveExpiry(event: FormEvent) {
    event.preventDefault();
    const patch = expiry
      ? { expires_at: new Date(`${expiry}T23:59:59`).toISOString() }
      : { clear_expiry: true };
    void run(
      () => api.updateVerified(id, patch),
      expiry ? "Expiry date set." : "It never expires now.",
    );
  }

  return (
    <>
      <button className="link-button" onClick={onBack}>
        ← Verified Answers
      </button>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {va && (
        <div className="stack">
          <div className="va-question">
            <span className="va-label">Question</span>
            <h1>{va.question}</h1>
            <p className="muted">
              <span className={`pill pill-va-${va.status}`}>
                {{ active: "Active", disabled: "Disabled", expired: "Expired" }[va.status]}
              </span>{" "}
              {va.topic && `${[va.topic, va.subtopic].filter(Boolean).join(" › ")} · `}
              Version {va.version}
              {va.approved_by && ` · approved by ${va.approved_by.name}`} ·{" "}
              {formatDate(va.updated_at)}
            </p>
            {va.also_asked && !editing && <AlsoAsked text={va.also_asked} />}
          </div>
          {va.needs_check && (
            <Alert kind="info">
              {va.needs_check_reason ?? "Someone should check this answer."}{" "}
              {va.can_manage && (
                <button
                  className="link-button"
                  onClick={() =>
                    void run(() => api.updateVerified(id, { checked: true }), "Marked as checked.")
                  }
                >
                  Mark as checked
                </button>
              )}
            </Alert>
          )}
          {editing ? (
            <form className="card stack" onSubmit={save}>
              <label htmlFor="va-question">Question</label>
              <input
                id="va-question"
                className="input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <div className="va-topic-fields">
                <span>
                  <label htmlFor="va-topic">Topic</label>
                  <input
                    id="va-topic"
                    className="input"
                    list="va-topic-list"
                    placeholder="e.g. Google Business Profile"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                  />
                </span>
                <span>
                  <label htmlFor="va-subtopic">Subtopic</label>
                  <input
                    id="va-subtopic"
                    className="input"
                    list="va-subtopic-list"
                    placeholder="e.g. Reviews"
                    value={subtopic}
                    onChange={(e) => setSubtopic(e.target.value)}
                  />
                </span>
                <datalist id="va-topic-list">
                  {known
                    .filter((t) => t.name)
                    .map((t) => (
                      <option key={t.name} value={t.name} />
                    ))}
                </datalist>
                <datalist id="va-subtopic-list">
                  {(known.find((t) => t.name === topic)?.subtopics ?? [])
                    .filter((x) => x.name)
                    .map((x) => (
                      <option key={x.name} value={x.name} />
                    ))}
                </datalist>
              </div>
              <label htmlFor="va-applies">When it applies (optional)</label>
              <input
                id="va-applies"
                className="input"
                placeholder="e.g. If you have a storefront"
                value={applies}
                onChange={(e) => setApplies(e.target.value)}
              />
              <label htmlFor="va-also">Also asked as (optional, separate wordings with ||)</label>
              <input
                id="va-also"
                className="input"
                value={also}
                onChange={(e) => setAlso(e.target.value)}
              />
              <label htmlFor="va-answer">Answer</label>
              <textarea
                id="va-answer"
                className="textarea"
                rows={8}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <div className="row">
                <button className="button button-primary">Save</button>
                <button type="button" className="button" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <section className="va-answers" aria-label="Answers">
              <h2 className="va-group-head">
                {va.group.length > 1 ? "Answers" : "Answer"}
                {va.group.length > 1 && <span className="va-count">{va.group.length}</span>}
                {va.group.length > 1 && (
                  <span className="va-hint">
                    Each is correct on its own; the best fit is used when answering.
                  </span>
                )}
              </h2>
              <div className="va-grid" data-n={Math.min(va.group.length, 3)}>
                {va.group.map((g, n) => {
                  const mine = g.id === va.id;
                  const name = va.group.length > 1 ? `Answer ${n + 1}` : "Answer";
                  return (
                    <article
                      key={g.id}
                      className={`card va-col${mine && va.group.length > 1 ? " va-col-on" : ""}`}
                      aria-label={name}
                    >
                      <div className="va-answer-head">
                        <span className="va-label va-label-answer">{name}</span>
                        {g.status !== "active" && (
                          <span className={`pill pill-va-${g.status}`}>
                            {
                              { active: "Active", disabled: "Disabled", expired: "Expired" }[
                                g.status
                              ]
                            }
                          </span>
                        )}
                      </div>
                      {g.applies_when && (
                        <span className="tag va-when">When it applies: {g.applies_when}</span>
                      )}
                      <div className="va-col-text">
                        <Markdown text={mine ? va.answer : g.answer} />
                      </div>
                      {va.can_manage && (
                        <div className="row">
                          <button
                            className="button button-small"
                            aria-label={`Edit ${name.toLowerCase()}`}
                            onClick={() => (mine ? edit(va) : onOpen(g.id, true))}
                          >
                            Edit
                          </button>
                          {g.status === "active" ? (
                            <button
                              className="button button-small"
                              onClick={() =>
                                void run(
                                  () => api.disableVerified(g.id),
                                  `${name} disabled: it's no longer used.`,
                                )
                              }
                            >
                              Disable
                            </button>
                          ) : (
                            <button
                              className="button button-small"
                              onClick={() =>
                                void run(
                                  () => api.enableVerified(g.id),
                                  `${name} enabled: it's used again.`,
                                )
                              }
                            >
                              Enable
                            </button>
                          )}
                          <button
                            className="button button-small button-danger"
                            onClick={() => setDeleting(g.id)}
                          >
                            Delete
                          </button>
                          {!mine && (
                            <button
                              className="link-button small va-open"
                              onClick={() => onOpen(g.id)}
                            >
                              History
                            </button>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )}
          {va.can_manage && !editing && (
            <form className="card row" onSubmit={saveExpiry}>
              <label className="inline" htmlFor="va-expiry">
                {va.group.length > 1
                  ? `Answer ${va.group.findIndex((g) => g.id === va.id) + 1} expires on`
                  : "Expires on"}
              </label>
              <input
                id="va-expiry"
                type="date"
                className="input date-input"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
              <button className="button">{expiry ? "Set expiry" : "Never expires"}</button>
            </form>
          )}
          {va.sources.length > 0 && (
            <div>
              <h3>From</h3>
              <ul>
                {va.sources.map((s) => (
                  <li key={s.file_id}>
                    {s.available ? (
                      <a
                        href={api.fileUrl(s.file_id, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {s.name}
                      </a>
                    ) : (
                      <span className="muted">{s.name} (deleted)</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {versions.length > 0 && (
            <div>
              <h3>
                {va.group.length > 1
                  ? `History of answer ${va.group.findIndex((g) => g.id === va.id) + 1}`
                  : "History"}
              </h3>
              <ul className="history">
                {versions.map((v) => (
                  <li key={v.version}>
                    <strong>Version {v.version}</strong> · {v.changed_by?.name ?? "Someone"} ·{" "}
                    {formatDate(v.at)}
                    <div className="muted small">{firstLine(v.answer)}</div>
                    {va.can_manage && v.version !== va.version && (
                      <button
                        className="link-button small"
                        onClick={() =>
                          void run(
                            () => api.restoreVerifiedVersion(id, v.version),
                            `Version ${v.version} restored.`,
                          )
                        }
                      >
                        Restore this version
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {deleting !== null && va && (
        <Confirm
          title="Delete this verified answer?"
          message="It stops being used at once. The Owner can restore it from the trash for 30 days."
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const gone = deleting;
            setDeleting(null);
            const left = va.group.find((g) => g.id !== gone);
            void api
              .deleteVerified(gone)
              .then(() => (gone !== id ? load() : left ? onOpen(left.id) : onBack()))
              .catch((err: unknown) =>
                setNotice({
                  kind: "error",
                  text: err instanceof ApiError ? err.message : "Not deleted.",
                }),
              );
          }}
        />
      )}
    </>
  );
}
