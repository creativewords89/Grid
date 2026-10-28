import type { Agent } from "./api";

// How an agent gets ready to work (SPEC section 7): the commands that start it on the server
// with its token, and where it is in its setup.

/** The commands that start an agent on the server with its token. */
export function startCommands(key: string, token: string): { demo: string; real: string } {
  const common =
    `docker run -d --name ${key} --restart unless-stopped --network agent-hub \\\n` +
    `  -e HUB_URL=http://api:8000 -e AGENT_TOKEN=${token}`;
  return {
    demo:
      "cd /opt/gridrankers/cold-outreach\n" +
      `${common} \\\n  -v "$PWD/agents/demo:/agent:ro" python:3.12-slim python /agent/agent.py`,
    real: `${common} \\\n  AGENT_IMAGE`,
  };
}

export type SetupState = { label: string; done: boolean };

/** Where an agent is in its setup, in one line for its card. */
export function setupState(agent: Agent): SetupState {
  if (!agent.manifest && !agent.last_seen_at)
    return { label: "Waiting for its first connection: start it on the server.", done: false };
  const running = agent.batches.some((b) => b.status === "running");
  if (!running)
    return { label: "Connected once. Next: add it to a batch's task and start it.", done: false };
  if (!agent.enabled) return { label: "In a running batch. Next: switch it on.", done: false };
  return { label: "Ready: on, and in a running batch.", done: true };
}
