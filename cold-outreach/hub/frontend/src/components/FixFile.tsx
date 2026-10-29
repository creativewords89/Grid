import { useState, type FormEvent } from "react";
import { api, ApiError, type FixResult } from "../api";
import { Alert, Modal } from "./ui";

// Fix files (SPEC step 28): the leads with a Lead Check problem as Excel, each wrong cell red
// (error) or yellow (warning) with a note; fixed offline and uploaded back here. Rows are
// matched by Lead ID; an empty cell clears the field. Nothing is saved before Save.

/** Download problems to fix, and (Owners and Admins) Upload fixes. */
export function FixFileButtons({
  href,
  batchId,
  staff,
  onSaved,
  download = true,
}: {
  href: string;
  batchId: string;
  staff: boolean;
  onSaved: () => void;
  download?: boolean; // false where a Download menu has it already
}) {
  const [uploading, setUploading] = useState(false);
  return (
    <>
      {download && (
        <a className="button" href={href} download>
          Download problems to fix
        </a>
      )}
      {staff && (
        <button type="button" className="button" onClick={() => setUploading(true)}>
          <span aria-hidden="true">⬆</span> Upload fixes
        </button>
      )}
      {uploading && (
        <FixUploadDialog batchId={batchId} onClose={() => setUploading(false)} onSaved={onSaved} />
      )}
    </>
  );
}

function show(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text || "(empty)";
}

export function FixUploadDialog({
  batchId,
  onClose,
  onSaved,
}: {
  batchId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<FixResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(confirm: boolean) {
    if (!file) {
      setError("Choose the fix file.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const found = await api.uploadFixes(batchId, file, confirm);
      setResult(found);
      if (found.saved) onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Didn't work.");
    } finally {
      setBusy(false);
    }
  }

  function check(event: FormEvent) {
    event.preventDefault();
    void send(false);
  }

  return (
    <Modal title="Upload fixes" onClose={onClose} wide>
      <div className="stack">
        {error && <Alert kind="error">{error}</Alert>}
        {!result?.saved && (
          <form className="stack" onSubmit={check} aria-label="Fix file" noValidate>
            <p className="muted small">
              The file from <strong>Download problems to fix</strong>, fixed in Excel. Rows are
              matched by Lead ID; an empty cell clears that field. Nothing is saved until you press
              Save.
            </p>
            <div className="field">
              <label htmlFor="fix-file">Fix file (.xlsx)</label>
              <input
                id="fix-file"
                type="file"
                accept=".xlsx"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setResult(null);
                }}
              />
            </div>
            <div>
              <button className="button" disabled={busy || !file}>
                {busy && !result ? "Reading…" : "Check the file"}
              </button>
            </div>
          </form>
        )}
        {result && (
          <div className="stack" role="region" aria-label="What changes">
            <Alert kind={result.saved ? "success" : result.errors_after > 0 ? "error" : "success"}>
              {result.saved ? "Saved: " : "If you save: "}
              {result.changed.length.toLocaleString()} leads change,{" "}
              {result.unchanged.toLocaleString()} stay as they are. Errors 🔴 {result.errors_before}{" "}
              → {result.errors_after}, warnings 🟠 {result.warnings_after}.{" "}
              {result.held_files_after > 0
                ? `${result.held_files_after} ${result.held_files_after === 1 ? "file stays" : "files stay"} held.`
                : "No file of this batch is held."}
            </Alert>
            {result.refused.length > 0 && (
              <Alert kind="error">
                Not changed (fix them in the file and upload again):{" "}
                {result.refused
                  .map((r) => `${r.tab} row ${r.line} (${r.lead_id}): ${r.field}: ${r.message}`)
                  .join("; ")}
              </Alert>
            )}
            {result.skipped.length > 0 && (
              <p className="small muted">
                Left out:{" "}
                {result.skipped
                  .map(
                    (r) =>
                      `${r.tab} row ${r.line}${r.lead_id ? ` (${r.lead_id})` : ""}: ${r.reason}`,
                  )
                  .join("; ")}
              </p>
            )}
            {result.changed.length > 0 && (
              <div className="table-scroll table-tall">
                <table className="table compact-table" aria-label="Changes">
                  <thead>
                    <tr>
                      <th>Lead</th>
                      <th>City</th>
                      <th>Changes</th>
                      <th>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.changed.map((c) => (
                      <tr key={c.lead_id}>
                        <td className="nowrap">
                          {c.lead_id} · {c.business_name}
                        </td>
                        <td>{c.city}</td>
                        <td className="small">
                          {c.changes.map((x) => (
                            <div key={x.field}>
                              <strong>{x.field}:</strong> {show(x.from)} → {show(x.to)}
                            </div>
                          ))}
                        </td>
                        <td className="nowrap">
                          {c.errors > 0 ? `🔴 ${c.errors}` : "✓"}
                          {c.warnings > 0 && ` 🟠 ${c.warnings}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {result?.saved ? "Done" : "Cancel"}
          </button>
          {result && !result.saved && result.changed.length > 0 && (
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => void send(true)}
            >
              {busy ? "Saving…" : `Save ${result.changed.length.toLocaleString()} changes`}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
