import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  ApiError,
  type AuditEntry,
  type SettingsData,
  type SystemData,
  type UsageData,
} from "../api";
import { Alert, Field } from "../components/ui";
import { formatSize, plural } from "../format";

// The Answering, Limits, Usage, System and History cards of Settings (SPEC 7.8, step 14).

type Notice = { kind: "error" | "success"; text: string } | null;

function when(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function dollars(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Loads the settings, keeps a form of strings, and saves the given keys. */
function useSettingsForm(keys: string[], parse: (key: string, value: string) => unknown) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const joined = keys.join(",");

  const fill = useCallback(
    (next: SettingsData) => {
      setData(next);
      setForm(
        Object.fromEntries(
          joined
            .split(",")
            .map((key) => [key, next.values[key] == null ? "" : String(next.values[key])]),
        ),
      );
    },
    [joined],
  );

  useEffect(() => {
    api
      .getSettings()
      .then(fill)
      .catch(() => setNotice({ kind: "error", text: "Settings couldn't be loaded." }));
  }, [fill]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setErrors({});
    setNotice(null);
    try {
      fill(
        await api.updateSettings(
          Object.fromEntries(keys.map((key) => [key, parse(key, form[key] ?? "")])),
        ),
      );
      setNotice({ kind: "success", text: "Saved." });
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setNotice({ kind: "error", text: err.message });
      }
    }
  }

  // Read the value now: React resets a controlled field before a state updater runs.
  const set = (key: string) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  return { data, form, errors, notice, save, set };
}

function Select({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={onChange}>
        {children}
      </select>
      {hint && !error && <p className="hint">{hint}</p>}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

const MODEL_KEYS = ["answer_model", "rewrite_model", "check_model"] as const;
const MODEL_LABELS: Record<(typeof MODEL_KEYS)[number], string> = {
  answer_model: "Model for answers and marketing drafts",
  rewrite_model: "Model for follow-up questions",
  check_model: "Model for the support check",
};

export function Answering() {
  const { data, form, errors, notice, save, set } = useSettingsForm(
    [...MODEL_KEYS, "answer_effort", "min_relevance"],
    (key, value) => (key === "min_relevance" ? Number(value) : value || null),
  );

  return (
    <div className="card stack">
      <h2>Answering</h2>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {data && (
        <form className="stack" onSubmit={save}>
          <Alert kind="info">
            Re-run the evaluation set before switching models: cheaper models cost less but may
            answer less well.
          </Alert>
          {MODEL_KEYS.map((key) => (
            <Select
              key={key}
              id={`setting-${key}`}
              label={MODEL_LABELS[key]}
              value={form[key] ?? ""}
              onChange={set(key)}
              error={errors[key]}
            >
              <option value="">Server default ({data.models.server[key]})</option>
              {data.models.choices.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} — ${m.input_usd} / ${m.output_usd} per million tokens
                </option>
              ))}
            </Select>
          ))}
          <Select
            id="setting-answer_effort"
            label="Effort for answers"
            value={form.answer_effort ?? "medium"}
            onChange={set("answer_effort")}
            hint="Higher effort can give better answers, but they are slower and cost more."
            error={errors.answer_effort}
          >
            {data.models.efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </Select>
          <Field
            label="Minimum relevance"
            type="number"
            step="0.05"
            min={0}
            max={1}
            hint="Document passages scoring below this (0–1) are never given to Claude."
            value={form.min_relevance ?? ""}
            error={errors.min_relevance}
            onChange={set("min_relevance")}
          />
          <div className="row">
            <button className="button button-primary">Save</button>
          </div>
        </form>
      )}
    </div>
  );
}

export function Limits() {
  const { data, form, errors, notice, save, set } = useSettingsForm(
    [
      "max_upload_mb",
      "questions_per_user_per_day",
      "monthly_cost_alert_usd",
      "thread_auto_close_days",
    ],
    (_key, value) => Number(value),
  );

  return (
    <div className="card stack">
      <h2>Limits</h2>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {data && (
        <form className="stack" onSubmit={save}>
          <Field
            label="Largest upload (MB)"
            type="number"
            min={1}
            max={200}
            value={form.max_upload_mb ?? ""}
            error={errors.max_upload_mb}
            onChange={set("max_upload_mb")}
          />
          <Field
            label="Questions per person per day"
            type="number"
            min={1}
            hint="Resets at midnight (UTC)."
            value={form.questions_per_user_per_day ?? ""}
            error={errors.questions_per_user_per_day}
            onChange={set("questions_per_user_per_day")}
          />
          <Field
            label="Monthly cost alert (US$)"
            type="number"
            min={0}
            step="any"
            hint="The Owners are told once a month when Claude usage passes this. 0 turns it off."
            value={form.monthly_cost_alert_usd ?? ""}
            error={errors.monthly_cost_alert_usd}
            onChange={set("monthly_cost_alert_usd")}
          />
          <Field
            label="Close quiet marketing threads after (days)"
            type="number"
            min={1}
            value={form.thread_auto_close_days ?? ""}
            error={errors.thread_auto_close_days}
            onChange={set("thread_auto_close_days")}
          />
          <div className="row">
            <button className="button button-primary">Save</button>
          </div>
        </form>
      )}
    </div>
  );
}

const USAGE_KINDS: Record<string, string> = {
  answer: "Answers",
  check: "Support checks",
  draft: "Marketing drafts",
  ocr: "Reading scanned pages",
};

function thisMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysIn(month: string): number {
  const [year = 2000, m = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

/** Cost per day as bars: one series, so no legend; the table below has the numbers. */
function DayBars({ data }: { data: UsageData }) {
  const days = daysIn(data.month);
  const byDay = new Map(data.by_day.map((d) => [Number(d.date.slice(8, 10)), d.cost_usd]));
  const top = Math.max(...byDay.values(), 0);
  if (top === 0) return null;
  const width = 10;
  const height = 100;
  return (
    <figure className="usage-chart">
      <figcaption className="hint">Cost per day · highest {dollars(top)}</figcaption>
      <svg
        viewBox={`0 0 ${days * width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Cost per day in ${data.month}`}
      >
        {Array.from({ length: days }, (_, i) => {
          const cost = byDay.get(i + 1) ?? 0;
          const h = cost > 0 ? Math.max(2, (cost / top) * height) : 0;
          return (
            <g key={i} className="usage-day">
              {/* The whole column is the hover target; the bar is the mark. */}
              <rect className="usage-hit" x={i * width} y={0} width={width} height={height}>
                <title>{`${data.month}-${String(i + 1).padStart(2, "0")}: ${dollars(cost)}`}</title>
              </rect>
              <rect
                className="usage-bar"
                x={i * width + 1}
                y={height - h}
                width={width - 2}
                height={h}
                rx={1}
              />
            </g>
          );
        })}
      </svg>
      <div className="usage-axis hint">
        <span>1</span>
        <span>{days}</span>
      </div>
    </figure>
  );
}

export function Usage() {
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .usage(month)
      .then((next) => {
        setData(next);
        setError("");
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [month]);

  const total = data?.total.cost_usd ?? 0;
  const alert = data?.alert_usd ?? 0;

  return (
    <div className="card stack" id="usage">
      <div className="page-head">
        <h2>Usage</h2>
        <div className="field field-inline">
          <label htmlFor="usage-month">Month</label>
          <input
            id="usage-month"
            type="month"
            value={month}
            max={thisMonth()}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
          />
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <div className="usage-total">
            <span className="usage-total-value">{dollars(total)}</span>
            <span className="hint">
              Claude cost in {data.month} · {plural(data.total.requests, "request")}
              {alert > 0 && ` · alert at ${dollars(alert)}`}
            </span>
            {alert > 0 && (
              <progress
                className={total >= alert ? "usage-over" : undefined}
                value={Math.min(total, alert)}
                max={alert}
                aria-label="Share of the monthly cost alert used"
              />
            )}
          </div>
          {data.by_day.length === 0 ? (
            <p className="hint">Nothing used this month.</p>
          ) : (
            <>
              <DayBars data={data} />
              <UsageTable
                title="By kind"
                rows={data.by_kind.map((r) => ({ ...r, label: USAGE_KINDS[r.kind] ?? r.kind }))}
              />
              <UsageTable
                title="By person"
                rows={data.by_person.map((r) => ({ ...r, label: r.name }))}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function UsageTable({
  title,
  rows,
}: {
  title: string;
  rows: {
    label: string;
    requests: number;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
  }[];
}) {
  return (
    <div className="table-card">
      <table className="table">
        <caption className="table-caption">{title}</caption>
        <thead>
          <tr>
            <th scope="col">{title.replace("By ", "")}</th>
            <th scope="col" className="num">
              Requests
            </th>
            <th scope="col" className="num">
              Tokens in / out
            </th>
            <th scope="col" className="num">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className="num">{r.requests.toLocaleString()}</td>
              <td className="num">
                {r.tokens_in.toLocaleString()} / {r.tokens_out.toLocaleString()}
              </td>
              <td className="num">{dollars(r.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function System() {
  const [data, setData] = useState<SystemData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .system()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, []);

  if (!data) return error ? <Alert kind="error">{error}</Alert> : null;
  const b = data.backup;
  return (
    <div className="card stack">
      <h2>System</h2>
      {!b.found || b.ok === false || b.late ? (
        <Alert kind="error">
          {!b.found
            ? `${b.message ?? "No backup found."} Backups run nightly once ops/backup.sh is scheduled (see ops/deploy.md).`
            : b.ok === false
              ? `The last backup failed${b.message ? `: ${b.message}` : "."}`
              : "The last backup is more than a day old. Check that the nightly backup still runs."}
        </Alert>
      ) : null}
      <dl className="facts">
        <div>
          <dt>Version</dt>
          <dd>
            {data.version} ({data.environment})
          </dd>
        </div>
        <div>
          <dt>Last backup</dt>
          <dd>
            {b.found && b.at
              ? `${when(b.at)} · ${b.ok ? "OK" : "failed"}` +
                (b.size_bytes != null ? ` · ${formatSize(b.size_bytes)}` : "") +
                (b.off_server ? " · copied off the server" : " · on this server only")
              : "None yet"}
          </dd>
        </div>
        <div>
          <dt>Jobs waiting</dt>
          <dd>
            {data.queued_jobs === 0
              ? "None"
              : `${data.queued_jobs}` +
                (data.oldest_queued_at ? ` (oldest since ${when(data.oldest_queued_at)})` : "")}
          </dd>
        </div>
        <div>
          <dt>Failed jobs (7 days)</dt>
          <dd>{data.failed_jobs_7d === 0 ? "None" : data.failed_jobs_7d}</dd>
        </div>
      </dl>
      {data.failed_jobs.length > 0 && (
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Job</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {data.failed_jobs.map((j) => (
                <tr key={j.id}>
                  <td className="nowrap">{when(j.at)}</td>
                  <td>
                    {j.kind} <span className="hint">({plural(j.attempts, "try", "tries")})</span>
                  </td>
                  <td>{j.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const ENTITY_LABELS: Record<string, string> = {
  settings: "Settings",
  user: "User",
  file: "File",
  verified_answer: "Verified answer",
  thread: "Marketing thread",
  review: "Review",
  knowledge_base: "Knowledge base",
};

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function History() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback((before?: string) => {
    api
      .audit(before)
      .then((page) => {
        setEntries((old) => (before ? [...old, ...page] : page));
        setMore(page.length === 30);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, []);
  useEffect(() => load(), [load]);

  return (
    <div className="card stack">
      <h2>History</h2>
      {error && <Alert kind="error">{error}</Alert>}
      {entries.length === 0 && !error && <p className="hint">No changes yet.</p>}
      <ul className="audit-list">
        {entries.map((e) => (
          <li key={e.id}>
            <div>
              <strong>{e.actor ?? "Someone (removed)"}</strong> · {e.action.replaceAll("_", " ")}{" "}
              {ENTITY_LABELS[e.entity] ?? e.entity}
              {e.title && <> · {e.title}</>}
              <span className="hint"> · {when(e.at)}</span>
            </div>
            {e.changes.length > 0 && (
              <ul className="audit-changes">
                {e.changes.map((c) => (
                  <li key={c.field}>
                    {c.field}: {show(c.from)} → {show(c.to)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {more && (
        <div>
          <button className="button" onClick={() => load(entries[entries.length - 1]?.at)}>
            Show older
          </button>
        </div>
      )}
    </div>
  );
}
