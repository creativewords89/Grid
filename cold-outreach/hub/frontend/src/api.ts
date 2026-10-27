// Thin wrapper over fetch for the `/api` routes (SPEC section 8).

export type Health = {
  status: "ok" | "error";
  version: string;
  checks: Record<string, "ok" | "error">;
};

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const response = await fetch("/api/health", { signal, headers: { Accept: "application/json" } });
  // 503 still carries a health body describing which check failed.
  if (!response.ok && response.status !== 503) {
    throw new Error(`Health check failed (${response.status})`);
  }
  return (await response.json()) as Health;
}
