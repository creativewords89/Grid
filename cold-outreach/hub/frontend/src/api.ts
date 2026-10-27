// Typed calls to the `/api` routes (SPEC section 8). Every write sends the CSRF token.

export type Role = "owner" | "admin" | "viewer";

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  invited: boolean;
  alert_email: boolean;
  last_login_at: string | null;
  created_at: string;
};

export type Me = { user: User; csrf_token: string };

export type LinkResult = { email_sent: boolean; link: string | null };

export type ConnectionField = {
  name: string;
  label: string;
  kind: "text" | "secret" | "number" | "json";
  placeholder: string;
  required: boolean;
  set: boolean;
  unreadable: boolean;
  value: string | null;
  hint: string | null;
};

export type TestResult = { ok: boolean; message: string; at: string };

export type ConnectionGroup = {
  id: string;
  name: string;
  ready: boolean;
  last_test: TestResult | null;
  fields: ConnectionField[];
};

export type Connections = { groups: ConnectionGroup[] };

export type ManifestSetting = {
  key: string;
  type: "int" | "float" | "text" | "bool" | "choice";
  label: string;
  help: string;
  default: number | string | boolean | null;
  min: number | null;
  max: number | null;
  choices: string[];
};

export type Manifest = {
  name: string;
  version: string;
  description: string;
  settings: ManifestSetting[];
  connections: string[];
  sheet_columns: string[];
  cost_per_item_usd: number;
};

export type Run = {
  id: string;
  trigger: "schedule" | "manual";
  status: "queued" | "running" | "succeeded" | "failed" | "stopped" | "timed_out";
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  done: number;
  failed: number;
  skipped: number;
  cost_usd: string;
  stop_reason: string | null;
  requested_by: string | null;
  stop_requested: boolean;
  agent_key: string;
  agent_name: string;
};

export type RunPage = { runs: Run[]; more: boolean };

export type HistoryEntry = {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  title: string | null;
  changes: Record<string, unknown>[];
};

export type HistoryPage = { entries: HistoryEntry[]; more: boolean };

export type Budget = {
  daily_total_budget_usd: string;
  time_zone: string;
  spent_today_usd: string;
  spent_this_month_usd: string;
  can_change: boolean;
};

export type Overview = Budget & { agents: Agent[] };

export type ConfigValue = number | string | boolean | null;

export type Agent = {
  key: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  last_seen_at: string | null;
  manifest: Manifest | null;
  config: Record<string, ConfigValue>;
  daily_limit: number;
  run_time: string;
  time_zone: string;
  daily_budget_usd: string;
  batches: { id: string; name: string; ready: boolean }[];
  missing_connections: string[];
  last_run: Run | null;
  next_run_at: string | null;
  spent_today_usd: string;
};

export type AgentSettings = {
  config?: Record<string, ConfigValue>;
  daily_limit?: number;
  run_time?: string;
  time_zone?: string;
  daily_budget_usd?: string;
  batch_ids?: string[];
};

export type ImportCounts = {
  tabs: number;
  leads: number;
  new: number;
  updated: number;
  other_batch?: number;
  merged: number;
  top: number;
  no_gbp_link: number;
  no_website: number;
  skipped_rows: number;
  invalid_emails: number;
  cities: number;
  new_lists: number;
  sheet_added?: number;
  sheet_updated?: number;
};

export type ImportPreview = {
  has_level_column: boolean;
  empty_tabs: string[];
  unknown_columns: Record<string, string[]>;
  skipped_rows: string[];
  invalid_emails: string[];
  merged_rows: string[][];
  updated: string[];
  other_batch?: string[];
  no_gbp_link: string[];
  top: string[];
  new_lists: string[];
};

export type LeadImport = {
  id: string;
  file_name: string;
  niche: string;
  batch_id: string | null;
  batch_name: string | null;
  status: "preview" | "confirmed" | "failed" | "discarded";
  uploaded_by: string | null;
  created_at: string;
  confirmed_at: string | null;
  counts: ImportCounts;
  preview: ImportPreview;
};

export type LeadList = {
  id: string;
  city: string;
  niche: string;
  active: boolean;
  daily_limit: number | null;
  leads: number;
  top: number;
};

export type GbpTargets = {
  additional_categories?: number;
  services?: number;
  photos?: number;
  posts_90_days?: number;
  description_length?: number;
  reviews?: number;
  rating?: number;
  review_reply_pct?: number;
};

export type Benchmark = {
  id: string;
  name: string;
  niche: string;
  version: number;
  gbp: GbpTargets;
  // Saved through the editor it is a whole Standard; one moved in from before benchmarks
  // may lack parts (the editor fills them with defaults).
  website: Partial<Standard>;
  batches: string[];
  updated_by: string | null;
  updated_at: string;
  can_edit: boolean;
};

export type BenchmarkIn = { name: string; niche?: string; gbp: GbpTargets; website: Standard };

export type Batch = {
  id: string;
  name: string;
  niche: string;
  benchmark: { id: string; name: string; version: number } | null;
  leads: number;
  top: number;
  files: number;
  agents: string[];
  created_at: string;
  can_edit: boolean;
  can_rename: boolean;
  can_delete: boolean;
};

export type StandardService = { name: string; synonyms: string[]; must_have: boolean };

export type Standard = {
  services: StandardService[];
  service_page: {
    min_words: number;
    min_sections: number;
    faq: boolean;
    price: boolean;
    own_photos: boolean;
    reviews: boolean;
    cta: boolean;
    service_area: boolean;
  };
  location_page: {
    min_words: number;
    city_in_title: boolean;
    local_content: boolean;
    local_photos: boolean;
    all_services_linked: boolean;
    local_reviews: boolean;
    map: boolean;
    faq: boolean;
    cta: boolean;
    max_shared_text_pct: number;
  };
  supporting_pages: string[];
  blog: { posts_per_month: number; topics: string[] };
  mobile_lcp_seconds: number;
};

export type HubAlert = {
  id: string;
  kind: string;
  title: string;
  body: string;
  created_at: string;
  sent_at: string | null;
  emailed_to: number;
  telegram_sent: boolean;
  error: string | null;
};

export type AlertSettings = {
  alerts_telegram: boolean;
  daily_summary: boolean;
  daily_summary_time: string;
  low_balance_usd: string;
  can_change?: boolean;
};

export type Health = {
  status: "ok" | "error";
  version: string;
  checks: Record<string, "ok" | "error">;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

let csrfToken = "";

export function setCsrfToken(token: string) {
  csrfToken = token;
}

function toApiError(status: number, data: unknown): ApiError {
  const error = (
    data as { error?: { code?: string; message?: string; fields?: Record<string, string> } } | null
  )?.error;
  return new ApiError(
    status,
    error?.code ?? "error",
    error?.message ?? `Something went wrong (${status}).`,
    error?.fields ?? {},
  );
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "The server can't be reached. Check your connection.");
  }
  if (response.status === 204) return undefined as T;

  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, data);
  return data as T;
}

async function upload<T>(path: string, form: FormData): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "X-CSRF-Token": csrfToken },
      credentials: "same-origin",
      body: form,
    });
  } catch {
    throw new ApiError(0, "network", "The server can't be reached. Check your connection.");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, data);
  return data as T;
}

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const response = await fetch("/api/health", { signal, headers: { Accept: "application/json" } });
  // 503 still carries a health body describing which check failed.
  if (!response.ok && response.status !== 503) {
    throw new Error(`Health check failed (${response.status})`);
  }
  return (await response.json()) as Health;
}

export const api = {
  me: () => request<Me>("GET", "/auth/me"),
  login: (email: string, password: string) =>
    request<Me>("POST", "/auth/login", { email, password }),
  setupState: () => request<{ needed: boolean }>("GET", "/setup"),
  setupOwner: (body: { code: string; name: string; email: string; password: string }) =>
    request<Me>("POST", "/setup", body),
  logout: () => request<void>("POST", "/auth/logout"),
  forgot: (email: string) => request<{ message: string }>("POST", "/auth/forgot", { email }),
  checkToken: (token: string, kind: "invite" | "reset") =>
    request<{ name: string; email: string }>("POST", "/auth/check-token", { token, kind }),
  acceptInvite: (token: string, password: string) =>
    request<Me>("POST", "/auth/accept-invite", { token, password }),
  resetPassword: (token: string, password: string) =>
    request<{ message: string }>("POST", "/auth/reset", { token, password }),

  listUsers: () => request<User[]>("GET", "/users"),
  invite: (name: string, email: string, role: Role) =>
    request<LinkResult & { user: User }>("POST", "/users/invite", { name, email, role }),
  updateUser: (id: string, patch: Partial<Pick<User, "name" | "role" | "active">>) =>
    request<User>("PATCH", `/users/${id}`, patch),
  resendInvite: (id: string) => request<LinkResult>("POST", `/users/${id}/resend-invite`),
  sendReset: (id: string) => request<LinkResult>("POST", `/users/${id}/reset-password`),

  connections: () => request<Connections>("GET", "/connections"),
  updateConnections: (values: Record<string, string | null>) =>
    request<Connections>("PATCH", "/connections", { values }),
  testConnection: (group: string) => request<TestResult>("POST", `/connections/${group}/test`),

  agents: () => request<Agent[]>("GET", "/agents"),
  addAgent: (key: string, name: string) =>
    request<{ agent: Agent; token: string }>("POST", "/agents", { key, name }),
  newAgentToken: (key: string) =>
    request<{ agent: Agent; token: string }>("POST", `/agents/${key}/token`),
  switchAgent: (key: string, enabled: boolean) =>
    request<Agent>("PUT", `/agents/${key}/enabled`, { enabled }),
  updateAgent: (key: string, settings: AgentSettings) =>
    request<Agent>("PATCH", `/agents/${key}`, settings),
  runAgent: (key: string) => request<Run>("POST", `/agents/${key}/run`),
  stopAgent: (key: string) => request<Run>("POST", `/agents/${key}/stop`),
  runs: (filters: { agent?: string; status?: string; before?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(filters)) if (value) params.set(name, value);
    const query = params.toString();
    return request<RunPage>("GET", `/runs${query ? `?${query}` : ""}`);
  },
  history: (filters: { entity?: string; before?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(filters)) if (value) params.set(name, value);
    const query = params.toString();
    return request<HistoryPage>("GET", `/history${query ? `?${query}` : ""}`);
  },
  overview: () => request<Overview>("GET", "/overview"),
  uploadLeads: (file: File, batchId: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("batch_id", batchId);
    return upload<LeadImport>("/imports", form);
  },
  imports: (batchId?: string) =>
    request<LeadImport[]>("GET", `/imports${batchId ? `?batch_id=${batchId}` : ""}`),
  confirmImport: (id: string) => request<LeadImport>("POST", `/imports/${id}/confirm`),
  discardImport: (id: string) => request<LeadImport>("POST", `/imports/${id}/discard`),
  niches: () => request<string[]>("GET", "/niches"),
  benchmarks: () => request<Benchmark[]>("GET", "/benchmarks"),
  createBenchmark: (body: BenchmarkIn) => request<Benchmark>("POST", "/benchmarks", body),
  saveBenchmark: (id: string, body: BenchmarkIn) =>
    request<Benchmark>("PUT", `/benchmarks/${id}`, body),
  deleteBenchmark: (id: string) => request<void>("DELETE", `/benchmarks/${id}`),
  batches: () => request<Batch[]>("GET", "/batches"),
  batch: (id: string) => request<Batch>("GET", `/batches/${id}`),
  createBatch: (body: { name: string; niche: string; benchmark_id: string | null }) =>
    request<Batch>("POST", "/batches", body),
  updateBatch: (id: string, patch: { name?: string; benchmark_id?: string }) =>
    request<Batch>("PATCH", `/batches/${id}`, patch),
  deleteBatch: (id: string) => request<void>("DELETE", `/batches/${id}`),
  lists: () => request<LeadList[]>("GET", "/lists"),
  updateList: (id: string, patch: { active?: boolean }) =>
    request<LeadList>("PATCH", `/lists/${id}`, patch),
  setBudget: (daily_total_budget_usd: string, time_zone: string) =>
    request<Budget>("PUT", "/budget", { daily_total_budget_usd, time_zone }),

  updateProfile: (name: string) => request<User>("PATCH", "/me", { name }),
  setAlertEmail: (alert_email: boolean) => request<User>("PATCH", "/me", { alert_email }),
  alerts: () => request<HubAlert[]>("GET", "/alerts"),
  alertSettings: () => request<AlertSettings>("GET", "/alert-settings"),
  saveAlertSettings: (settings: AlertSettings) =>
    request<AlertSettings>("PUT", "/alert-settings", settings),
  changePassword: (current_password: string, new_password: string) =>
    request<{ message: string }>("POST", "/me/password", { current_password, new_password }),
};
