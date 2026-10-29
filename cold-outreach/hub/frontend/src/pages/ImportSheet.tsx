import { useEffect, useState } from "react";
import { api, ApiError, type ImportSheet, type SheetRow, type SheetStatus } from "../api";
import { Alert } from "../components/ui";

// A lead file tab by tab, like Excel (SPEC section 6.4): a bar with every tab, then that
// tab's rows with every column in the file's order and what happens (or happened) to each.

const STATUS_LABEL: Record<SheetStatus, string> = {
  new: "New",
  updated: "Updated",
  other_batch: "In another batch",
  merged: "Merged",
  top: "Top",
  skipped: "Skipped",
};

function value(row: SheetRow, key: string): string {
  return key.startsWith("extra:") ? (row.extra[key.slice(6)] ?? "") : (row.values[key] ?? "");
}

export function SheetView({ importId, saved }: { importId: string; saved: boolean }) {
  const [tab, setTab] = useState("");
  const [status, setStatus] = useState<SheetStatus | "">("");
  const [page, setPage] = useState(1);
  const [sheet, setSheet] = useState<ImportSheet | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .importSheet(importId, { tab, status, page })
      .then(setSheet)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [importId, tab, status, page]);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!sheet) return null;
  if (!sheet.kept) {
    return (
      <p className="muted small">
        This file was saved before the Hub kept files tab by tab, so only its counts are shown.
      </p>
    );
  }
  const total = sheet.tabs.reduce((sum, t) => sum + t.rows, 0);
  return (
    <section className="stack sheet" aria-label="The file, tab by tab">
      <h3>{saved ? "The file, tab by tab (as the leads are now)" : "The file, tab by tab"}</h3>
      <div className="sheet-tabs" role="tablist" aria-label="Tabs of the file">
        {[{ name: "", rows: total }, ...sheet.tabs].map((t) => (
          <button
            key={t.name || "all"}
            role="tab"
            aria-selected={tab === t.name}
            className={t.rows === 0 ? "sheet-tab-empty" : undefined}
            onClick={() => {
              setTab(t.name);
              setPage(1);
            }}
          >
            {t.name || "All tabs"} <span className="muted">({t.rows.toLocaleString()})</span>
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor={`sheet-status-${importId}`}>Show</label>
        <select
          id={`sheet-status-${importId}`}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as SheetStatus | "");
            setPage(1);
          }}
        >
          <option value="">Every row</option>
          {(Object.keys(STATUS_LABEL) as SheetStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]} ({sheet.statuses[s].toLocaleString()})
            </option>
          ))}
        </select>
      </div>
      {sheet.rows.length === 0 ? (
        <p className="muted small">No rows here.</p>
      ) : (
        <div className="card table-card table-scroll">
          <table className="table leads-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>{saved ? "What happened" : "What happens"}</th>
                {sheet.columns.map((c) => (
                  <th key={c.key} className={c.key === "business_name" ? "sticky-col" : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr
                  key={`${row.tab}-${row.line}`}
                  className={row.status === "skipped" || row.deleted ? "row-muted" : undefined}
                >
                  <td className="small">
                    {row.tab} {row.line}
                  </td>
                  <td className="small">
                    <span className={`pill pill-sheet-${row.status}`}>
                      {STATUS_LABEL[row.status]}
                    </span>
                    {row.merged && <span className="pill">Merged</span>}
                    {row.top && <span className="pill pill-top">Top</span>}
                    {row.lead_id && <span className="muted"> {row.lead_id}</span>}
                    {row.deleted && <span className="muted"> (deleted)</span>}
                  </td>
                  {sheet.columns.map((c) => {
                    const text = value(row, c.key);
                    const original = row.raw[c.key];
                    const bad = c.key === "email" && row.bad_emails.length > 0;
                    // Lead Check (step 26): what is wrong in this cell.
                    const found = (row.issues ?? []).filter((i) => i.field === c.key);
                    const wrong = found.some((i) => i.severity === "error");
                    const notes = [
                      ...found.map((i) => `${i.severity === "error" ? "🔴" : "🟠"} ${i.message}`),
                      ...(original ? [`In the file: ${original}`] : []),
                    ];
                    return (
                      <td
                        key={c.key}
                        className={`small ${c.key === "business_name" ? "sticky-col" : ""} ${wrong ? "cell-problem" : ""}`}
                        title={notes.join("\n") || undefined}
                      >
                        <span
                          className={c.key === "address" || c.key === "notes" ? "cell-wrap" : ""}
                        >
                          {text || <span className="muted">—</span>}
                        </span>
                        {original && (
                          <span className="changed-mark" aria-label="changed by the Hub">
                            {" "}
                            *
                          </span>
                        )}
                        {bad && (
                          <span className="field-error">
                            {" "}
                            Not an email: {row.bad_emails.join(", ")}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sheet.pages > 1 && (
        <div className="row">
          <button className="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="small">
            Page {sheet.page} of {sheet.pages}
          </span>
          <button
            className="button"
            disabled={page >= sheet.pages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      )}
      {!saved && (
        <p className="muted small">
          A cell marked * was cleaned by the Hub: point at it to see what the file says.
        </p>
      )}
    </section>
  );
}
