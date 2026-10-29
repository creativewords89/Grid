import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type CheckReport } from "../api";
import { FIELD_NAMES } from "../checkLabels";
import { LeadDialog } from "../pages/Leads";
import { FixFileButtons } from "./FixFile";
import { Alert, Modal } from "./ui";

// A saved file's Lead Check report (SPEC step 26): held or clear, problems by city, the
// tabs' column problems and every problem of its leads, each lead opening to be fixed.

export function CheckReportDialog({
  importId,
  batchId,
  staff,
  onClose,
  onChanged,
}: {
  importId: string;
  batchId: string;
  staff: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [report, setReport] = useState<CheckReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(true);

  const load = useCallback(() => {
    api
      .checkReport(importId)
      .then(setReport)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [importId]);
  useEffect(load, [load]);

  async function again() {
    setBusy(true);
    try {
      setReport(await api.checkAgain(importId));
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const shown = (report?.issues ?? []).filter((i) => !onlyErrors || i.severity === "error");
  return (
    <Modal title={`Lead Check: ${report?.file_name ?? "…"}`} onClose={onClose} wide>
      {error && <Alert kind="error">{error}</Alert>}
      {report && (
        <div className="stack">
          {report.held ? (
            <Alert kind="error">
              🔴 {report.errors} {report.errors === 1 ? "error" : "errors"}: agents wait for every
              lead of this file until they are fixed. Open a lead to fix it, or fix the Excel file
              and add it again.
            </Alert>
          ) : (
            <Alert kind="success">
              ✅ No errors: agents can work on this file&apos;s leads.
              {report.warnings > 0 && ` ${report.warnings} warnings to look at.`}
            </Alert>
          )}
          <div className="row">
            <FixFileButtons
              href={`/api/imports/${importId}/fixes.xlsx`}
              batchId={batchId}
              staff={staff}
              onSaved={() => {
                load();
                onChanged();
              }}
            />
            {staff && (
              <button className="button" disabled={busy} onClick={() => void again()}>
                Check again
              </button>
            )}
          </div>
          {report.cities.length > 0 && (
            <table className="table compact-table" aria-label="Problems by city">
              <thead>
                <tr>
                  <th>City</th>
                  <th>🔴 Errors</th>
                  <th>🟠 Warnings</th>
                </tr>
              </thead>
              <tbody>
                {report.cities.map((c) => (
                  <tr key={c.city}>
                    <td>{c.city}</td>
                    <td>{c.errors}</td>
                    <td>{c.warnings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {Object.keys(report.tabs).length > 0 && (
            <div className="stack-tight" role="region" aria-label="Columns of each tab">
              <p className="cell-strong">The file&apos;s columns</p>
              <ul className="check-list small">
                {Object.entries(report.tabs).map(([tab, items]) => (
                  <li key={tab}>
                    🟠 <strong>{tab}:</strong>{" "}
                    {items
                      .map((i) => `${i.message} (${FIELD_NAMES[i.field] ?? i.field})`)
                      .join("; ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report.issues.length > 0 && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={onlyErrors}
                  onChange={(e) => setOnlyErrors(e.target.checked)}
                />
                Errors only
              </label>
              <div className="table-scroll table-tall">
                <table className="table compact-table" aria-label="Problems">
                  <thead>
                    <tr>
                      <th />
                      <th>City</th>
                      <th>Business</th>
                      <th>Column</th>
                      <th>Problem</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((i) => (
                      <tr key={`${i.lead_id}:${i.code}`}>
                        <td>{i.severity === "error" ? "🔴" : "🟠"}</td>
                        <td>{i.city}</td>
                        <td>
                          <button className="link-button" onClick={() => setOpen(i.lead_id)}>
                            {i.business_name || i.lead_id}
                          </button>
                        </td>
                        <td>{FIELD_NAMES[i.field] ?? i.field}</td>
                        <td>{i.message}</td>
                        <td className="small cell-wrap">{i.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
      {open && (
        <LeadDialog
          id={open}
          agents={{}}
          onClose={() => setOpen(null)}
          onChanged={() => {
            load();
            onChanged();
          }}
        />
      )}
    </Modal>
  );
}
