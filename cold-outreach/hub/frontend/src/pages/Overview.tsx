import { HealthStatus } from "../HealthStatus";

// The real Overview (costs, last and next runs) arrives with build step 5 (SPEC section 7).
const COMING = [
  "Connections: enter the DataForSEO, Google, email and Telegram keys",
  "Agents: switch each agent on or off, set its limit and budget, Run now",
  "Runs: what ran, what failed and what it cost",
  "Import: upload lead files, check the preview, send them to the Master Sheet",
  "Benchmarks and Website Standards",
  "Alerts by email and Telegram",
];

export function Overview() {
  return (
    <section className="page">
      <h1>Overview</h1>
      <div className="card stack">
        <p>The Agent Hub is being set up. These screens arrive next:</p>
        <ul>
          {COMING.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <HealthStatus />
      </div>
    </section>
  );
}
