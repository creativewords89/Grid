import { useCallback, useEffect, useState, type DragEvent } from "react";
import {
  api,
  ApiError,
  type Agent,
  type Band,
  type BotProgress,
  type BotResults,
  type Outcome,
  type Pipeline,
  type PipelineTask,
  type Share,
  type Task,
} from "../api";
import { useAuth } from "../auth";
import { SetupGuide } from "../components/agentSetup";
import { Alert } from "../components/ui";
import { when } from "../format";
import { LeadDialog } from "./Leads";

// A batch's tasks and agents (SPEC section 6.7): the agent library grouped by task on the
// left, the steps on the right. Each task can have several agents, which either all check every
// business or split the businesses. Every business moves on as soon as what it needs is done.

const SHARE: Record<Share, string> = {
  all: "Every agent checks every business",
  split: "Split the businesses between agents",
};

export function PipelineTab({
  batchId,
  pipeline,
  onChange,
}: {
  batchId: string;
  pipeline: Pipeline;
  onChange: (next: Pipeline) => void;
}) {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const staff = pipeline.batch.can_run;

  useEffect(() => {
    api
      .tasks()
      .then(setTasks)
      .catch(() => setTasks([]));
    api
      .agents()
      .then(setAgents)
      .catch(() => setAgents(null));
  }, [pipeline]);

  const slots = pipeline.steps.flatMap((s) => s.tasks);
  const inBatch = new Map(slots.map((slot) => [slot.key, slot]));
  const onBot = new Set(slots.flatMap((slot) => slot.bots.map((b) => b.key)));

  async function act(action: () => Promise<Pipeline>) {
    setBusy(true);
    setError("");
    try {
      onChange(await action());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  /** Put an agent on its task in this batch, adding the task first when it isn't there. */
  function addBot(task: Task, key: string) {
    void act(async () => {
      if (!inBatch.has(task.key)) await api.addBatchTask(batchId, task.id);
      return api.addBot(batchId, task.id, key);
    });
  }

  function drop(event: DragEvent, slot: PipelineTask) {
    event.preventDefault();
    const key = event.dataTransfer.getData("text/plain");
    const task = tasks.find((t) => t.id === slot.task_id);
    if (task && task.bots.some((b) => b.key === key) && !slot.bots.some((b) => b.key === key)) {
      addBot(task, key);
    }
  }

  const missing = tasks.filter((t) => !inBatch.has(t.key));
  return (
    <div className="stack">
      {agents && (
        <SetupGuide agents={agents} pipeline={pipeline} isOwner={user?.role === "owner"} />
      )}
      <div className="pipeline">
        <aside className="card stack bot-library" aria-label="Agent library">
          <h2>Agents</h2>
          <p className="muted small">
            {staff
              ? "Drag an agent onto its task, or press Add."
              : "The agents, grouped by their task."}
          </p>
          {tasks.map((task) => (
            <div key={task.id} className="stack-tight">
              <h3 className="small-head">{task.name}</h3>
              {task.bots.length === 0 && <p className="muted small">No agent does this yet.</p>}
              {task.bots.map((b) => (
                <div
                  key={b.key}
                  className={`library-bot ${onBot.has(b.key) ? "library-bot-used" : ""}`}
                  draggable={staff && !onBot.has(b.key)}
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", b.key)}
                >
                  <span>
                    {b.name}
                    {!b.enabled && <span className="muted small"> · off</span>}
                  </span>
                  {onBot.has(b.key) ? (
                    <span className="pill pill-active">In use</span>
                  ) : (
                    staff && (
                      <button
                        className="link-button"
                        disabled={busy}
                        aria-label={`Add ${b.name} to ${task.name}`}
                        onClick={() => addBot(task, b.key)}
                      >
                        Add
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
          ))}
        </aside>
        <div className="stack">
          {error && <Alert kind="error">{error}</Alert>}
          {slots.length === 0 && (
            <p className="muted">No tasks yet. Add a task, then choose its agents.</p>
          )}
          {pipeline.steps.map((step) => (
            <section key={step.step} className="stack-tight" aria-label={`Step ${step.step}`}>
              <h2 className="small-head">
                Step {step.step}
                {step.tasks.length > 1 && " · side by side"}
              </h2>
              <div className="step-tasks">
                {step.tasks.map((slot) => (
                  <TaskSlot
                    key={slot.task_id}
                    slot={slot}
                    task={tasks.find((t) => t.id === slot.task_id)}
                    staff={staff}
                    busy={busy}
                    onDrop={(e) => drop(e, slot)}
                    onAddBot={(key) => void act(() => api.addBot(batchId, slot.task_id, key))}
                    onRemoveBot={(key) => void act(() => api.removeBot(batchId, slot.task_id, key))}
                    onShare={(share) => void act(() => api.setShare(batchId, slot.task_id, share))}
                    onRemove={() => void act(() => api.removeBatchTask(batchId, slot.task_id))}
                  />
                ))}
              </div>
            </section>
          ))}
          {staff && missing.length > 0 && (
            <div className="field">
              <label htmlFor="batch-add-task">+ Add a task</label>
              <select
                id="batch-add-task"
                value=""
                disabled={busy}
                onChange={(e) =>
                  e.target.value && void act(() => api.addBatchTask(batchId, e.target.value))
                }
              >
                <option value="">Choose…</option>
                {missing.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.needs.length > 0 && ` (needs ${t.needs.map((n) => n.name).join(", ")})`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskSlot({
  slot,
  task,
  staff,
  busy,
  onDrop,
  onAddBot,
  onRemoveBot,
  onShare,
  onRemove,
}: {
  slot: PipelineTask;
  task: Task | undefined;
  staff: boolean;
  busy: boolean;
  onDrop: (e: DragEvent) => void;
  onAddBot: (key: string) => void;
  onRemoveBot: (key: string) => void;
  onShare: (share: Share) => void;
  onRemove: () => void;
}) {
  const others = (task?.bots ?? []).filter((b) => !slot.bots.some((x) => x.key === b.key));
  return (
    <article
      className={`card stack-tight task-slot ${slot.bots.length === 0 ? "task-slot-empty" : ""}`}
      aria-label={slot.name}
      onDragOver={(e) => staff && e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="agent-head">
        <div>
          <h3>{slot.name}</h3>
          <p className="muted small">
            Needs: {slot.needs.length > 0 ? slot.needs.join(", ") : "the lead file"}
          </p>
        </div>
        {staff && slot.can_remove && (
          <button
            className="link-button"
            disabled={busy}
            aria-label={`Remove ${slot.name} from the batch`}
            onClick={onRemove}
          >
            Remove task
          </button>
        )}
      </div>
      {slot.bots.length === 0 && (
        <p className="small field-error">No agent yet: the businesses wait here.</p>
      )}
      {slot.bots.map((bot) => (
        <BotRow
          key={bot.key}
          bot={bot}
          staff={staff}
          busy={busy}
          onRemove={() => onRemoveBot(bot.key)}
          task={slot.name}
        />
      ))}
      {staff && (
        <div className="row">
          {others.length > 0 && (
            <select
              aria-label={`Add another agent to ${slot.name}`}
              value=""
              disabled={busy}
              onChange={(e) => e.target.value && onAddBot(e.target.value)}
            >
              <option value="">
                {slot.bots.length === 0 ? "+ Add an agent…" : "+ Add another agent…"}
              </option>
              {others.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          {slot.bots.length > 1 && (
            <label className="small">
              How the bots share{" "}
              <select
                value={slot.share}
                disabled={busy}
                onChange={(e) => onShare(e.target.value as Share)}
              >
                {(Object.keys(SHARE) as Share[]).map((s) => (
                  <option key={s} value={s}>
                    {SHARE[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {!staff && slot.bots.length > 1 && <p className="muted small">{SHARE[slot.share]}</p>}
    </article>
  );
}

function BotRow({
  bot,
  task,
  staff,
  busy,
  onRemove,
}: {
  bot: BotProgress;
  task: string;
  staff: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const total = bot.done + bot.failed + bot.ready + bot.waiting;
  const pct = total ? Math.round((100 * bot.done) / total) : 0;
  return (
    <div className="bot-row">
      <div className="agent-head">
        <span className="cell-strong">{bot.name}</span>
        <span className="row">
          {!bot.enabled && <span className="pill pill-deactivated">Off</span>}
          {bot.enabled && !bot.connected && <span className="pill">Not connected</span>}
          {staff && (
            <button
              className="icon-button"
              disabled={busy}
              aria-label={`Remove ${bot.name} from ${task}`}
              onClick={onRemove}
            >
              ×
            </button>
          )}
        </span>
      </div>
      <div
        className="meter"
        role="progressbar"
        aria-label={`${bot.name} progress`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div style={{ width: `${pct}%` }} />
      </div>
      <p className="muted small">
        {bot.done.toLocaleString()} done · {bot.ready.toLocaleString()} ready
        {bot.waiting > 0 && ` · ${bot.waiting.toLocaleString()} waiting for earlier tasks`}
        {bot.failed > 0 && ` · ${bot.failed.toLocaleString()} failed (tried again)`}
        {bot.average_score !== null && ` · avg score ${bot.average_score}`}
      </p>
    </div>
  );
}

// --- results ------------------------------------------------------------------------------

const OUTCOMES: Record<Outcome, string> = {
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
  not_yet: "Not yet",
};
const BANDS: Record<Band, string> = { low: "Under 40", mid: "40–69", high: "70 and over" };

export function ResultsTab({ batchId, pipeline }: { batchId: string; pipeline: Pipeline }) {
  const bots = pipeline.steps.flatMap((s) => s.tasks.flatMap((t) => t.bots));
  const [bot, setBot] = useState(bots[0]?.key ?? "");
  const [outcome, setOutcome] = useState<Outcome | "">("");
  const [band, setBand] = useState<Band | "">("");
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState<BotResults | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    if (!bot) return;
    api
      .botResults(batchId, { bot, outcome, band, page })
      .then(setShown)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [batchId, bot, outcome, band, page]);
  useEffect(load, [load]);

  if (bots.length === 0) return <p className="muted">Add agents to the batch to see results.</p>;
  const labels = Object.fromEntries(bots.map((b) => [b.key, b.name]));
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="row">
        <div className="field">
          <label htmlFor="results-bot">Agent</label>
          <select
            id="results-bot"
            value={bot}
            onChange={(e) => {
              setBot(e.target.value);
              setPage(1);
            }}
          >
            {bots.map((b) => (
              <option key={b.key} value={b.key}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <a className="button" href={`/leads?batch=${batchId}`}>
          All results (Leads)
        </a>
      </div>
      {shown && (
        <>
          <div className="counts" aria-label="Outcomes">
            {(Object.keys(OUTCOMES) as Outcome[]).map((o) => (
              <button
                key={o}
                className={`count count-button ${outcome === o ? "count-chosen" : ""}`}
                aria-pressed={outcome === o}
                onClick={() => {
                  setOutcome(outcome === o ? "" : o);
                  setPage(1);
                }}
              >
                <span className="count-value">{shown.outcomes[o].toLocaleString()}</span>
                <span className="muted small">{OUTCOMES[o]}</span>
              </button>
            ))}
            {(Object.keys(BANDS) as Band[]).map((b) => (
              <button
                key={b}
                className={`count count-button ${band === b ? "count-chosen" : ""}`}
                aria-pressed={band === b}
                onClick={() => {
                  setBand(band === b ? "" : b);
                  setPage(1);
                }}
              >
                <span className="count-value">{shown.bands[b].toLocaleString()}</span>
                <span className="muted small">Score {BANDS[b]}</span>
              </button>
            ))}
          </div>
          <div className="card table-card">
            <table className="table">
              <caption className="table-caption">
                {shown.bot_name}: {shown.total.toLocaleString()} businesses, lowest score first
              </caption>
              <thead>
                <tr>
                  <th>Business</th>
                  <th className="hide-narrow">City</th>
                  <th>Outcome</th>
                  <th>Score</th>
                  <th className="hide-narrow">Summary</th>
                  <th className="hide-narrow">When</th>
                </tr>
              </thead>
              <tbody>
                {shown.leads.map((row) => (
                  <tr key={row.lead_id}>
                    <td>
                      <button className="link-button" onClick={() => setOpen(row.lead_id)}>
                        {row.business_name}
                      </button>
                    </td>
                    <td className="hide-narrow">{row.city}</td>
                    <td>
                      {OUTCOMES[row.outcome]}
                      {row.status && row.outcome !== "not_yet" && (
                        <span className="muted small"> · {row.status}</span>
                      )}
                    </td>
                    <td>{row.score ?? "—"}</td>
                    <td className="hide-narrow small">{row.summary}</td>
                    <td className="hide-narrow small">{row.at ? when(row.at) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.pages > 1 && (
            <div className="row">
              <button className="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span className="small">
                Page {shown.page} of {shown.pages}
              </span>
              <button
                className="button"
                disabled={page >= shown.pages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
      {open && (
        <LeadDialog id={open} agents={labels} onClose={() => setOpen(null)} onChanged={load} />
      )}
    </div>
  );
}
