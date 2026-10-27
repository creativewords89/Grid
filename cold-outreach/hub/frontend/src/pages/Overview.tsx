import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type AlertSettings, type HubAlert, type Overview as Data } from "../api";
import { Alert, Field } from "../components/ui";
import { HealthStatus } from "../HealthStatus";
import { ago, money, when } from "../format";
import { RUN_STATUS } from "../labels";
import { navigate } from "../router";

// Overview (SPEC section 7): today's and this month's cost against the budget, and each
// agent's last and next run.

export function Overview() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api
      .overview()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, []);
  useEffect(load, [load]);

  const used = data ? Number(data.spent_today_usd) / Number(data.daily_total_budget_usd || 1) : 0;
  return (
    <section className="page">
      <h1>Overview</h1>
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <div className="stat-row">
            <div className="card stat">
              <p className="muted small">Spent today</p>
              <p className="stat-value">{money(data.spent_today_usd)}</p>
              <p className="muted small">
                of {money(data.daily_total_budget_usd)} for all agents
                {used >= 1 && " · used up: agents stop until tomorrow"}
              </p>
              <div
                className="meter"
                role="meter"
                aria-label="Share of today's total budget spent"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(100, Math.round(used * 100))}
              >
                <span style={{ width: `${Math.min(100, used * 100)}%` }} />
              </div>
            </div>
            <div className="card stat">
              <p className="muted small">This month</p>
              <p className="stat-value">{money(data.spent_this_month_usd)}</p>
              <p className="muted small">"Today" is in {data.time_zone}</p>
            </div>
          </div>
          {data.can_change &&
            (editing ? (
              <BudgetForm
                data={data}
                onClose={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false);
                  load();
                }}
              />
            ) : (
              <p>
                <button className="button" onClick={() => setEditing(true)}>
                  Change the total budget
                </button>
              </p>
            ))}
          <div className="card table-card">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Last run</th>
                  <th>Next run</th>
                  <th>Spent today</th>
                </tr>
              </thead>
              <tbody>
                {data.agents.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No agents yet.
                    </td>
                  </tr>
                )}
                {data.agents.map((agent) => (
                  <tr key={agent.key}>
                    <td>
                      <a
                        href="/agents"
                        className="cell-strong"
                        onClick={(e) => {
                          e.preventDefault();
                          navigate("/agents");
                        }}
                      >
                        {agent.name}
                      </a>
                      <div className="muted small">
                        {agent.enabled ? "On" : "Off"} ·{" "}
                        {agent.connected ? "connected" : "not connected"}
                      </div>
                    </td>
                    <td>
                      {agent.last_run ? (
                        <>
                          {RUN_STATUS[agent.last_run.status]}
                          <div className="muted small">
                            {ago(
                              agent.last_run.finished_at ??
                                agent.last_run.started_at ??
                                agent.last_run.queued_at,
                            )}{" "}
                            · {agent.last_run.done} done
                          </div>
                        </>
                      ) : (
                        <span className="muted">None yet</span>
                      )}
                    </td>
                    <td>{agent.next_run_at ? when(agent.next_run_at) : "—"}</td>
                    <td>
                      {money(agent.spent_today_usd)}{" "}
                      <span className="muted small">of {money(agent.daily_budget_usd)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <Alerts />
      <HealthStatus />
    </section>
  );
}

function Alerts() {
  const [alerts, setAlerts] = useState<HubAlert[]>([]);
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    api
      .alerts()
      .then(setAlerts)
      .catch(() => setAlerts([]));
    api
      .alertSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  return (
    <div className="card stack" aria-labelledby="recent-alerts">
      <div className="agent-head">
        <h2 id="recent-alerts">Recent alerts</h2>
        {settings?.can_change && !editing && (
          <button className="button" onClick={() => setEditing(true)}>
            Alert settings
          </button>
        )}
      </div>
      {editing && settings && (
        <AlertSettingsForm
          settings={settings}
          onDone={(saved) => {
            if (saved) setSettings(saved);
            setEditing(false);
          }}
        />
      )}
      {alerts.length === 0 ? (
        <p className="muted">No alerts.</p>
      ) : (
        <ul className="alert-list">
          {alerts.map((a) => (
            <li key={a.id}>
              <strong>{a.title}</strong> <span className="muted small">{when(a.created_at)}</span>
              <div className="small">{a.body}</div>
              <div className="muted small">
                {a.sent_at
                  ? `Emailed to ${a.emailed_to}${a.telegram_sent ? " · sent to Telegram" : ""}`
                  : "Waiting to be sent"}
                {a.error && ` · ${a.error}`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AlertSettingsForm({
  settings,
  onDone,
}: {
  settings: AlertSettings;
  onDone: (saved: AlertSettings | null) => void;
}) {
  const [form, setForm] = useState(settings);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save(event: FormEvent) {
    event.preventDefault();
    setErrors({});
    try {
      const { can_change: _ignored, ...body } = form;
      void _ignored;
      onDone(await api.saveAlertSettings(body));
    } catch (err) {
      if (err instanceof ApiError) setErrors({ form: err.message, ...err.fields });
    }
  }

  return (
    <form className="stack" onSubmit={save} aria-label="Alert settings">
      {errors.form && <Alert kind="error">{errors.form}</Alert>}
      <label className="check">
        <input
          type="checkbox"
          checked={form.alerts_telegram}
          onChange={(e) => setForm({ ...form, alerts_telegram: e.target.checked })}
        />
        Send alerts to the Telegram group
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={form.daily_summary}
          onChange={(e) => setForm({ ...form, daily_summary: e.target.checked })}
        />
        A daily summary in the Telegram group
      </label>
      <div className="connection-fields">
        <Field
          label="Summary time (24-hour, the Hub's time zone)"
          type="time"
          value={form.daily_summary_time}
          error={errors.daily_summary_time}
          onChange={(e) => setForm({ ...form, daily_summary_time: e.target.value })}
        />
        <Field
          label="Alert when DataForSEO balance is under (USD)"
          type="number"
          min={0}
          step="0.01"
          value={form.low_balance_usd}
          error={errors.low_balance_usd}
          onChange={(e) => setForm({ ...form, low_balance_usd: e.target.value })}
        />
      </div>
      <div className="row">
        <button className="button button-primary">Save</button>
        <button type="button" className="button" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function BudgetForm({
  data,
  onClose,
  onSaved,
}: {
  data: Data;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [budget, setBudget] = useState(data.daily_total_budget_usd);
  const [zone, setZone] = useState(data.time_zone);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save(event: FormEvent) {
    event.preventDefault();
    setErrors({});
    try {
      await api.setBudget(budget, zone);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) setErrors({ form: err.message, ...err.fields });
    }
  }

  const zones =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return (
    <form className="card stack" onSubmit={save} aria-label="Total budget">
      {errors.form && <Alert kind="error">{errors.form}</Alert>}
      <p className="muted">
        All agents together stop for the day once this is spent. Each agent also has its own budget
        in its settings.
      </p>
      <div className="connection-fields">
        <Field
          label="Total daily budget (USD)"
          type="number"
          min={0}
          step="0.01"
          value={budget}
          error={errors.daily_total_budget_usd}
          onChange={(e) => setBudget(e.target.value)}
        />
        <div className="field">
          <label htmlFor="hub-zone">The Hub's time zone (when "today" starts)</label>
          <select id="hub-zone" value={zone} onChange={(e) => setZone(e.target.value)}>
            {(zones.includes(zone) ? zones : [zone, ...zones]).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          {errors.time_zone && <p className="field-error">{errors.time_zone}</p>}
        </div>
      </div>
      <div className="row">
        <button className="button button-primary">Save</button>
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
