import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type AnswerStatus,
  type Gap,
  type LogDetail,
  type LogFilters,
  type LogPage,
  type LogRow,
} from "../api";
import { Markdown } from "../components/Markdown";
import { Alert, Modal } from "../components/ui";
import { formatDate, plural } from "../format";
import { STATUS_NAMES } from "../labels";

// Answer Log (SPEC section 7.5): every answer, for Owners and (read only) Reviewers.

export function ConfidenceCell({ row }: { row: Pick<LogRow, "outcome" | "confidence"> }) {
  if (row.outcome === "no_answer") return <span className="conf conf-none">🔴 No answer</span>;
  if (row.outcome === "high") return <span className="conf conf-high">🟢 {row.confidence}</span>;
  if (row.outcome === "low") return <span className="conf conf-low">🟠 {row.confidence}</span>;
  return <span className="muted">—</span>;
}

function dateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function percent(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function minutes(value: number | null): string {
  if (value === null) return "—";
  if (value < 60) return `${value} min`;
  return `${Math.round(value / 6) / 10} h`;
}

export function AnswerLog() {
  const [tab, setTab] = useState<"answers" | "gaps">("answers");
  return (
    <section className="page">
      <div className="page-head">
        <h1>Answer Log</h1>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "answers"} onClick={() => setTab("answers")}>
          Answers
        </button>
        <button role="tab" aria-selected={tab === "gaps"} onClick={() => setTab("gaps")}>
          Knowledge gaps
        </button>
      </div>
      {tab === "answers" ? <Answers /> : <Gaps />}
    </section>
  );
}

function Answers() {
  const [filters, setFilters] = useState<LogFilters>({ page: 1 });
  const [data, setData] = useState<LogPage | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api
      .answerLog(filters)
      .then((page) => current && (setData(page), setError("")))
      .catch(
        (err: unknown) =>
          current && setError(err instanceof ApiError ? err.message : "Not loaded."),
      );
    return () => {
      current = false;
    };
  }, [filters]);

  const set = (patch: LogFilters) => setFilters((f) => ({ ...f, ...patch, page: 1 }));
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <>
      {data && (
        <div className="stats" aria-label="This month">
          <Stat label="Answers this month" value={String(data.stats.answers_this_month)} />
          <Stat label="High confidence" value={percent(data.stats.high_pct)} />
          <Stat label="Corrected" value={percent(data.stats.corrected_pct)} />
          <Stat label="Average review time" value={minutes(data.stats.avg_review_minutes)} />
        </div>
      )}
      <div className="filters">
        <input
          type="search"
          className="input"
          placeholder="Search questions and answers"
          aria-label="Search"
          value={filters.q ?? ""}
          onChange={(e) => set({ q: e.target.value })}
        />
        <select
          aria-label="Confidence"
          value={filters.outcome ?? ""}
          onChange={(e) => set({ outcome: e.target.value as LogFilters["outcome"] })}
        >
          <option value="">Any confidence</option>
          <option value="high">High</option>
          <option value="low">Low</option>
          <option value="no_answer">No answer</option>
        </select>
        <select
          aria-label="Status"
          value={filters.status ?? ""}
          onChange={(e) => set({ status: e.target.value as AnswerStatus | "" })}
        >
          <option value="">Any status</option>
          {Object.entries(STATUS_NAMES).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Type"
          value={filters.kind ?? ""}
          onChange={(e) => set({ kind: e.target.value as LogFilters["kind"] })}
        >
          <option value="">Chat and marketing</option>
          <option value="chat">Chat</option>
          <option value="marketing">Marketing</option>
        </select>
        <select
          aria-label="Person"
          value={filters.person ?? ""}
          onChange={(e) => set({ person: e.target.value })}
        >
          <option value="">Everyone</option>
          {data?.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="inline">
          From
          <input
            type="date"
            value={filters.date_from ?? ""}
            onChange={(e) => set({ date_from: e.target.value })}
          />
        </label>
        <label className="inline">
          To
          <input
            type="date"
            value={filters.date_to ?? ""}
            onChange={(e) => set({ date_to: e.target.value })}
          />
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={filters.flagged === "true"}
            onChange={(e) => set({ flagged: e.target.checked ? "true" : "" })}
          />
          Flagged 👎
        </label>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Question</th>
                <th>Confidence</th>
                <th>Status</th>
                <th className="hide-narrow">Asked by</th>
                <th className="hide-narrow">Date</th>
                <th className="hide-narrow">Sources</th>
                <th className="hide-narrow">Feedback</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button className="link-button" onClick={() => setOpen(row.id)}>
                      {row.question}
                    </button>
                    <div className="muted small">
                      {row.kind === "chat" ? "Chat" : "Marketing"}
                      {row.flagged && <span className="tag tag-warn">Flagged</span>}
                    </div>
                  </td>
                  <td>
                    <ConfidenceCell row={row} />
                  </td>
                  <td>{STATUS_NAMES[row.status]}</td>
                  <td className="hide-narrow">{row.asked_by?.name ?? "—"}</td>
                  <td className="hide-narrow">{dateTime(row.created_at)}</td>
                  <td className="hide-narrow">{row.source_count}</td>
                  <td className="hide-narrow">
                    {row.feedback === "up" ? "👍" : row.feedback === "down" ? "👎" : ""}
                  </td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No answers match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > data.page_size && (
        <div className="pager">
          <button
            className="button button-small"
            disabled={data.page <= 1}
            onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 1) - 1 }))}
          >
            Previous
          </button>
          <span className="muted small">
            Page {data.page} of {pages} · {plural(data.total, "answer")}
          </span>
          <button
            className="button button-small"
            disabled={data.page >= pages}
            onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 1) + 1 }))}
          >
            Next
          </button>
        </div>
      )}
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat card">
      <div className="stat-value">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const [answer, setAnswer] = useState<LogDetail | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .answerDetail(id)
      .then(setAnswer)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [id]);
  useEffect(load, [load]);

  return (
    <Modal title="Answer" onClose={onClose}>
      {error && <Alert kind="error">{error}</Alert>}
      {answer && (
        <div className="stack answer-detail">
          <div>
            <div className="muted small">
              {answer.asked_by?.name ?? "Someone"} · {dateTime(answer.created_at)} ·{" "}
              {answer.kind === "chat" ? "Chat" : "Marketing"}
            </div>
            <h3>{answer.question}</h3>
            {answer.retrieval_query !== answer.question && (
              <p className="muted small">Searched for: {answer.retrieval_query}</p>
            )}
          </div>
          <div className="bubble bubble-answer">
            <Markdown text={answer.current_text} />
          </div>
          {answer.current_text !== answer.original_text && (
            <details>
              <summary>Original answer</summary>
              <Markdown text={answer.original_text} />
            </details>
          )}
          <dl className="pairs">
            <dt>Confidence</dt>
            <dd>
              <ConfidenceCell row={answer} />{" "}
              {answer.explanation && <span className="muted">{answer.explanation}</span>}
            </dd>
            <dt>Status</dt>
            <dd>{STATUS_NAMES[answer.status]}</dd>
            {answer.feedback && (
              <>
                <dt>Feedback</dt>
                <dd>
                  {answer.feedback === "up" ? "👍" : "👎"}
                  {answer.flag_note && <> “{answer.flag_note}”</>}
                </dd>
              </>
            )}
            <dt>Cost</dt>
            <dd>
              ${answer.cost_usd.toFixed(3)}
              {answer.model && <span className="muted"> · {answer.model}</span>}
            </dd>
          </dl>
          {answer.confidence_parts && answer.confidence_parts.unsupported_claims.length > 0 && (
            <div>
              <h4>Not supported by the documents</h4>
              <ul>
                {answer.confidence_parts.unsupported_claims.map((claim) => (
                  <li key={claim}>{claim}</li>
                ))}
              </ul>
            </div>
          )}
          {answer.sources.length > 0 && (
            <div>
              <h4>Sources</h4>
              <ul className="sources">
                {answer.sources.map((source) => (
                  <li key={source.n}>
                    <a
                      className="source-chip"
                      href={
                        api.fileUrl(source.file_id, true) +
                        (source.page ? `#page=${source.page}` : "")
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className="source-n">{source.n}</span> {source.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Gaps() {
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .knowledgeGaps()
      .then(setGaps)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, []);

  return (
    <>
      <p className="muted">
        Questions from the last 90 days that the knowledge base couldn't answer, or where the team
        knows no answer. Similar questions are grouped. Upload a document that answers them.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      {gaps && gaps.length === 0 && <p className="muted">No knowledge gaps. 🎉</p>}
      {gaps && gaps.length > 0 && (
        <ul className="gaps">
          {gaps.map((gap) => (
            <li key={gap.answer_ids[0]} className="card">
              <div className="gap-head">
                <strong>{gap.question}</strong>
                <span className="tag">{plural(gap.count, "time")}</span>
              </div>
              {gap.examples.length > 1 && (
                <ul className="muted small">
                  {gap.examples.slice(1).map((example) => (
                    <li key={example}>{example}</li>
                  ))}
                </ul>
              )}
              {gap.last_asked_at && (
                <div className="muted small">Last asked {formatDate(gap.last_asked_at)}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
