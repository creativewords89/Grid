import { vi } from "vitest";
import type { User } from "../api";

// A handler may answer later (a Promise), to test what shows while the server is slow.
type Answer = [number, unknown?] | Response;
type Handler = (body: unknown) => Answer | Promise<Answer>;
export type Call = { method: string; path: string; body: unknown; csrf: string | null };

/** Replace fetch with handlers keyed "METHOD /path" (path without the /api prefix). */
export function mockApi(routes: Record<string, Handler | [number, unknown?] | Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = url.replace(/^\/api/, "");
      const body =
        init.body instanceof FormData
          ? Object.fromEntries(init.body.entries())
          : init.body
            ? JSON.parse(String(init.body))
            : undefined;
      const headers = new Headers(init.headers);
      calls.push({ method, path, body, csrf: headers.get("X-CSRF-Token") });
      const route = routes[`${method} ${path}`];
      if (!route)
        return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
      const result = await (typeof route === "function" ? route(body) : route);
      if (result instanceof Response) return result;
      const [status, data] = result;
      return status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(data ?? {}), { status });
    }),
  );
  // Uploads that report progress use XMLHttpRequest (step 33): answered from the same routes.
  class FakeRequest {
    method = "GET";
    url = "";
    status = 0;
    responseText = "";
    headers = new Headers();
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    withCredentials = false;
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers.set(name, value);
    }
    send(body: FormData) {
      const path = this.url.replace(/^\/api/, "");
      const sent = Object.fromEntries(body.entries());
      calls.push({ method: this.method, path, body: sent, csrf: this.headers.get("X-CSRF-Token") });
      const route = routes[`${this.method} ${path}`];
      setTimeout(async () => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 } as ProgressEvent);
        const result = await (route === undefined
          ? ([404, { error: { code: "not_found" } }] as [number, unknown])
          : typeof route === "function"
            ? route(sent)
            : route);
        if (result instanceof Response) throw new Error("not for uploads");
        this.status = result[0];
        this.responseText = JSON.stringify(result[1] ?? {});
        this.onload?.();
      }, 0);
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
  return calls;
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u1",
    email: "sara@example.com",
    name: "Sara",
    role: "viewer",
    active: true,
    invited: false,
    alert_email: true,
    last_login_at: null,
    created_at: "2026-10-01T10:00:00Z",
    ...overrides,
  };
}

export const unauthenticated: [number, unknown] = [
  401,
  { error: { code: "unauthenticated", message: "Please sign in." } },
];

export const healthy: [number, unknown] = [
  200,
  { status: "ok", version: "0.1.0", checks: { database: "ok" } },
];
