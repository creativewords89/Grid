import { vi } from "vitest";
import type { User } from "../api";

type Handler = (body: unknown) => [number, unknown?];
export type Call = { method: string; path: string; body: unknown; csrf: string | null };

/** Replace fetch with handlers keyed "METHOD /path" (path without the /api prefix). */
export function mockApi(routes: Record<string, Handler | [number, unknown?]>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = url.replace(/^\/api/, "");
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const headers = new Headers(init.headers);
      calls.push({ method, path, body, csrf: headers.get("X-CSRF-Token") });
      const route = routes[`${method} ${path}`];
      if (!route)
        return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
      const [status, data] = typeof route === "function" ? route(body) : route;
      return status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(data ?? {}), { status });
    }),
  );
  return calls;
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u1",
    email: "sara@example.com",
    name: "Sara",
    role: "user",
    active: true,
    invited: false,
    telegram_linked: false,
    last_login_at: null,
    created_at: "2026-10-01T10:00:00Z",
    ...overrides,
  };
}

export const unauthenticated: [number, unknown] = [
  401,
  { error: { code: "unauthenticated", message: "Please sign in." } },
];
