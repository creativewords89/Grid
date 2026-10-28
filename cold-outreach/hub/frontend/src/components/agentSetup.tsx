import { DEMO_MANIFEST, startCommands } from "../agentSetup";
import type { Agent, Pipeline } from "../api";
import { navigate } from "../router";

// How an agent gets ready to work (SPEC section 7): it is added in the Hub (a token), started
// on the server with that token, connects and names its task, is added to a batch's task,
// switched on, and the batch is started.

function Command({ label, text }: { label: string; text: string }) {
  return (
    <div className="stack-tight">
      <span className="small cell-strong">{label}</span>
      <pre className="command" aria-label={label}>
        {text}
      </pre>
      <div>
        <button
          type="button"
          className="button"
          onClick={() => void navigator.clipboard?.writeText(text)}
        >
          Copy
        </button>
      </div>
    </div>
  );
}

export function StartCommands({ agentKey, token }: { agentKey: string; token: string }) {
  const commands = startCommands(agentKey, token);
  return (
    <div className="stack">
      <p className="small">
        Run one of these on the server (in the Hub&apos;s folder). Within a minute the agent shows{" "}
        <strong>Connected</strong> and says which job it does.
      </p>
      <Command label="Demo agent (pretends to work, for trying the Hub)" text={commands.demo} />
      <Command
        label="A real agent (put its image name in place of AGENT_IMAGE)"
        text={commands.real}
      />
    </div>
  );
}

type Step = { title: string; done: boolean; help: string; to?: string };

/** The six steps that get a batch working, ticked as they are done. */
export function SetupGuide({
  agents,
  pipeline,
  isOwner,
}: {
  agents: Agent[];
  pipeline: Pipeline;
  isOwner: boolean;
}) {
  const inBatch = new Set(
    pipeline.steps.flatMap((s) => s.tasks.flatMap((t) => t.bots)).map((b) => b.key),
  );
  const connected = agents.filter((a) => a.manifest !== null);
  const steps: Step[] = [
    {
      title: "Add an agent",
      done: agents.length > 0,
      help: isOwner
        ? "On Agents, press + Add agent. The Hub shows its token once."
        : "The Owner adds agents on Agents; the Hub shows its token once.",
      to: "/agents",
    },
    {
      title: "Start it on the server with its token",
      done: agents.some((a) => a.last_seen_at !== null),
      help: "The token window on Agents shows the command to run on the server.",
      to: "/agents",
    },
    {
      title: "It connects and says which job it does",
      done: connected.some((a) => a.task !== null),
      help: "It then appears in the agent library on the left, under its job.",
    },
    {
      title: "Add a task for it to this batch",
      done: inBatch.size > 0,
      help: "Press + Add a task, choose its job, then add the agent (or press Add next to it on the left).",
    },
    {
      title: "Switch it on",
      done: agents.some((a) => inBatch.has(a.key) && a.enabled),
      help: "On Agents, switch the agent on. Off agents do nothing.",
      to: "/agents",
    },
    {
      title: "Start the batch",
      done: pipeline.batch.status === "running",
      help: "Press Start at the top. The agents then work through its businesses.",
    },
  ];
  if (steps.every((s) => s.done)) return null;
  const onlyDemo =
    connected.length > 0 && connected.every((a) => a.manifest?.name === DEMO_MANIFEST);
  return (
    <section className="card stack setup-guide" aria-label="Setup guide">
      <h2>Get this batch working</h2>
      {onlyDemo && (
        <p className="small">
          Only the <strong>demo agent</strong> is set up. It pretends to work, so you can try the
          steps. The real agents (the GBP audit first) are built next.
        </p>
      )}
      <ol className="setup-steps">
        {steps.map((step) => (
          <li key={step.title} className={step.done ? "setup-done" : undefined}>
            <span className="setup-mark" aria-hidden="true">
              {step.done ? "✔" : ""}
            </span>
            <div>
              <span className="cell-strong">{step.title}</span>
              <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
              {!step.done && (
                <p className="muted small">
                  {step.help}{" "}
                  {step.to && (
                    <a
                      href={step.to}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(step.to!);
                      }}
                    >
                      Go to Agents
                    </a>
                  )}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
