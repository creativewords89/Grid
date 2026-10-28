import { startCommands } from "../agentSetup";

// How an agent is started on the server with its token (SPEC section 7).

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
