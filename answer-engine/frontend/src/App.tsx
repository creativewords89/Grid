import { HealthStatus } from "./HealthStatus";

// Shell only: sign-in, sidebar and screens arrive from build step 2 onwards (SPEC section 7).
export function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <span className="mark" aria-hidden="true">
          GR
        </span>
        <h1>GridRankers Answer Engine</h1>
      </header>
      <main className="content">
        <section className="card">
          <h2>Setting up</h2>
          <p>The Answer Engine is being built. Sign-in and the chat arrive in the next steps.</p>
          <HealthStatus />
        </section>
      </main>
    </div>
  );
}
