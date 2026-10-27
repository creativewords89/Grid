import { HealthStatus } from "./HealthStatus";

// Shell only: sign-in, the sidebar and the screens arrive from build step 2 onwards (SPEC section 7).
export function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <span className="mark" aria-hidden="true">
          GR
        </span>
        <h1>GridRankers Agent Hub</h1>
      </header>
      <main className="content">
        <section className="card">
          <h2>Setting up</h2>
          <p>
            The Agent Hub is being built. Sign-in, imports and the agents' on/off switches arrive in
            the next steps.
          </p>
          <HealthStatus />
        </section>
      </main>
    </div>
  );
}
