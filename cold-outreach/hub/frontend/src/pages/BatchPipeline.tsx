import {
  useCallback,
  useEffect,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
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

// A batch's tasks (SPEC section 6.7): the agent library grouped by job on the left, the steps
// on the right. A task is made here: its job, its name and what it needs first in this batch.
// Each task can have several agents of its job, which either all check every business or
// split the businesses. Every business moves on as soon as what it needs is done.

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
  const [adding, setAdding] = useState(false);
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

  /** Run a change; false when it was refused (the reason is shown). */
  async function act(action: () => Promise<Pipeline>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      onChange(await action());
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Put an agent on its task in this batch, adding the task first when it isn't there. */
  function addBot(task: Task, key: string) {
    void act(async () => {
      if (!inBatch.has(task.key)) await api.addBatchTask(batchId, { task_id: task.id, needs: [] });
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
              ? "Grouped by the job they do. Drag an agent onto a task of its job, or press Add."
              : "The agents, grouped by the job they do."}
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
                    onShare={(share) =>
                      void act(() => api.updateBatchTask(batchId, slot.task_id, { share }))
                    }
                    others={slots.filter((o) => o.task_id !== slot.task_id)}
                    onEdit={(patch) => act(() => api.updateBatchTask(batchId, slot.task_id, patch))}
                    onRemove={() => void act(() => api.removeBatchTask(batchId, slot.task_id))}
                  />
                ))}
              </div>
            </section>
          ))}
          {staff && !adding && (
            <div>
              <button className="button button-primary" onClick={() => setAdding(true)}>
                + Add a task
              </button>
            </div>
          )}
          {staff && adding && (
            <AddTask
              jobs={missing}
              slots={slots}
              busy={busy}
              onCancel={() => setAdding(false)}
              onAdd={async (body) => {
                await act(() => api.addBatchTask(batchId, body));
                setAdding(false);
              }}
            />
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
  others,
  onEdit,
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
  others: PipelineTask[];
  onEdit: (patch: { name: string; needs: string[] }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const free = (task?.bots ?? []).filter((b) => !slot.bots.some((x) => x.key === b.key));
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
            {slot.name !== slot.job && `Job: ${slot.job} · `}
            Needs:{" "}
            {slot.needs.length > 0 ? slot.needs.map((n) => n.name).join(", ") : "the lead file"}
          </p>
        </div>
        {staff && (
          <span className="row">
            <button
              className="link-button"
              disabled={busy}
              aria-label={`Edit ${slot.name}`}
              onClick={() => setEditing(!editing)}
            >
              Edit
            </button>
            {slot.can_remove && (
              <button
                className="link-button"
                disabled={busy}
                aria-label={`Remove ${slot.name} from the batch`}
                onClick={onRemove}
              >
                Remove
              </button>
            )}
          </span>
        )}
      </div>
      {editing && (
        <TaskForm
          title={`Edit ${slot.name}`}
          name={slot.name}
          needs={slot.needs.map((n) => n.task_id)}
          slots={others}
          busy={busy}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (name, needs) => {
            if (await onEdit({ name, needs })) setEditing(false);
          }}
        />
      )}
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
          {free.length > 0 && (
            <select
              aria-label={`Add another agent to ${slot.name}`}
              value=""
              disabled={busy}
              onChange={(e) => e.target.value && onAddBot(e.target.value)}
            >
              <option value="">
                {slot.bots.length === 0 ? "+ Add an agent…" : "+ Add another agent…"}
              </option>
              {free.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          {slot.bots.length > 1 && (
            <label className="small">
              How the agents share{" "}
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

/** The name and what a task needs first: the batch's other tasks, ticked. */
function TaskForm({
  title,
  name: startName,
  needs: startNeeds,
  slots,
  busy,
  submitLabel,
  children,
  onCancel,
  onSubmit,
}: {
  title: string;
  name: string;
  needs: string[];
  slots: PipelineTask[];
  busy: boolean;
  submitLabel: string;
  children?: ReactNode;
  onCancel: () => void;
  onSubmit: (name: string, needs: string[]) => void;
}) {
  const [name, setName] = useState(startName);
  const [needs, setNeeds] = useState<string[]>(startNeeds);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(name.trim(), needs);
  }

  return (
    <form className="card stack-tight task-form" onSubmit={submit} aria-label={title}>
      <h3>{title}</h3>
      {children}
      <div className="field">
        <label htmlFor={`task-name-${title}`}>Name</label>
        <input
          id={`task-name-${title}`}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <fieldset className="plain stack-tight">
        <legend className="small">Needs first (tasks of this batch)</legend>
        {slots.length === 0 && (
          <p className="muted small">Only the lead file: no other tasks yet.</p>
        )}
        {slots.map((other) => (
          <label key={other.task_id} className="row small">
            <input
              type="checkbox"
              checked={needs.includes(other.task_id)}
              onChange={(e) =>
                setNeeds(
                  e.target.checked
                    ? [...needs, other.task_id]
                    : needs.filter((n) => n !== other.task_id),
                )
              }
            />
            {other.name}
          </label>
        ))}
      </fieldset>
      <div className="row">
        <button className="button button-primary" disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** + Add a task: its job (only jobs not in the batch yet), name and what it needs first. */
function AddTask({
  jobs,
  slots,
  busy,
  onCancel,
  onAdd,
}: {
  jobs: Task[];
  slots: PipelineTask[];
  busy: boolean;
  onCancel: () => void;
  onAdd: (body: { task_id: string; name: string; needs: string[] }) => void;
}) {
  const ordered = [...jobs].sort((a, b) => Number(b.bots.length > 0) - Number(a.bots.length > 0));
  const [jobId, setJobId] = useState(ordered[0]?.id ?? "");
  const job = jobs.find((j) => j.id === jobId);
  if (jobs.length === 0) {
    return (
      <div className="card stack-tight">
        <p className="muted small">
          Every job your agents do already has a task here. Add an agent that does another job on
          Agents first.
        </p>
        <div>
          <button className="button" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    );
  }
  return (
    <TaskForm
      key={jobId}
      title="Add a task"
      name={job?.name ?? ""}
      needs={[]}
      slots={slots}
      busy={busy}
      submitLabel="Add task"
      onCancel={onCancel}
      onSubmit={(name, needs) => onAdd({ task_id: jobId, name, needs })}
    >
      <div className="field">
        <label htmlFor="task-job">Job (what your agents do)</label>
        <select id="task-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
          {ordered.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
              {j.bots.length === 0
                ? " (no agent yet)"
                : ` (${j.bots.length} agent${j.bots.length === 1 ? "" : "s"})`}
            </option>
          ))}
        </select>
        {job && job.bots.length > 0 && (
          <p className="hint">Agents for it: {job.bots.map((b) => b.name).join(", ")}</p>
        )}
      </div>
    </TaskForm>
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

export function ResultsTab({
  batchId,
  pipeline,
  onShowLeads,
}: {
  batchId: string;
  pipeline: Pipeline;
  onShowLeads: () => void;
}) {
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
        <div className="field">
          <span className="label-spacer" aria-hidden="true">
            &nbsp;
          </span>
          <button className="button" onClick={onShowLeads}>
            All results (Leads)
          </button>
        </div>
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
