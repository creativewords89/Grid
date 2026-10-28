import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  leadQuery,
  type LeadDetail,
  type LeadFilters,
  type LeadPage,
  type LeadPatch,
} from "../api";
import { Alert, Field, Modal } from "../components/ui";
import { when } from "../format";

// Leads (SPEC sections 6.4 and 7): every business the Hub keeps, like a spreadsheet. Search,
// filter, sort, page through 100 at a time, download what is shown as Excel, and open a lead
// to see the agents' results and files, or (Owners and Admins) change or delete it. The
// table shows every field of the lead file side by side; the Lists (City + Niche) follow.

const SORTS: [NonNullable<LeadFilters["sort"]>, string][] = [
  ["lead_id", "Lead ID"],
  ["newest", "Newest first"],
  ["name", "Business name"],
  ["city", "City"],
];

/** A batch's leads (SPEC section 6.4 item 9): its own tab on the batch page. */
export function BatchLeads({ batchId, city = "" }: { batchId: string; city?: string }) {
  const [filters, setFilters] = useState<LeadFilters>({ batch_id: batchId, city });
  const [typed, setTyped] = useState({ q: "", city });
  const [data, setData] = useState<LeadPage | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");

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

  const agents = Object.entries(data?.agents ?? {});
  const shown: LeadFilters = { ...filters, page: undefined };
  const sortValue = filters.sort === "score" ? `score:${filters.score_of}` : (filters.sort ?? "");

  return (
    <div className="stack">
      <form className="filters-row" onSubmit={search} aria-label="Find leads">
        <Field
          label="Search"
          placeholder="Name, email, phone, website…"
          value={typed.q}
          onChange={(e) => setTyped((t) => ({ ...t, q: e.target.value }))}
        />
        <Field
          label="City"
          value={typed.city}
          onChange={(e) => setTyped((t) => ({ ...t, city: e.target.value }))}
        />
        <div className="field">
          <label htmlFor="leads-level">Top</label>
          <select
            id="leads-level"
            value={filters.level ?? ""}
            onChange={(e) => change({ level: e.target.value as LeadFilters["level"] })}
          >
            <option value="">All</option>
            <option value="top">Top only</option>
            <option value="not_top">Not Top</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="leads-website">Website</label>
          <select
            id="leads-website"
            value={filters.website ?? ""}
            onChange={(e) => change({ website: e.target.value as LeadFilters["website"] })}
          >
            <option value="">All</option>
            <option value="yes">Has a website</option>
            <option value="no">No website</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="leads-sort">Sort by</label>
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
                {label}
              </option>
            ))}
            {agents.map(([key, label]) => (
              <option key={key} value={`score:${key}`}>
                {label} score (best first)
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="label-spacer" aria-hidden="true">
            &nbsp;
          </span>
          <button className="button">Search</button>
        </div>
        <div className="field">
          <span className="label-spacer" aria-hidden="true">
            &nbsp;
          </span>
          <a className="button" href={`/api/leads/export${leadQuery(shown)}`} download>
            Download Excel
          </a>
        </div>
      </form>
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <p className="muted small">
          {data.total.toLocaleString()} {data.total === 1 ? "lead" : "leads"}
          {data.pages > 1 && ` · page ${data.page} of ${data.pages}`}
        </p>
      )}
      {data?.total === 0 && <p className="muted">No leads match.</p>}
      {data && data.leads.length > 0 && (
        <div className="card table-card table-scroll table-tall">
          <table className="table leads-table">
            <thead>
              <tr>
                <th>Lead ID</th>
                <th className="sticky-col">Business name</th>
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
                <tr key={lead.lead_id}>
                  <td className="small nowrap">{lead.lead_id}</td>
                  <td className="sticky-col">
                    <button
                      className="link-button cell-strong"
                      onClick={() => setOpen(lead.lead_id)}
                    >
                      {lead.business_name || lead.lead_id}
                    </button>
                  </td>
                  {COLUMNS.map(([key]) => (
                    <td key={key} className="small">
                      <Cell lead={lead} field={key} />
                    </td>
                  ))}
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
        <div className="row">
          <button
            className="button"
            disabled={data.page <= 1}
            onClick={() => setFilters((f) => ({ ...f, page: data.page - 1 }))}
          >
            Previous
          </button>
          <button
            className="button"
            disabled={data.page >= data.pages}
            onClick={() => setFilters((f) => ({ ...f, page: data.page + 1 }))}
          >
            Next
          </button>
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
  ["level", "Level"],
  ["notes", "Notes"],
];
const LINKS = new Set(["gbp_link", "website", "facebook", "instagram"]);

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
  return (
    <span className={field === "notes" || field === "address" ? "cell-wrap" : "nowrap"}>
      {value}
    </span>
  );
}

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;
}

const SHOWN: [string, string][] = [
  ["address", "Address"],
  ["whatsapp", "WhatsApp"],
  ["facebook", "Facebook"],
  ["instagram", "Instagram"],
  ["reviews", "Reviews (from the file)"],
  ["rating", "Rating (from the file)"],
];

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
  const [form, setForm] = useState<Required<LeadPatch>>({
    email: "",
    phone: "",
    website: "",
    level: "",
    notes: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const show = useCallback((found: LeadDetail) => {
    setLead(found);
    setForm({
      email: found.emails.join(", "),
      phone: found.data.phone ?? "",
      website: found.data.website ?? "",
      level: found.level === "Top" ? "Top" : "",
      notes: found.data.notes ?? "",
    });
  }, []);

  useEffect(() => {
    api
      .lead(id)
      .then(show)
      .catch((err: unknown) =>
        setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not loaded." }),
      );
  }, [id, show]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setNotice(null);
    try {
      show(await api.updateLead(id, form));
      setNotice({ kind: "success", text: "Saved." });
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
          <dl className="lead-facts">
            {SHOWN.filter(([key]) => lead.data[key]).map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{lead.data[key]}</dd>
              </div>
            ))}
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
                <Field
                  label="Email(s)"
                  value={form.email}
                  error={errors.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                />
                <Field
                  label="Phone"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                />
                <Field
                  label="Website"
                  value={form.website}
                  onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
                />
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.level === "Top"}
                  onChange={(e) => setForm((f) => ({ ...f, level: e.target.checked ? "Top" : "" }))}
                />
                Top (never contacted)
              </label>
              <div className="field">
                <label htmlFor="lead-notes">Notes</label>
                <textarea
                  id="lead-notes"
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
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
