import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type VerifiedDetail,
  type VerifiedPage,
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

export function Verified() {
  const [openId, setOpenId] = useState<string | null>(idFromUrl);
  const open = (id: string | null) => {
    setOpenId(id);
    navigate(id ? `/verified?id=${id}` : "/verified", true);
  };
  return (
    <section className="page">
      {openId ? <Detail id={openId} onBack={() => open(null)} /> : <List onOpen={open} />}
    </section>
  );
}

function List({ onOpen }: { onOpen: (id: string) => void }) {
  const [show, setShow] = useState<Show>("active");
  const [q, setQ] = useState("");
  const [page, setPage] = useState<VerifiedPage | null>(null);
  const [error, setError] = useState("");

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
  }, [show, q]);

  return (
    <>
      <div className="page-head">
        <h1>Verified Answers</h1>
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
        <ul className="review-list">
          {page.items.map((row) => (
            <li key={row.id} className="card">
              <button className="review-row" onClick={() => onOpen(row.id)}>
                <span className="review-main">
                  <strong>{row.question}</strong>
                  <span className="muted small">{firstLine(row.answer)}</span>
                  <span className="muted small">
                    {row.approved_by ? `Approved by ${row.approved_by.name} · ` : ""}
                    {formatDate(row.updated_at)}
                    {row.expires_at && ` · Expires ${formatDate(row.expires_at)}`}
                  </span>
                  {row.needs_check && (
                    <span className="tag tag-warn">{row.needs_check_reason ?? "Needs check"}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const [va, setVa] = useState<VerifiedDetail | null>(null);
  const [versions, setVersions] = useState<VerifiedVersion[]>([]);
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [expiry, setExpiry] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const load = useCallback(() => {
    api
      .getVerified(id)
      .then((data) => {
        setVa(data);
        setExpiry(data.expires_at ? data.expires_at.slice(0, 10) : "");
      })
      .catch((err: unknown) =>
        setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not loaded." }),
      );
    api
      .verifiedHistory(id)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [id]);
  useEffect(load, [load]);

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
    void run(() => api.updateVerified(id, { question, answer }), "Saved. Search is updated.");
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
          <div>
            <h1>{va.question}</h1>
            <p className="muted">
              <span className={`pill pill-va-${va.status}`}>
                {{ active: "Active", disabled: "Disabled", expired: "Expired" }[va.status]}
              </span>{" "}
              Version {va.version}
              {va.approved_by && ` · approved by ${va.approved_by.name}`} ·{" "}
              {formatDate(va.updated_at)}
            </p>
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
            <div className="card">
              <Markdown text={va.answer} />
            </div>
          )}
          {va.can_manage && !editing && (
            <div className="row">
              <button
                className="button"
                onClick={() => {
                  setQuestion(va.question);
                  setAnswer(va.answer);
                  setEditing(true);
                }}
              >
                Edit
              </button>
              {va.status === "active" ? (
                <button
                  className="button"
                  onClick={() =>
                    void run(() => api.disableVerified(id), "Disabled: it's no longer used.")
                  }
                >
                  Disable
                </button>
              ) : (
                <button
                  className="button"
                  onClick={() =>
                    void run(() => api.enableVerified(id), "Enabled: it's used again.")
                  }
                >
                  Enable
                </button>
              )}
              <button className="button button-danger" onClick={() => setDeleting(true)}>
                Delete
              </button>
            </div>
          )}
          {va.can_manage && (
            <form className="card row" onSubmit={saveExpiry}>
              <label className="inline" htmlFor="va-expiry">
                Expires on
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
              <h3>History</h3>
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
      {deleting && va && (
        <Confirm
          title="Delete this verified answer?"
          message="It stops being used at once. The Owner can restore it from the trash for 30 days."
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void api.deleteVerified(id).then(onBack);
          }}
        />
      )}
    </>
  );
}
