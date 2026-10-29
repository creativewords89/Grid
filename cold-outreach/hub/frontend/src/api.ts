// Typed calls to the `/api` routes (SPEC section 8). Every write sends the CSRF token.

// A Collector (step 31) is the external team that collects leads: the Files screen only.
// A Reviewer (step 32) chooses each city's Top in the files: the Top Review screen only.
export type Role = "owner" | "admin" | "viewer" | "collector" | "reviewer";

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
  kind: "text" | "secret" | "number";
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
  result_label: string;
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
  kind: string | null; // a built-in kind the Hub runs (step 25); null: its own container
  enabled: boolean;
  connected: boolean;
  last_seen_at: string | null;
  manifest: Manifest | null;
  config: Record<string, ConfigValue>;
  daily_limit: number;
  run_time: string;
  time_zone: string;
  daily_budget_usd: string;
  task: { key: string; name: string } | null;
  batches: { id: string; name: string; status: BatchStatus; ready: boolean; task_name: string }[];
  missing_connections: string[];
  last_run: Run | null;
  next_run_at: string | null;
  spent_today_usd: string;
};

/** A built-in agent the Hub can run (step 25). */
export type AgentKind = {
  key: string;
  name: string;
  about: string;
  job: { key: string; name: string } | null; // null: chosen when it is added
};

export type AgentSettings = {
  config?: Record<string, ConfigValue>;
  daily_limit?: number;
  run_time?: string;
  time_zone?: string;
  daily_budget_usd?: string;
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
  saved_new?: number;
  saved_updated?: number;
};

/** A Lead Check problem (steps 26–27): an error holds its file back, a warning never does. */
export type CheckIssue = {
  code: string;
  field: string; // the column it is about: business_name, gbp_link, address, …
  severity: "error" | "warning";
  message: string;
  // A one-click fix, when there is one: the field changes it makes.
  fix?: { label: string; changes: Partial<Record<string, string>> } | null;
};

export type PreviewCheck = {
  errors: number;
  warnings: number;
  tabs: Record<string, { errors: number; warnings: number; columns: CheckIssue[] }>;
};

/** A saved file's Lead Check report. */
export type CheckReport = {
  import_id: string;
  file_name: string;
  held: boolean;
  errors: number;
  warnings: number;
  cities: { city: string; errors: number; warnings: number }[];
  tabs: Record<string, CheckIssue[]>;
  issues: (CheckIssue & {
    lead_id: string;
    business_name: string;
    city: string;
    value: string;
  })[];
};

/** What a fix file changes (step 28): a preview until it is saved. */
export type FixResult = {
  saved: boolean;
  rows: number;
  changed: {
    tab: string;
    line: number;
    lead_id: string;
    business_name: string;
    city: string;
    changes: { field: string; from: unknown; to: unknown }[];
    errors: number;
    warnings: number;
  }[];
  unchanged: number;
  skipped: { tab: string; line: number; lead_id: string; reason: string }[];
  refused: {
    tab: string;
    line: number;
    lead_id: string;
    business_name: string;
    field: string;
    message: string;
  }[];
  errors_before: number;
  errors_after: number;
  warnings_after: number;
  held_files_after: number;
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
  check?: PreviewCheck;
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
  check_errors?: number | null; // a saved file: its leads with an error; held while > 0
};

export type SheetStatus = "new" | "updated" | "other_batch" | "merged" | "top" | "skipped";

export type SheetRow = {
  tab: string;
  line: number;
  status: "new" | "updated" | "other_batch" | "skipped";
  merged: boolean;
  top: boolean;
  lead_id?: string | null;
  deleted?: boolean;
  values: Record<string, string>;
  extra: Record<string, string>;
  raw: Record<string, string>;
  bad_emails: string[];
  issues?: CheckIssue[];
};

export type ImportSheet = {
  kept: boolean;
  tabs: { name: string; rows: number }[];
  columns: { key: string; label: string }[];
  statuses: Record<SheetStatus, number>;
  rows: SheetRow[];
  total: number;
  page: number;
  pages: number;
};

export type LeadList = {
  id: string;
  batch_id: string;
  city: string;
  set_by_hand: boolean;
  small: boolean;
  niche: string;
  active: boolean;
  daily_limit: number | null;
  leads: number;
  top: number;
  ready: boolean; // a Top chosen: agents may work on it (step 20)
  added_from: { id: string; file_name: string; confirmed_at: string | null } | null;
  new: boolean; // it came with the batch's latest file (step 22)
  errors: number; // Lead Check problems of its leads (step 26)
  warnings: number;
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

export type LeadResult = {
  status: string;
  score: number | null;
  summary: string;
  details: Record<string, unknown>;
  benchmark_id: string | null;
  benchmark_version: number | null;
  at: string;
};

export type Lead = {
  lead_id: string;
  batch_id: string | null;
  batch_name: string | null;
  niche: string;
  city: string;
  business_name: string;
  level: string;
  gbp_link: string;
  emails: string[];
  data: Record<string, string>;
  extra: Record<string, string>;
  results: Record<string, LeadResult>;
  check: CheckIssue[];
};

export type LeadFile = {
  id: string;
  agent_key: string;
  name: string;
  content_type: string;
  size: number;
  created_at: string;
};

export type LeadDetail = Lead & { files: LeadFile[]; can_edit: boolean; held: boolean };

export type LeadPage = {
  leads: Lead[];
  total: number;
  page: number;
  pages: number;
  agents: Record<string, string>;
  extra_columns: string[];
};

export type LeadFilters = {
  batch_id?: string;
  q?: string;
  city?: string;
  level?: "" | "top" | "not_top";
  website?: "" | "yes" | "no";
  sort?: "lead_id" | "name" | "city" | "newest" | "score" | "rating" | "reviews";
  score_of?: string;
  problems?: string; // "any", "errors" or a problem's code (Lead Check)
  page?: number;
};

// Every standard field of the lead file can be changed in the Hub (step 27).
export const LEAD_FIELDS = [
  "business_name",
  "gbp_link",
  "address",
  "city",
  "website",
  "phone",
  "whatsapp",
  "email",
  "facebook",
  "instagram",
  "reviews",
  "rating",
  "notes",
] as const;
export type LeadPatch = Partial<Record<(typeof LEAD_FIELDS)[number], string>>;

/** `?name=value&…` for the filters that are set. */
export function leadQuery(filters: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(name, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export type BatchStatus = "not_started" | "running" | "paused";

export type FileStatus =
  "checking" | "failed" | "errors" | "final_check" | "top_review" | "in_batch";

/** A city of a handed-in file (step 39). */
export type CityState = "muted" | "in_batch" | "ready" | "needs_top" | "small";

export type FileCity = {
  key: string;
  name: string;
  businesses: number;
  state: CityState;
  tops: number;
  muted: string; // why, when it is muted
  moves_at: string | null; // a ready city goes on to the batch then
  moves_in: number | null; // seconds until then, by the server's clock
  moved_at: string | null;
};

/** A lead file handed in on the Files screen (step 31). */
export type HandedInFile = {
  id: string;
  number: number; // its businesses' File IDs are F<number>-0001… (step 35)
  file_name: string;
  niche: string;
  batch_name: string; // the niche's batch its cities go to (step 39)
  version: number;
  businesses: number;
  errors: number;
  warnings: number;
  status: FileStatus;
  uploaded_by: string | null;
  mine: boolean;
  created_at: string;
  updated_at: string;
  same_as: string | null;
  // Its cities (step 39): those going on to the batch, and how many are in it, ready or muted.
  cities_going: number;
  cities_in_batch: number;
  cities_ready: number;
  cities_muted: number;
  // Checked in the background (step 33): how far, and why it couldn't be read.
  progress: number;
  error: string | null;
  sends_at: string | null; // in its Final check: when it goes on to Top Review (step 36)
  sends_in: number | null; // seconds until then, by the server's clock (the viewer's may be off)
  can_send_cities: boolean; // may send its ready cities to the batch now
  has_duplicates: boolean; // Remove duplicates first, then the fix file downloads (step 40)
};

/** A business of a handed-in file, for the Files table (step 33). */
export type FileLead = {
  id: string; // the File ID, "F12-0014" (step 35)
  tab: string;
  line: number;
  rows: string[];
  values: Record<string, string>;
  issues: { field: string; code: string; severity: "error" | "warning"; message: string }[];
};

export type FileLeadsPage = {
  total: number;
  page: number;
  pages: number;
  counts: { all: number; problems: number; errors: number; warnings: number; ok: number };
  cities: string[];
  leads: FileLead[];
};

export type FileLeadFilters = {
  search?: string;
  city?: string;
  problems?: "" | "problems" | "errors" | "warnings" | "ok";
  sort?: "row" | "id" | "name" | "city" | "reviews" | "rating" | "problems";
  page?: number;
};

/** A handed-in file's fix file back from Excel (step 34): what changes, or what changed. */
export type FileFixResult = {
  saved: boolean;
  whole_file: boolean; // no File ID column: a whole new version of the file (step 37)
  version_after: number;
  rows: number;
  changed: {
    tab: string;
    line: number;
    file_id: string;
    business_name: string;
    changes: { field: string; from: string; to: string }[];
  }[];
  removed: { tab: string; line: number; file_id: string; business_name: string }[];
  skipped: { tab: string; line: number; file_id: string; reason: string }[];
  businesses_after: number | null;
};

export type NicheRow = { id: string; name: string; uses: number };

/** A city in Top Review (steps 32 and 39). */
export type ReviewShown = "needs_top" | "ready" | "small";

export type ReviewRow = {
  file_id: string;
  file_name: string;
  number: number;
  niche: string;
  key: string;
  name: string;
  businesses: number;
  tops: number;
  state: ReviewShown;
  moves_at: string | null;
  moves_in: number | null;
};

export type ReviewList = { counts: Record<ReviewShown, number>; cities: ReviewRow[] };

export type ReviewCity = {
  key: string;
  name: string;
  state: ReviewShown;
  moves_at: string | null;
  moves_in: number | null;
  file_id: string;
  file_name: string;
  columns: { key: string; label: string }[];
  businesses: ReviewBusiness[];
  benchmark: BenchmarkHint | null; // ⭐ for the businesses that meet it (step 41)
};

/** A business of a city in Top Review (step 41): most reviews first. */
export type ReviewBusiness = {
  key: string;
  rows: string[];
  values: Record<string, string>;
  extra: Record<string, string>;
  top: boolean;
  likely: boolean; // meets the niche's benchmark: a likely Top
};

export type BenchmarkHint = { name: string; reviews: number | null; rating: number | null };

/** The cities under 10 on one page, to tick and save at once (step 41). */
export type SmallPage = {
  total: number;
  page: number;
  pages: number;
  columns: { key: string; label: string }[];
  benchmark: BenchmarkHint | null;
  cities: (ReviewRow & { businesses_list: ReviewBusiness[] })[];
};

export type FileProblem = {
  code: string;
  field: string;
  severity: "error" | "warning";
  message: string;
  tab: string;
  line: number;
  business: string | null;
  value: string;
};

export type HandedInFileDetail = HandedInFile & {
  tabs: Record<
    string,
    { errors: number; warnings: number; columns: { field: string; message: string }[] }
  >;
  problems: FileProblem[];
  cities: FileCity[];
  // What Remove duplicates takes out (step 40): extra rows of a business on several rows,
  // and businesses already handed in.
  duplicates: { rows: number; elsewhere: number };
};

export type Batch = {
  id: string;
  name: string;
  niche: string;
  benchmark: { id: string; name: string; version: number } | null;
  leads: number;
  top: number;
  files: number;
  bots: string[];
  status: BatchStatus;
  position: number;
  progress_pct: number | null;
  created_at: string;
  can_edit: boolean;
  can_run: boolean;
  can_rename: boolean;
  can_delete: boolean;
};

/** A job agents do (from their manifests), with the agents that do it. */
export type Task = {
  id: string;
  key: string;
  name: string;
  bots: { key: string; name: string; enabled: boolean; about: string }[];
  batches: string[];
};

/** A batch's task: its job, name, the jobs of this batch's tasks it needs, how agents share. */
export type BatchTaskIn = {
  task_id: string;
  name?: string;
  needs: string[];
  share?: Share;
};

export type Share = "all" | "split";

export type BotProgress = {
  key: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  done: number;
  failed: number;
  ready: number;
  waiting: number;
  average_score: number | null;
};

export type PipelineTask = {
  task_id: string;
  key: string;
  job: string;
  name: string;
  needs: { task_id: string; name: string }[];
  share: Share;
  bots: BotProgress[];
  can_remove: boolean;
};

export type Pipeline = {
  batch: Batch;
  steps: { step: number; tasks: PipelineTask[] }[];
  can_start: boolean;
  start_problem: string | null;
};

export type Outcome = "done" | "skipped" | "failed" | "not_yet";
export type Band = "low" | "mid" | "high";

export type BotResults = {
  bot: string;
  bot_name: string;
  outcomes: Record<Outcome, number>;
  bands: Record<Band, number>;
  leads: {
    lead_id: string;
    business_name: string;
    city: string;
    outcome: Outcome;
    status: string | null;
    score: number | null;
    summary: string;
    at: string | null;
  }[];
  total: number;
  page: number;
  pages: number;
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
    public details: Record<string, unknown> = {},
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
    data as {
      error?: {
        code?: string;
        message?: string;
        fields?: Record<string, string>;
        details?: Record<string, unknown>;
      };
    } | null
  )?.error;
  return new ApiError(
    status,
    error?.code ?? "error",
    error?.message ?? `Something went wrong (${status}).`,
    error?.fields ?? {},
    error?.details ?? {},
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

/** A file upload that reports how much is sent (0-100), for big lead files (step 33). */
function uploadWithProgress<T>(
  path: string,
  form: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}`);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () =>
      reject(new ApiError(0, "network", "The server can't be reached. Check your connection."));
    xhr.onload = () => {
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(toApiError(xhr.status, data));
    };
    xhr.send(form);
  });
}

/** Download a file from the API, saying why when it can't be had (step 33). */
export async function download(path: string, fallbackName: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network", "The server can't be reached. Check your connection.");
  }
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    throw toApiError(response.status, data);
  }
  const blob = await response.blob();
  const named = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = named?.[1] ?? fallbackName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
  agentKinds: () => request<AgentKind[]>("GET", "/agents/kinds"),
  addAgent: (key: string, name: string) =>
    request<{ agent: Agent; token: string }>("POST", "/agents", { key, name }),
  addBuiltInAgent: (kind: string, name: string, taskId?: string) =>
    request<{ agent: Agent; token: null }>("POST", "/agents", {
      kind,
      name,
      task_id: taskId || undefined,
    }),
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
  // A fix file back from Excel (step 28): a preview, or saved with `confirm`.
  uploadFixes: (batchId: string, file: File, confirm: boolean) => {
    const form = new FormData();
    form.append("file", file);
    form.append("confirm", confirm ? "true" : "false");
    return upload<FixResult>(`/batches/${batchId}/fixes`, form);
  },
  imports: (batchId?: string) =>
    request<LeadImport[]>("GET", `/imports${batchId ? `?batch_id=${batchId}` : ""}`),
  importSheet: (id: string, filters: { tab?: string; status?: SheetStatus | ""; page?: number }) =>
    request<ImportSheet>("GET", `/imports/${id}/sheet${leadQuery(filters)}`),
  confirmImport: (id: string) => request<LeadImport>("POST", `/imports/${id}/confirm`),
  discardImport: (id: string) => request<LeadImport>("POST", `/imports/${id}/discard`),
  niches: () => request<string[]>("GET", "/niches"),
  // The Files screen (step 31).
  files: () => request<HandedInFile[]>("GET", "/submissions"),
  fileNiches: () => request<string[]>("GET", "/submissions/niches"),
  file: (id: string) => request<HandedInFileDetail>("GET", `/submissions/${id}`),
  handIn: (file: File, niche: string, onProgress?: (percent: number) => void) => {
    const form = new FormData();
    form.append("file", file);
    form.append("niche", niche);
    return uploadWithProgress<HandedInFileDetail>("/submissions", form, onProgress);
  },
  uploadFileFixes: (id: string, file: File, confirm: boolean) => {
    const form = new FormData();
    form.append("file", file);
    form.append("confirm", confirm ? "true" : "false");
    return upload<FileFixResult>(`/submissions/${id}/fixes`, form);
  },
  fileLeads: (id: string, filters: FileLeadFilters) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(filters))
      if (value !== undefined && value !== "") params.set(name, String(value));
    const query = params.toString();
    return request<FileLeadsPage>("GET", `/submissions/${id}/leads${query ? `?${query}` : ""}`);
  },
  // Niches (step 33).
  addNiche: (name: string, confirm = false) =>
    request<{ name: string; created: boolean }>("POST", "/niches", { name, confirm }),
  allNiches: () => request<NicheRow[]>("GET", "/niches/all"),
  renameNiche: (id: string, name: string) => request<NicheRow>("PATCH", `/niches/${id}`, { name }),
  deleteNiche: (id: string) => request<void>("DELETE", `/niches/${id}`),
  deleteFile: (id: string) => request<void>("DELETE", `/submissions/${id}`),
  sendToReview: (id: string) => request<HandedInFile>("POST", `/submissions/${id}/send`),
  removeDuplicates: (id: string) =>
    request<HandedInFileDetail>("POST", `/submissions/${id}/remove-duplicates`),
  // A file's ready cities (or one) to their batch now (step 39).
  sendCities: (id: string, city?: string) =>
    request<HandedInFileDetail>("POST", `/submissions/${id}/to-batch`, city ? { city } : {}),
  unmuteCity: (id: string, city: string) =>
    request<HandedInFileDetail>(
      "POST",
      `/submissions/${id}/cities/${encodeURIComponent(city)}/unmute`,
    ),
  // Top Review (steps 32 and 39).
  reviewCities: (show: ReviewShown) => request<ReviewList>("GET", `/review/cities?show=${show}`),
  reviewCity: (id: string, city: string) =>
    request<ReviewCity>("GET", `/review/files/${id}/cities/${encodeURIComponent(city)}`),
  smallCities: (page: number) => request<SmallPage>("GET", `/review/small?page=${page}`),
  saveManyTops: (cities: { file_id: string; city: string; tops: string[] }[]) =>
    request<{ saved: number }>("PUT", "/review/tops", { cities }),
  saveTops: (id: string, city: string, tops: string[]) =>
    request<ReviewRow>("PUT", `/review/files/${id}/cities/${encodeURIComponent(city)}`, {
      tops,
    }),
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
  orderBatches: (ids: string[]) => request<Batch[]>("PUT", "/batches/order", { ids }),
  pipeline: (id: string) => request<Pipeline>("GET", `/batches/${id}/pipeline`),
  startBatch: (id: string) => request<Pipeline>("POST", `/batches/${id}/start`),
  pauseBatch: (id: string) => request<Pipeline>("POST", `/batches/${id}/pause`),
  addBatchTask: (id: string, body: BatchTaskIn) =>
    request<Pipeline>("POST", `/batches/${id}/tasks`, body),
  // GBP Audit + Website Audit → Opportunity Finder → Email Writer (step 24).
  addStandardTasks: (id: string) => request<Pipeline>("POST", `/batches/${id}/tasks/standard`),
  updateBatchTask: (
    id: string,
    taskId: string,
    patch: { name?: string; needs?: string[]; share?: Share },
  ) => request<Pipeline>("PATCH", `/batches/${id}/tasks/${taskId}`, patch),
  removeBatchTask: (id: string, taskId: string) =>
    request<Pipeline>("DELETE", `/batches/${id}/tasks/${taskId}`),
  addBot: (id: string, taskId: string, key: string) =>
    request<Pipeline>("POST", `/batches/${id}/tasks/${taskId}/bots`, { key }),
  removeBot: (id: string, taskId: string, key: string) =>
    request<Pipeline>("DELETE", `/batches/${id}/tasks/${taskId}/bots/${key}`),
  botResults: (
    id: string,
    filters: { bot: string; outcome?: Outcome | ""; band?: Band | ""; page?: number },
  ) => request<BotResults>("GET", `/batches/${id}/results${leadQuery(filters)}`),
  tasks: () => request<Task[]>("GET", "/tasks"),
  leads: (filters: LeadFilters) => request<LeadPage>("GET", `/leads${leadQuery(filters)}`),
  lead: (id: string) => request<LeadDetail>("GET", `/leads/${id}`),
  updateLead: (id: string, patch: LeadPatch) => request<LeadDetail>("PATCH", `/leads/${id}`, patch),
  deleteLead: (id: string) => request<void>("DELETE", `/leads/${id}`),
  // Top is chosen in one city of a batch (SPEC step 19).
  markTop: (batchId: string, city: string, leadIds: string[], top: boolean) =>
    request<{ changed: number }>("POST", "/leads/top", {
      batch_id: batchId,
      city,
      lead_ids: leadIds,
      top,
    }),
  batchCities: (batchId: string) => request<LeadList[]>("GET", `/batches/${batchId}/cities`),
  switchAllCities: (batchId: string, active: boolean, small?: boolean, ready?: boolean) =>
    request<LeadList[]>("PUT", `/batches/${batchId}/cities`, { active, small, ready }),
  importDeletion: (id: string) =>
    request<{ leads_going: number; leads_staying: number; batch_running: boolean }>(
      "GET",
      `/imports/${id}/deletion`,
    ),
  deleteImport: (id: string) => request<void>("DELETE", `/imports/${id}`),
  checkReport: (id: string) => request<CheckReport>("GET", `/imports/${id}/check`),
  checkAgain: (id: string) => request<CheckReport>("POST", `/imports/${id}/check`),
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
