import { useEffect, useState } from "react";
import { getHealth, type Health } from "./api";

type State = { kind: "loading" } | { kind: "loaded"; health: Health } | { kind: "failed" };

export function HealthStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal)
      .then((health) => setState({ kind: "loaded", health }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "failed" });
      });
    return () => controller.abort();
  }, []);

  if (state.kind === "loading") {
    return <p className="status">Checking the server…</p>;
  }
  if (state.kind === "failed") {
    return (
      <p className="status status-error" role="alert">
        The server can't be reached.
      </p>
    );
  }
  const { health } = state;
  return (
    <p className={`status ${health.status === "ok" ? "status-ok" : "status-error"}`}>
      {health.status === "ok" ? "Server is running" : "Server has a problem"} · version{" "}
      {health.version}
      {health.status !== "ok" && (
        <>
          {" "}
          · failing:{" "}
          {Object.entries(health.checks)
            .filter(([, result]) => result !== "ok")
            .map(([name]) => name)
            .join(", ")}
        </>
      )}
    </p>
  );
}
