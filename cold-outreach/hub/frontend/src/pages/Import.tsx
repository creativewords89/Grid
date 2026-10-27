import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type LeadImport, type LeadList } from "../api";
import { useAuth } from "../auth";
import { Alert } from "../components/ui";
import { when } from "../format";

// Import (SPEC sections 6.4 and 7): upload a lead file, check the preview, send it to the
// Master Sheet. Then the lists (City + Niche) it created, each with an on/off switch.

const STATUS: Record<LeadImport["status"], string> = {
  preview: "Waiting for confirm",
  confirmed: "Sent to the Master Sheet",
  failed: "Failed",
  discarded: "Discarded",
};

export function Import() {
  const { user } = useAuth();
  const [imports, setImports] = useState<LeadImport[]>([]);
  const [lists, setLists] = useState<LeadList[]>([]);
  const [current, setCurrent] = useState<LeadImport | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .imports()
      .then((found) => {
        setImports(found);
        setCurrent((shown) => shown ?? found.find((i) => i.status === "preview") ?? null);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
    api
      .lists()
      .then(setLists)
      .catch(() => setLists([]));
  }, []);
  useEffect(load, [load]);

  if (!user) return null;
  const staff = user.role === "owner" || user.role === "admin";

  return (
    <section className="page">
      <h1>Import</h1>
      {error && <Alert kind="error">{error}</Alert>}
      {staff && !current && <UploadForm onRead={setCurrent} />}
      {current && (
        <PreviewCard
          item={current}
          staff={staff}
          onDone={(finished) => {
            // Keep showing what was sent; a discarded file closes.
            setCurrent(finished.status === "discarded" ? null : finished);
            load();
          }}
          onClose={() => setCurrent(null)}
        />
      )}
      <History imports={imports} onOpen={setCurrent} />
      <Lists lists={lists} staff={staff} onChange={load} />
    </section>
  );
}

function UploadForm({ onRead }: { onRead: (item: LeadImport) => void }) {
  const [niche, setNiche] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [niches, setNiches] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .niches()
      .then(setNiches)
      .catch(() => setNiches([]));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setErrors({ file: "Choose the Excel file." });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      onRead(await api.uploadLeads(file, niche));
    } catch (err) {
      if (err instanceof ApiError) setErrors({ form: err.message, ...err.fields });
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit} aria-label="Upload a lead file" noValidate>
      <h2>Upload a lead file</h2>
      <p className="muted">
        An Excel file (.xlsx) with one tab per city, as you build them now: Business name, MAP,
        Address, City, Website, Phone, WA, Facebook, Instagram, Email, Reviews, Average, and an
        optional Level column (write Top for businesses we never contact). Nothing is sent to the
        Master Sheet until you confirm the preview.
      </p>
      {errors.form && <Alert kind="error">{errors.form}</Alert>}
      <div className="connection-fields">
        <div className="field">
          <label htmlFor="import-niche">Niche (one per file)</label>
          <input
            id="import-niche"
            list="known-niches"
            placeholder="Cleaning"
            value={niche}
            aria-invalid={errors.niche ? true : undefined}
            onChange={(e) => setNiche(e.target.value)}
          />
          <datalist id="known-niches">
            {niches.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {errors.niche && <p className="field-error">{errors.niche}</p>}
        </div>
        <div className="field">
          <label htmlFor="import-file">Excel file</label>
          <input
            id="import-file"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-invalid={errors.file ? true : undefined}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {errors.file && <p className="field-error">{errors.file}</p>}
        </div>
      </div>
      <div>
        <button className="button button-primary" disabled={busy}>
          {busy ? "Reading the file… (a big file takes up to a minute)" : "Read the file"}
        </button>
      </div>
    </form>
  );
}

function Count({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`count ${warn && value > 0 ? "count-warn" : ""}`}>
      <span className="count-value">{value.toLocaleString()}</span>
      <span className="muted small">{label}</span>
    </div>
  );
}

function Details({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <details>
      <summary>{title}</summary>
      <ul className="small">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </details>
  );
}

function PreviewCard({
  item,
  staff,
  onDone,
  onClose,
}: {
  item: LeadImport;
  staff: boolean;
  onDone: (item: LeadImport) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const { counts, preview } = item;
  const waiting = item.status === "preview";

  async function act(kind: "confirm" | "discard") {
    setBusy(kind);
    setError("");
    try {
      onDone(
        kind === "confirm" ? await api.confirmImport(item.id) : await api.discardImport(item.id),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Didn't work.");
      setBusy("");
    }
  }

  const unknown = Object.entries(preview.unknown_columns ?? {}).map(
    ([column, tabs]) => `${column} (in ${tabs.length} tab${tabs.length === 1 ? "" : "s"})`,
  );
  return (
    <article className="card stack" aria-label="Preview">
      <div className="agent-head">
        <div>
          <h2>{item.file_name}</h2>
          <p className="muted small">
            {item.niche} · {STATUS[item.status]} · read {when(item.created_at)}
            {item.uploaded_by && ` by ${item.uploaded_by}`}
          </p>
        </div>
        <button className="button" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {item.status === "confirmed" && (
        <Alert kind="success">
          Sent: {counts.sheet_added ?? 0} rows added and {counts.sheet_updated ?? 0} updated in the
          Master Sheet.
        </Alert>
      )}
      <div className="counts">
        <Count label="businesses" value={counts.leads} />
        <Count label="new" value={counts.new} />
        <Count label="already known (updated)" value={counts.updated} />
        <Count label="duplicates merged" value={counts.merged} />
        <Count label="Top (never contacted)" value={counts.top} />
        <Count label="cities" value={counts.cities} />
        <Count label="without a GBP link" value={counts.no_gbp_link} warn />
        <Count label="without a website" value={counts.no_website} />
        <Count label="rows skipped" value={counts.skipped_rows} warn />
        <Count label="emails that look wrong" value={counts.invalid_emails} warn />
      </div>
      {!preview.has_level_column && (
        <p className="muted small">
          This file has no Level column, so no business is marked Top and existing Top marks stay as
          they are.
        </p>
      )}
      <Details title="New lists (City + Niche)" items={preview.new_lists ?? []} />
      <Details title="Already known, will be updated" items={preview.updated ?? []} />
      <Details
        title="Duplicate rows merged into one business"
        items={(preview.merged_rows ?? []).map((rows) => rows.join(" + "))}
      />
      <Details title="Top businesses" items={preview.top ?? []} />
      <Details
        title="Without a GBP link (the GBP agent skips them)"
        items={preview.no_gbp_link ?? []}
      />
      <Details title="Rows skipped (no name and no GBP link)" items={preview.skipped_rows ?? []} />
      <Details title="Emails that look wrong (left out)" items={preview.invalid_emails ?? []} />
      <Details title="Columns that were ignored" items={unknown} />
      <Details title="Empty tabs" items={preview.empty_tabs ?? []} />
      {waiting && staff && (
        <div className="row">
          <button
            className="button button-primary"
            disabled={busy !== ""}
            onClick={() => void act("confirm")}
          >
            {busy === "confirm"
              ? "Sending to the Master Sheet…"
              : `Send ${counts.leads.toLocaleString()} businesses to the Master Sheet`}
          </button>
          <button className="button" disabled={busy !== ""} onClick={() => void act("discard")}>
            Discard
          </button>
        </div>
      )}
    </article>
  );
}

function History({
  imports,
  onOpen,
}: {
  imports: LeadImport[];
  onOpen: (item: LeadImport) => void;
}) {
  if (imports.length === 0) return null;
  return (
    <div className="card table-card">
      <table className="table">
        <caption className="table-caption">Past imports</caption>
        <thead>
          <tr>
            <th>File</th>
            <th>Niche</th>
            <th>Status</th>
            <th>Businesses</th>
            <th className="hide-narrow">When</th>
          </tr>
        </thead>
        <tbody>
          {imports.map((item) => (
            <tr key={item.id}>
              <td>
                <button className="link-button" onClick={() => onOpen(item)}>
                  {item.file_name}
                </button>
              </td>
              <td>{item.niche}</td>
              <td>{STATUS[item.status]}</td>
              <td>{item.counts.leads?.toLocaleString()}</td>
              <td className="hide-narrow">
                {when(item.created_at)}
                {item.uploaded_by && ` · ${item.uploaded_by}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Lists({
  lists,
  staff,
  onChange,
}: {
  lists: LeadList[];
  staff: boolean;
  onChange: () => void;
}) {
  const [error, setError] = useState("");
  if (lists.length === 0) return null;

  async function toggle(item: LeadList, active: boolean) {
    setError("");
    try {
      await api.updateList(item.id, { active });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not saved.");
    }
  }

  return (
    <div className="card table-card">
      {error && <Alert kind="error">{error}</Alert>}
      <table className="table">
        <caption className="table-caption">
          Lists: switch one off and the agents leave its businesses alone
        </caption>
        <thead>
          <tr>
            <th>City</th>
            <th>Niche</th>
            <th>Businesses</th>
            <th>Top</th>
            <th>On</th>
          </tr>
        </thead>
        <tbody>
          {lists.map((item) => (
            <tr key={item.id} className={item.active ? undefined : "row-muted"}>
              <td>{item.city}</td>
              <td>{item.niche}</td>
              <td>{item.leads}</td>
              <td>{item.top}</td>
              <td>
                <label className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={item.active}
                    disabled={!staff}
                    aria-label={`${item.city} · ${item.niche} on or off`}
                    onChange={(e) => void toggle(item, e.target.checked)}
                  />
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
