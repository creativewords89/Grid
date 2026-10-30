import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Agent, type Run } from "../api";
import { Alert } from "../components/ui";
import { money, when } from "../format";
import { RUN_STATUS } from "../labels";

// Runs (SPEC section 7): every run, newest first, filtered by agent and status.

const STATUSES = Object.keys(RUN_STATUS) as Run["status"][];

export function Runs() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agent, setAgent] = useState("");
  const [status, setStatus] = useState("");
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .agents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  const load = useCallback(
    (before?: string) => {
      api
        .runs({ agent, status, before })
        .then((page) => {
          setError("");
          setRuns((shown) => (before && shown ? [...shown, ...page.runs] : page.runs));
          setMore(page.more);
        })
        .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
    },
    [agent, status],
  );
  useEffect(() => load(), [load]);

  return (
    <section className="page">
      <div className="page-head">
        <h1>Runs</h1>
        <button className="button" onClick={() => load()}>
          Refresh
        </button>
      </div>
      <div className="row filters">
        <div className="field">
          <label htmlFor="runs-agent">Agent</label>
          <select id="runs-agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.key} value={a.key}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="runs-status">Status</label>
          <select id="runs-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {RUN_STATUS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {runs?.length === 0 && <p className="muted">No runs yet.</p>}
      {runs && runs.length > 0 && (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Started</th>
                <th>Status</th>
                <th>Done · failed · skipped</th>
                <th>Cost</th>
                <th className="hide-narrow">How</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="cell-strong">{run.agent_name}</td>
                  <td>{when(run.started_at ?? run.queued_at)}</td>
                  <td>
                    <span className={`pill pill-run-${run.status}`}>{RUN_STATUS[run.status]}</span>
                    {run.stop_reason && <div className="muted small">{run.stop_reason}</div>}
                  </td>
                  <td>
                    {run.done} · {run.failed} · {run.skipped}
                  </td>
                  <td>{money(run.cost_usd)}</td>
                  <td className="hide-narrow muted small">
                    {run.trigger === "schedule"
                      ? "Scheduled"
                      : `${run.trigger === "test" ? "Test" : "Run now"}${run.requested_by ? ` by ${run.requested_by}` : ""}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && runs && (
        <button className="button" onClick={() => load(runs[runs.length - 1]?.queued_at)}>
          Show older runs
        </button>
      )}
    </section>
  );
}
