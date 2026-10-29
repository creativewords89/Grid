import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  LEAD_FIELDS,
  leadQuery,
  type LeadDetail,
  type LeadFilters,
  type LeadPage,
  type LeadPatch,
} from "../api";
import { useAuth } from "../auth";
import { CHECK_CODES, FIELD_NAMES } from "../checkLabels";
import { FixFileButtons } from "../components/FixFile";
import { Alert, Field, Modal } from "../components/ui";
import { when } from "../format";

// Leads (SPEC sections 6.4 and 7): every business the Hub keeps, like a spreadsheet. Search,
// filter, sort, page through 100 at a time, download what is shown as Excel, and open a lead
// to see the agents' results and files, or (Owners and Admins) change or delete it. The
// table shows every field of the lead file side by side; the Lists (City + Niche) follow.

type LeadField = (typeof LEAD_FIELDS)[number];

const SORTS: [NonNullable<LeadFilters["sort"]>, string][] = [
  ["lead_id", "Lead ID"],
  ["newest", "Newest first"],
  ["name", "Business name"],
  ["city", "City"],
  ["rating", "Rating (highest first)"],
  ["reviews", "Reviews (most first)"],
];

/** A batch's leads (SPEC section 6.4 item 9): its own tab on the batch page. */
export function BatchLeads({ batchId, city = "" }: { batchId: string; city?: string }) {
  const [filters, setFilters] = useState<LeadFilters>({ batch_id: batchId, city });
  const [typed, setTyped] = useState({ q: "", city });
  const [data, setData] = useState<LeadPage | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const { user } = useAuth();
  const staff = user?.role === "owner" || user?.role === "admin";
  // Top is chosen only in a city opened from the Cities tab (SPEC step 19).
  const choosing = staff && city !== "";

  const load = useCallback(() => {
    api
      .leads(filters)
      .then((page) => {
        setError("");
        setData(page);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [filters]);
  useEffect(load, [load]);

  const change = (patch: LeadFilters) => setFilters((f) => ({ ...f, ...patch, page: 1 }));

  function search(event: FormEvent) {
    event.preventDefault();
    change({ q: typed.q.trim(), city: typed.city.trim() });
  }

  // Search as you type: the words and the city are applied a moment after the last key.
  useEffect(() => {
    const q = typed.q.trim();
    const place = typed.city.trim();
    if (q === (filters.q ?? "") && place === (filters.city ?? "")) return;
    const timer = window.setTimeout(() => change({ q, city: place }), 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  const menu = useRef<HTMLDetailsElement>(null);
  const closeMenu = () => menu.current?.removeAttribute("open");

  // The filters that are on, each a chip that takes it off.
  const chips: [keyof LeadFilters, string][] = [];
  if (filters.q) chips.push(["q", `“${filters.q}”`]);
  if (filters.city && !city) chips.push(["city", `City: ${filters.city}`]);
  if (filters.level) chips.push(["level", filters.level === "top" ? "Top only" : "Not Top"]);
  if (filters.website)
    chips.push(["website", filters.website === "yes" ? "Has a website" : "No website"]);
  if (filters.problems) {
    const name =
      filters.problems === "any"
        ? "Any problem"
        : filters.problems === "errors"
          ? "Errors only"
          : (CHECK_CODES.find(([code]) => code === filters.problems)?.[1] ?? filters.problems);
    chips.push(["problems", `Problems: ${name}`]);
  }

  function clear(key: keyof LeadFilters) {
    if (key === "q" || key === "city") setTyped((t) => ({ ...t, [key]: "" }));
    change({ [key]: undefined });
  }

  const agents = Object.entries(data?.agents ?? {});
  const onPage = data?.leads.map((l) => l.lead_id) ?? [];
  const allChosen = onPage.length > 0 && onPage.every((id) => chosen.has(id));

  function toggle(id: string, on: boolean) {
    setChosen((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function markTop(top: boolean) {
    setError("");
    try {
      const done = await api.markTop(batchId, city, [...chosen], top);
      setNotice(
        `${done.changed.toLocaleString()} ${done.changed === 1 ? "lead" : "leads"} ${
          top ? "marked as Top: agents leave them alone" : "no longer Top"
        }.`,
      );
      setChosen(new Set());
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not saved.");
    }
  }
  const shown: LeadFilters = { ...filters, page: undefined };
  const sortValue = filters.sort === "score" ? `score:${filters.score_of}` : (filters.sort ?? "");

  return (
    <div className="stack">
      <form className="leads-toolbar" onSubmit={search} aria-label="Find leads">
        <div className="toolbar-search">
          <label className="sr-only" htmlFor="leads-q">
            Search
          </label>
          <input
            id="leads-q"
            type="search"
            placeholder="🔍 Search name, email, phone, website…"
            value={typed.q}
            onChange={(e) => setTyped((t) => ({ ...t, q: e.target.value }))}
          />
        </div>
        <label className="sr-only" htmlFor="leads-city">
          City
        </label>
        <input
          id="leads-city"
          className="toolbar-city"
          placeholder="City"
          value={typed.city}
          onChange={(e) => setTyped((t) => ({ ...t, city: e.target.value }))}
        />
        <label className="sr-only" htmlFor="leads-level">
          Top
        </label>
        <select
          id="leads-level"
          value={filters.level ?? ""}
          onChange={(e) => change({ level: e.target.value as LeadFilters["level"] })}
        >
          <option value="">Top: all</option>
          <option value="top">Top only</option>
          <option value="not_top">Not Top</option>
        </select>
        <label className="sr-only" htmlFor="leads-website">
          Website
        </label>
        <select
          id="leads-website"
          value={filters.website ?? ""}
          onChange={(e) => change({ website: e.target.value as LeadFilters["website"] })}
        >
          <option value="">Website: all</option>
          <option value="yes">Has a website</option>
          <option value="no">No website</option>
        </select>
        <label className="sr-only" htmlFor="leads-problems">
          Problems
        </label>
        <select
          id="leads-problems"
          value={filters.problems ?? ""}
          onChange={(e) => change({ problems: e.target.value })}
        >
          <option value="">Problems: all leads</option>
          <option value="any">Any problem</option>
          <option value="errors">Errors only (hold the file)</option>
          {CHECK_CODES.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="leads-sort">
          Sort by
        </label>
        <select
          id="leads-sort"
          value={sortValue}
          onChange={(e) => {
            const value = e.target.value;
            if (value.startsWith("score:")) {
              change({ sort: "score", score_of: value.slice(6) });
            } else {
              change({ sort: value as LeadFilters["sort"], score_of: undefined });
            }
          }}
        >
          {SORTS.map(([value, label]) => (
            <option key={value} value={value}>
              Sort: {label}
            </option>
          ))}
          {agents.map(([key, label]) => (
            <option key={key} value={`score:${key}`}>
              Sort: {label} score (best first)
            </option>
          ))}
        </select>
        <button className="sr-only" tabIndex={-1}>
          Search
        </button>
        <div className="toolbar-actions">
          <details className="menu" ref={menu}>
            <summary className="button">
              <span aria-hidden="true">⬇</span> Download
            </summary>
            <div className="menu-list">
              <a href={`/api/leads/export${leadQuery(shown)}`} download onClick={closeMenu}>
                Download Excel
                <span className="muted small">The leads shown, every column</span>
              </a>
              <a href={`/api/batches/${batchId}/fixes.xlsx`} download onClick={closeMenu}>
                Download problems to fix
                <span className="muted small">Wrong cells marked, to fix in Excel</span>
              </a>
            </div>
          </details>
          <FixFileButtons
            href={`/api/batches/${batchId}/fixes.xlsx`}
            batchId={batchId}
            staff={staff}
            onSaved={load}
            download={false}
          />
        </div>
      </form>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {data && (
        <div className="leads-summary">
          <span className="cell-strong">
            {data.total.toLocaleString()} {data.total === 1 ? "lead" : "leads"}
          </span>
          {chips.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="chip"
              title="Take this filter off"
              onClick={() => clear(key)}
            >
              {label} ×
            </button>
          ))}
          {staff && !city && (
            <span
              className="info-dot"
              title="Top is chosen in a city: open one on the Cities tab and tick its leads."
              aria-label="Top is chosen in a city: open one on the Cities tab and tick its leads."
            >
              ⓘ
            </span>
          )}
          <Pager data={data} onPage={(page) => setFilters((f) => ({ ...f, page }))} />
        </div>
      )}
      {choosing && chosen.size > 0 && (
        <div className="city-bar" role="region" aria-label="Chosen leads">
          <strong>{chosen.size.toLocaleString()} chosen</strong>
          <button
            className="button button-primary"
            disabled={chosen.size > 500}
            onClick={() => void markTop(true)}
          >
            Mark as Top
          </button>
          <button
            className="button"
            disabled={chosen.size > 500}
            onClick={() => void markTop(false)}
          >
            Remove Top
          </button>
          <button className="link-button" onClick={() => setChosen(new Set())}>
            Clear
          </button>
          <span className="muted small">
            {chosen.size > 500
              ? "At most 500 at a time."
              : "Top businesses are never audited or contacted."}
          </span>
        </div>
      )}
      {data?.total === 0 && <p className="muted">No leads match.</p>}
      {data && data.leads.length > 0 && (
        <div className="card table-card table-scroll table-tall">
          <table className="table leads-table">
            <thead>
              <tr>
                {choosing && (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Choose every lead on this page"
                      checked={allChosen}
                      onChange={(e) => onPage.forEach((id) => toggle(id, e.target.checked))}
                    />
                  </th>
                )}
                <th>Lead ID</th>
                <th className="sticky-col">Business name</th>
                <th>Check</th>
                {COLUMNS.map(([key, label]) => (
                  <th key={key}>{label}</th>
                ))}
                {data.extra_columns.map((name) => (
                  <th key={`extra:${name}`}>{name}</th>
                ))}
                <th>Batch</th>
                {agents.map(([key, label]) => (
                  <th key={key}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.leads.map((lead) => (
                <tr
                  key={lead.lead_id}
                  className={chosen.has(lead.lead_id) ? "row-chosen" : undefined}
                >
                  {choosing && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Choose ${lead.business_name || lead.lead_id}`}
                        checked={chosen.has(lead.lead_id)}
                        onChange={(e) => toggle(lead.lead_id, e.target.checked)}
                      />
                    </td>
                  )}
                  <td className="small nowrap">{lead.lead_id}</td>
                  <td className="sticky-col">
                    <button
                      className="link-button cell-strong"
                      onClick={() => setOpen(lead.lead_id)}
                    >
                      {lead.business_name || lead.lead_id}
                    </button>
                  </td>
                  <td className="nowrap">
                    <CheckBadge issues={lead.check ?? []} />
                  </td>
                  {COLUMNS.map(([key]) => {
                    const found = (lead.check ?? []).filter((i) => i.field === checkField(key));
                    const wrong = found.some((i) => i.severity === "error");
                    return (
                      <td
                        key={key}
                        className={`small ${wrong ? "cell-problem" : ""}`}
                        title={found.map((i) => i.message).join("; ") || undefined}
                      >
                        <Cell lead={lead} field={key} />
                      </td>
                    );
                  })}
                  {data.extra_columns.map((name) => (
                    <td key={`extra:${name}`} className="small">
                      {lead.extra[name] || <span className="muted">—</span>}
                    </td>
                  ))}
                  <td className="small nowrap">{lead.batch_name ?? "—"}</td>
                  {agents.map(([key]) => {
                    const result = lead.results[key];
                    return (
                      <td key={key} className="small nowrap">
                        {result
                          ? `${result.score ?? "—"}${result.status !== "OK" ? ` · ${result.status}` : ""}`
                          : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.pages > 1 && (
        <div className="leads-summary">
          <Pager data={data} onPage={(page) => setFilters((f) => ({ ...f, page }))} />
        </div>
      )}
      {open && (
        <LeadDialog
          id={open}
          agents={data?.agents ?? {}}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

// Every field of the lead file, in the file's order (after Lead ID and Business name).
const COLUMNS: [string, string][] = [
  ["gbp_link", "GBP link"],
  ["address", "Address"],
  ["city", "City"],
  ["website", "Website"],
  ["phone", "Phone"],
  ["whatsapp", "WhatsApp"],
  ["emails", "Email"],
  ["facebook", "Facebook"],
  ["instagram", "Instagram"],
  ["reviews", "Reviews"],
  ["rating", "Rating"],
  ["level", "Top"],
  ["notes", "Notes"],
];
const LINKS = new Set(["gbp_link", "website", "facebook", "instagram"]);

/** Lead Check of a lead in one badge: green OK, or its errors and warnings. */
function CheckBadge({ issues }: { issues: { severity: string; message: string }[] }) {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  if (issues.length === 0) return <span className="badge badge-ok">✓ OK</span>;
  return (
    <span title={issues.map((i) => i.message).join("\n")}>
      {errors > 0 && <span className="badge badge-error">🔴 {errors}</span>}
      {warnings > 0 && <span className="badge badge-warning">🟠 {warnings}</span>}
    </span>
  );
}

/** ‹ Page 2 of 40 › */
function Pager({ data, onPage }: { data: LeadPage; onPage: (page: number) => void }) {
  if (data.pages <= 1) return null;
  return (
    <span className="pager">
      <button
        type="button"
        className="button button-small"
        aria-label="Previous"
        disabled={data.page <= 1}
        onClick={() => onPage(data.page - 1)}
      >
        ‹
      </button>
      <span className="small">
        Page {data.page} of {data.pages}
      </span>
      <button
        type="button"
        className="button button-small"
        aria-label="Next"
        disabled={data.page >= data.pages}
        onClick={() => onPage(data.page + 1)}
      >
        ›
      </button>
    </span>
  );
}

/** The Lead Check field of a column of the table. */
function checkField(column: string): string {
  return column === "emails" ? "email" : column;
}

/** A web address that is safe to open: http(s) only, a bare domain gets https://. */
function webLink(value: string): string | null {
  const text = value.trim();
  if (/^https?:\/\/[^\s]+$/i.test(text)) return text;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?$/i.test(text)) return `https://${text}`;
  return null;
}

function Cell({ lead, field }: { lead: LeadPage["leads"][number]; field: string }) {
  let value: string;
  if (field === "gbp_link") value = lead.gbp_link;
  else if (field === "city") value = lead.city;
  else if (field === "level") value = lead.level;
  else if (field === "emails") value = lead.emails.join(", ");
  else value = lead.data[field] ?? "";
  if (!value) return <span className="muted">—</span>;
  if (field === "level" && value === "Top") return <span className="pill pill-top">Top</span>;
  const link = LINKS.has(field) ? webLink(value) : null;
  if (link) {
    return (
      <a className="cell-link" href={link} target="_blank" rel="noopener noreferrer" title={value}>
        {field === "gbp_link" ? "Open map" : value.replace(/^https?:\/\/(www\.)?/i, "")}
      </a>
    );
  }
  if (field === "notes" || field === "address") {
    return (
      <span className="cell-clamp" title={value}>
        {value}
      </span>
    );
  }
  return (
    <span className="cell-trunc" title={value}>
      {value}
    </span>
  );
}

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;
}

/** The lead's current value of each field the Hub can change. */
function valuesOf(lead: LeadDetail): Record<LeadField, string> {
  const out = {} as Record<LeadField, string>;
  for (const key of LEAD_FIELDS) out[key] = lead.data[key] ?? "";
  out.business_name = lead.business_name;
  out.gbp_link = lead.gbp_link;
  out.city = lead.city;
  out.email = lead.emails.join(", ");
  return out;
}

export function LeadDialog({
  id,
  agents,
  onClose,
  onChanged,
}: {
  id: string;
  agents: Record<string, string>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [form, setForm] = useState<Record<LeadField, string> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const show = useCallback((found: LeadDetail) => {
    setLead(found);
    setForm(valuesOf(found));
  }, []);

  useEffect(() => {
    api
      .lead(id)
      .then(show)
      .catch((err: unknown) =>
        setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not loaded." }),
      );
  }, [id, show]);

  /** Save the fields that changed (or a fix's changes); Lead Check runs again at once. */
  async function send(patch: LeadPatch, done: string) {
    setBusy(true);
    setErrors({});
    setNotice(null);
    try {
      show(await api.updateLead(id, patch));
      setNotice({ kind: "success", text: done });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setNotice({ kind: "error", text: err.message });
      }
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!lead || !form) return;
    const before = valuesOf(lead);
    const patch: LeadPatch = {};
    for (const key of LEAD_FIELDS) if (form[key] !== before[key]) patch[key] = form[key];
    void send(patch, "Saved.");
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteLead(id);
      onChanged();
      onClose();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not deleted." });
      setBusy(false);
    }
  }

  const title = lead ? lead.business_name || lead.lead_id : id;
  return (
    <Modal title={title} onClose={onClose} wide>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {lead && (
        <div className="stack">
          <p className="muted small">
            {lead.lead_id} · {lead.city} · {lead.niche} · {lead.batch_name ?? "no batch"}
            {lead.gbp_link && (
              <>
                {" · "}
                <a href={lead.gbp_link} target="_blank" rel="noreferrer noopener">
                  Google profile
                </a>
              </>
            )}
          </p>
          {lead.held && (
            <Alert kind="error">
              Lead Check holds this lead&apos;s file back: agents wait for every lead of the file
              until all its errors are fixed.
            </Alert>
          )}
          {(lead.check ?? []).length > 0 && (
            <div className="card stack-tight" role="region" aria-label="Problems">
              <p className="cell-strong">Lead Check</p>
              <ul className="check-list">
                {(lead.check ?? []).map((item) => (
                  <li key={`${item.code}:${item.field}`}>
                    {item.severity === "error" ? "🔴" : "🟠"}{" "}
                    <strong>{FIELD_NAMES[item.field] ?? item.field}:</strong> {item.message}
                    {lead.can_edit && item.fix && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="button button-small"
                          disabled={busy}
                          onClick={() => void send(item.fix?.changes ?? {}, "Fixed.")}
                        >
                          {item.fix.label}
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <dl className="lead-facts">
            {Object.entries(lead.extra ?? {}).map(([name, text]) => (
              <div key={`extra:${name}`}>
                <dt>{name}</dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>

          <h3>What the agents found</h3>
          {Object.keys(lead.results).length === 0 && (
            <p className="muted small">No agent has checked this lead yet.</p>
          )}
          {Object.entries(lead.results).map(([key, result]) => (
            <div key={key} className="card stack lead-result">
              <p className="cell-strong">
                {agents[key] ?? key}: {result.status}
                {result.score !== null && ` · score ${result.score}`}
              </p>
              {result.summary && <p>{result.summary}</p>}
              <p className="muted small">Checked {when(result.at)}</p>
            </div>
          ))}
          {lead.files.length > 0 && (
            <ul className="small">
              {lead.files.map((file) => (
                <li key={file.id}>
                  <a href={`/api/leads/${lead.lead_id}/files/${file.id}`} download={file.name}>
                    {file.name}
                  </a>{" "}
                  <span className="muted">
                    ({agents[file.agent_key] ?? file.agent_key}, {size(file.size)})
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h3>Details</h3>
          <form className="stack" onSubmit={save} aria-label="Lead details" noValidate>
            <fieldset disabled={!lead.can_edit || busy} className="stack plain">
              <div className="connection-fields">
                {form &&
                  LEAD_FIELDS.filter((key) => key !== "notes").map((key) => {
                    const problem = (lead.check ?? []).find((i) => i.field === key);
                    return (
                      <Field
                        key={key}
                        label={key === "email" ? "Email(s)" : (FIELD_NAMES[key] ?? key)}
                        value={form[key]}
                        error={errors[key] ?? (problem ? problem.message : undefined)}
                        onChange={(e) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f))}
                      />
                    );
                  })}
              </div>
              {lead.level === "Top" && (
                <p className="small">
                  <span className="pill pill-top">Top</span> Never audited or contacted. Top is
                  chosen in the batch&apos;s Cities tab.
                </p>
              )}
              <div className="field">
                <label htmlFor="lead-notes">Notes</label>
                <textarea
                  id="lead-notes"
                  rows={3}
                  value={form?.notes ?? ""}
                  onChange={(e) => setForm((f) => (f ? { ...f, notes: e.target.value } : f))}
                />
              </div>
            </fieldset>
            {lead.can_edit && (
              <div className="row">
                <button className="button button-primary" disabled={busy}>
                  Save
                </button>
                {confirmDelete ? (
                  <button
                    type="button"
                    className="button button-danger"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    Delete {lead.lead_id} for good
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete this lead
                  </button>
                )}
              </div>
            )}
          </form>
        </div>
      )}
    </Modal>
  );
}
