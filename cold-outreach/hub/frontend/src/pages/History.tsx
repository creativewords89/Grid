import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type HistoryEntry } from "../api";
import { Alert } from "../components/ui";
import { when } from "../format";

// History (SPEC sections 3 and 7, Owners only): who did what, newest first. Keys and
// passwords are never in it: a connection change only says "(changed)".

const ENTITIES: Record<string, string> = {
  agent: "Agents",
  alert_settings: "Alert settings",
  benchmark: "Benchmarks (deleted)",
  benchmarks: "Benchmarks (uploads)",
  budget: "Budget",
  connections: "Connections",
  import: "Imports",
  list: "Lists",
  user: "Users",
  website_standard: "Website Standards",
};

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function Changes({ changes }: { changes: Record<string, unknown>[] }) {
  if (changes.length === 0) return null;
  return (
    <ul className="small muted history-changes">
      {changes.map((change, index) =>
        "field" in change ? (
          <li key={index}>
            {String(change.field)}: {show(change.from)} → {show(change.to)}
          </li>
        ) : (
          <li key={index}>
            {Object.entries(change)
              .map(([name, value]) => `${name}: ${show(value)}`)
              .join(", ")}
          </li>
        ),
      )}
    </ul>
  );
}

export function History() {
  const [entity, setEntity] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    (before?: string) => {
      api
        .history({ entity, before })
        .then((page) => {
          setError("");
          setEntries((shown) => (before && shown ? [...shown, ...page.entries] : page.entries));
          setMore(page.more);
        })
        .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
    },
    [entity],
  );
  useEffect(() => load(), [load]);

  return (
    <section className="page">
      <h1>History</h1>
      <div className="row filters">
        <div className="field">
          <label htmlFor="history-entity">What</label>
          <select id="history-entity" value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">Everything</option>
            {Object.entries(ENTITIES).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {entries?.length === 0 && <p className="muted">Nothing yet.</p>}
      {entries && entries.length > 0 && (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{when(entry.at)}</td>
                  <td>{entry.actor ?? <span className="muted">the Hub</span>}</td>
                  <td>
                    <span className="cell-strong">{entry.action.replace("_", " ")}</span>{" "}
                    {ENTITIES[entry.entity]?.toLowerCase() ?? entry.entity}
                    {entry.title && <> · {entry.title}</>}
                    <Changes changes={entry.changes} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && entries && (
        <button className="button" onClick={() => load(entries[entries.length - 1]?.at)}>
          Show older
        </button>
      )}
    </section>
  );
}
