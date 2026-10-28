import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type Agent,
  type AgentSettings,
  type ConfigValue,
  type ManifestSetting,
} from "../api";
import { useAuth } from "../auth";
import { setupState } from "../agentSetup";
import { StartCommands } from "../components/agentSetup";
import { Alert, CopyLink, Field, Modal } from "../components/ui";
import { ago, money, when } from "../format";
import { CONNECTION_NAMES, RUN_STATUS } from "../labels";

// Agents (SPEC sections 6.2 and 7): one card per agent with its switch, last run, Run now
// and a settings form built from the agent's manifest. Hidden buttons are for tidiness
// only: the server checks every action.

type Notice = { kind: "error" | "success"; text: string } | null;

export function Agents() {
  const { user } = useAuth();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState<{ agent: Agent; token: string } | null>(null);

  const load = useCallback(() => {
    api
      .agents()
      .then(setAgents)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, []);
  useEffect(load, [load]);

  if (!user) return null;
  const owner = user.role === "owner";
  const staff = owner || user.role === "admin";
  const replace = (agent: Agent) =>
    setAgents((list) => list?.map((a) => (a.key === agent.key ? agent : a)) ?? null);

  return (
    <section className="page">
      <div className="page-head">
        <h1>Agents</h1>
        {owner && (
          <button className="button button-primary" onClick={() => setAdding(true)}>
            + Add agent
          </button>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {agents?.length === 0 && (
        <div className="card">
          <p className="muted">
            No agents yet.{" "}
            {owner
              ? "Add one to get its token, then start the agent on the server with that token."
              : "An Owner adds them."}
          </p>
        </div>
      )}
      {agents?.map((agent) => (
        <AgentCard
          key={agent.key}
          agent={agent}
          staff={staff}
          owner={owner}
          onChange={replace}
          onReload={load}
          onToken={setToken}
        />
      ))}
      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onAdded={(result) => {
            setAdding(false);
            setToken(result);
            load();
          }}
        />
      )}
      {token && <TokenDialog result={token} onClose={() => setToken(null)} />}
    </section>
  );
}

function AgentCard({
  agent,
  staff,
  owner,
  onChange,
  onReload,
  onToken,
}: {
  agent: Agent;
  staff: boolean;
  owner: boolean;
  onChange: (agent: Agent) => void;
  onReload: () => void;
  onToken: (result: { agent: Agent; token: string }) => void;
}) {
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const last = agent.last_run;
  const running = agent.batches.filter((b) => b.status === "running");
  const setup = setupState(agent);
  const active = last?.status === "queued" || last?.status === "running";

  async function act(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (success) setNotice({ kind: "success", text: success });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Didn't work." });
    } finally {
      setBusy(false);
    }
  }

  const headingId = `agent-${agent.key}`;
  return (
    <article className="card stack" aria-labelledby={headingId}>
      <div className="agent-head">
        <div>
          <h2 id={headingId}>{agent.name}</h2>
          <p className="muted small">
            {agent.key}
            {agent.manifest && ` · version ${agent.manifest.version}`}
          </p>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={agent.enabled}
            disabled={!staff || busy}
            aria-label={`${agent.name} on or off`}
            onChange={(e) =>
              void act(async () => onChange(await api.switchAgent(agent.key, e.target.checked)))
            }
          />
          <span>{agent.enabled ? "On" : "Off"}</span>
        </label>
      </div>
      {agent.manifest?.description && <p>{agent.manifest.description}</p>}
      <p className="small">
        <span className={`dot ${agent.connected ? "dot-ok" : "dot-off"}`} aria-hidden="true" />{" "}
        {agent.connected
          ? "Connected"
          : agent.last_seen_at
            ? `Not connected · last seen ${ago(agent.last_seen_at)}`
            : "Never connected: start the agent on the server with its token"}
      </p>
      <p className={`small ${setup.done ? "" : "setup-next"}`}>Setup: {setup.label}</p>
      {!agent.manifest && !agent.last_seen_at && (
        <details>
          <summary className="small">How to start it</summary>
          <StartCommands agentKey={agent.key} token="PASTE_ITS_TOKEN" />
          <p className="muted small">
            Lost the token? The Owner presses New token: the window shows it with these commands
            filled in.
          </p>
        </details>
      )}
      {agent.missing_connections.length > 0 && (
        <Alert kind="error">
          Needs these connections first:{" "}
          {agent.missing_connections.map((c) => CONNECTION_NAMES[c] ?? c).join(", ")}.
        </Alert>
      )}
      <p className="small">
        {last ? (
          <>
            Last run: <strong>{RUN_STATUS[last.status]}</strong> ·{" "}
            {ago(last.finished_at ?? last.started_at ?? last.queued_at)} · {last.done} done
            {last.failed > 0 && `, ${last.failed} failed`}
            {last.skipped > 0 && `, ${last.skipped} skipped`} · ${Number(last.cost_usd).toFixed(2)}
            {last.stop_reason && ` · ${last.stop_reason}`}
          </>
        ) : (
          "No runs yet."
        )}{" "}
        <span className="muted">
          Runs daily at {agent.run_time} ({agent.time_zone}), up to {agent.daily_limit} items.
        </span>
      </p>
      <p className="small">
        <strong>Does:</strong>{" "}
        {agent.task ? agent.task.name : "its job is known once it first connects"}
      </p>
      <p className="small">
        <strong>Used in:</strong>{" "}
        {agent.batches.length > 0 ? (
          [...running, ...agent.batches.filter((b) => b.status !== "running")]
            .map(
              (b) =>
                `${b.name} · ${b.task_name}${b.status === "running" ? "" : ` (${b.status.replace("_", " ")})`}${b.ready ? "" : " (no benchmark)"}`,
            )
            .join(", ")
        ) : (
          <span className="field-error">
            No batch yet: add it to a task in a batch&apos;s Tasks tab.
          </span>
        )}
        {agent.batches.length > 0 && running.length === 0 && (
          <span className="field-error"> · none of them is running</span>
        )}
      </p>
      <p className="small">
        {agent.next_run_at ? `Next run: ${when(agent.next_run_at)}` : "Off: no scheduled runs"} ·
        Spent today: {money(agent.spent_today_usd)} of {money(agent.daily_budget_usd)}
        {last?.stop_requested && active && " · Stop requested"}
      </p>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      <div className="row">
        {staff && (
          <button
            className="button button-primary"
            disabled={busy || !agent.enabled || !agent.manifest || active}
            onClick={() =>
              void act(async () => {
                await api.runAgent(agent.key);
                onReload();
              }, "Run queued. The agent picks it up within 30 seconds.")
            }
          >
            Run now
          </button>
        )}
        {staff && active && (
          <button
            className="button button-danger"
            disabled={busy || last?.stop_requested}
            onClick={() =>
              void act(async () => {
                await api.stopAgent(agent.key);
                onReload();
              }, "Stop requested. A running agent stops at its next progress report.")
            }
          >
            Stop
          </button>
        )}
        {staff && (
          <button className="button" disabled={busy} onClick={() => setEditing(true)}>
            Settings
          </button>
        )}
        {owner && (
          <button
            className="button"
            disabled={busy}
            onClick={() => void act(async () => onToken(await api.newAgentToken(agent.key)))}
          >
            New token
          </button>
        )}
        <button className="button" disabled={busy} onClick={onReload}>
          Refresh
        </button>
      </div>
      {editing && (
        <SettingsDialog
          agent={agent}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            onChange(saved);
            setNotice({ kind: "success", text: "Settings saved." });
          }}
        />
      )}
    </article>
  );
}

function timeZones(current: string): string[] {
  const zones =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return zones.includes(current) ? zones : [current, ...zones];
}

function SettingsDialog({
  agent,
  onClose,
  onSaved,
}: {
  agent: Agent;
  onClose: () => void;
  onSaved: (agent: Agent) => void;
}) {
  const settings = agent.manifest?.settings ?? [];
  const [values, setValues] = useState<Record<string, ConfigValue>>(agent.config);
  const [limit, setLimit] = useState(String(agent.daily_limit));
  const [runTime, setRunTime] = useState(agent.run_time);
  const [zone, setZone] = useState(agent.time_zone);
  const [budget, setBudget] = useState(agent.daily_budget_usd);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    const body: AgentSettings = {
      config: values,
      daily_limit: Number(limit),
      run_time: runTime,
      time_zone: zone,
      daily_budget_usd: budget,
    };
    try {
      onSaved(await api.updateAgent(agent.key, body));
    } catch (err) {
      if (err instanceof ApiError) setErrors({ form: err.message, ...err.fields });
      setBusy(false);
    }
  }

  return (
    <Modal title={`${agent.name} settings`} onClose={onClose} wide>
      <form onSubmit={save} className="stack" noValidate>
        {errors.form && <Alert kind="error">{errors.form}</Alert>}
        <div className="connection-fields">
          <Field
            label="Items a day (limit)"
            type="number"
            min={1}
            value={limit}
            error={errors.daily_limit}
            onChange={(e) => setLimit(e.target.value)}
          />
          <Field
            label="Daily budget (USD)"
            type="number"
            min={0}
            step="0.01"
            value={budget}
            error={errors.daily_budget_usd}
            onChange={(e) => setBudget(e.target.value)}
          />
          <Field
            label="Run time (24-hour)"
            type="time"
            value={runTime}
            error={errors.run_time}
            onChange={(e) => setRunTime(e.target.value)}
          />
          <div className="field">
            <label htmlFor="agent-zone">Time zone</label>
            <select id="agent-zone" value={zone} onChange={(e) => setZone(e.target.value)}>
              {timeZones(zone).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
            {errors.time_zone && <p className="field-error">{errors.time_zone}</p>}
          </div>
        </div>
        {settings.length > 0 && <h3>{agent.manifest?.name} settings</h3>}
        <div className="connection-fields">
          {settings.map((s) => (
            <SettingField
              key={s.key}
              setting={s}
              value={values[s.key] ?? null}
              error={errors[`config.${s.key}`]}
              onChange={(value) => setValues((v) => ({ ...v, [s.key]: value }))}
            />
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SettingField({
  setting,
  value,
  error,
  onChange,
}: {
  setting: ManifestSetting;
  value: ConfigValue;
  error?: string;
  onChange: (value: ConfigValue) => void;
}) {
  const id = `setting-${setting.key}`;
  const hint = error ? (
    <p className="field-error">{error}</p>
  ) : (
    setting.help && <p className="hint">{setting.help}</p>
  );
  if (setting.type === "bool") {
    return (
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {setting.label}
        </label>
        {hint}
      </div>
    );
  }
  if (setting.type === "choice") {
    return (
      <div className="field">
        <label htmlFor={id}>{setting.label}</label>
        <select id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {setting.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {hint}
      </div>
    );
  }
  const number = setting.type === "int" || setting.type === "float";
  return (
    <div className="field">
      <label htmlFor={id}>{setting.label}</label>
      <input
        id={id}
        type={number ? "number" : "text"}
        step={setting.type === "float" ? "any" : undefined}
        min={setting.min ?? undefined}
        max={setting.max ?? undefined}
        value={value === null ? "" : String(value)}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(number ? (raw === "" ? null : Number(raw)) : raw);
        }}
      />
      {hint}
    </div>
  );
}

function AddDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (result: { agent: Agent; token: string }) => void;
}) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      onAdded(await api.addAgent(key, name));
    } catch (err) {
      if (err instanceof ApiError) setErrors({ form: err.message, ...err.fields });
      setBusy(false);
    }
  }

  return (
    <Modal title="Add an agent" onClose={onClose}>
      <form onSubmit={submit} className="stack" noValidate>
        {errors.form && <Alert kind="error">{errors.form}</Alert>}
        <Field
          label="Name"
          placeholder="GBP audit"
          value={name}
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="Key"
          placeholder="gbp-audit"
          hint="Lower-case letters, digits and dashes. It can't be changed later."
          value={key}
          error={errors.key}
          onChange={(e) => setKey(e.target.value)}
        />
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={busy}>
            Add and show the token
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TokenDialog({
  result,
  onClose,
}: {
  result: { agent: Agent; token: string };
  onClose: () => void;
}) {
  return (
    <Modal title={`Token for ${result.agent.name}`} onClose={onClose}>
      <div className="stack">
        <Alert kind="success">
          Copy it now: it is shown only once. Put it in the agent's settings on the server as
          AGENT_TOKEN, next to HUB_URL. A new token stops the old one at once.
        </Alert>
        <CopyLink link={result.token} label="Agent token" />
        <StartCommands agentKey={result.agent.key} token={result.token} />
        <div className="modal-actions">
          <button type="button" className="button button-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
