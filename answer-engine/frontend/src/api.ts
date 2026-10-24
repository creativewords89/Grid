// Typed calls to the `/api` routes (SPEC section 8). Every write sends the CSRF token.

export type Role = "owner" | "reviewer" | "user";

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  invited: boolean;
  telegram_linked: boolean;
  notify_channel: NotifyChannel;
  last_login_at: string | null;
  created_at: string;
};

export type Me = { user: User; csrf_token: string };

export type NotifyChannel = "in_app" | "email" | "telegram";

export type NotificationItem = {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  created_at: string;
  read_at: string | null;
};

export type NotificationList = { unread: number; items: NotificationItem[] };

export type Updates = {
  cursor: string;
  answers: { id: string; conversation_id: string | null; status: string }[];
  notifications: NotificationItem[];
  unread: number;
  files_changed: boolean;
  reviews_waiting: number | null;
};

export type FileStatus = "queued" | "processing" | "ready" | "failed";
export type FileTypeFilter = "pdf" | "word" | "excel" | "image";

export type StoredFile = {
  id: string;
  name: string;
  type: string;
  mime: string;
  size: number;
  status: FileStatus;
  error: string | null;
  warning: string | null;
  page_count: number | null;
  sheet_count: number | null;
  chunk_count: number;
  ocr_pages: number;
  progress_done: number | null;
  progress_total: number | null;
  sync_pending: boolean;
  version: number;
  previous_file_id: string | null;
  uploaded_by: { id: string; name: string } | null;
  created_at: string;
  can_delete: boolean;
};

export type FileList = {
  files: StoredFile[];
  totals: { files: number; pages: number; ocr_pages_this_month: number };
  max_upload_mb?: number;
};

export type UploadResult = {
  name: string;
  file: StoredFile | null;
  error: { code: string; message: string } | null;
};

export type TrashItem = {
  id: string;
  kind: "file" | "verified_answer" | "thread" | "conversation";
  ref_id: string;
  title: string;
  deleted_by: string | null;
  deleted_at: string;
  purge_at: string;
  reason: string | null;
};
export type LinkResult = { email_sent: boolean; link: string | null };
export type KbStatus = {
  configured: boolean;
  index: string;
  files_ready: number;
  chunks: number;
  pending_ops: number;
  pending_records: number;
  oldest_pending_at: string | null;
  retrying: boolean;
  last_error: string | null;
  last_check: {
    at: string;
    expected: number;
    in_pinecone: number;
    missing: number;
    extra: number;
    rebuild: boolean;
    error: string | null;
  } | null;
};

export type Source = {
  n: number;
  kind: "doc" | "verified";
  ref_id: string;
  file_id: string;
  file_name: string;
  label: string;
  page: number | null;
  sheet: string | null;
  score: number;
};

export type Conversation = {
  id: string;
  title: string;
  last_message_at: string;
  updated?: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
  created_at: string;
  answer: {
    id: string;
    sources: Source[];
    outcome: Outcome | null;
    status: AnswerStatus;
    stop_reason: string | null;
    corrected: boolean;
    confidence: number | null;
    feedback: Feedback | null;
    needs_info?: { question: string; asked_by: string } | null;
    original_text?: string | null;
    reviewed_at?: string | null;
  } | null;
};

export type Feedback = "up" | "down";
export type Outcome = "no_answer" | "low" | "high";
export type AnswerStatus =
  "auto" | "in_review" | "needs_info" | "verified" | "corrected" | "wrong_no_answer";

export type Confidence = { confidence: number; outcome: Outcome; status: AnswerStatus };

export type Person = { id: string; name: string };

export type LogRow = {
  id: string;
  created_at: string;
  asked_by: Person | null;
  kind: "chat" | "marketing";
  question: string;
  confidence: number | null;
  outcome: Outcome | null;
  status: AnswerStatus;
  flagged: boolean;
  feedback: Feedback | null;
  source_count: number;
};

export type LogPage = {
  items: LogRow[];
  total: number;
  page: number;
  page_size: number;
  stats: {
    answers_this_month: number;
    high_pct: number | null;
    corrected_pct: number | null;
    avg_review_minutes: number | null;
  };
  people: Person[];
  can_review: boolean;
};

export type LogFilters = {
  outcome?: Outcome | "unscored" | "";
  status?: AnswerStatus | "";
  flagged?: "true" | "";
  kind?: "chat" | "marketing" | "";
  person?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
  page?: number;
};

export type LogDetail = LogRow & {
  retrieval_query: string;
  original_text: string;
  current_text: string;
  sources: Source[];
  confidence_parts: {
    retrieval: number;
    support: "full" | "partial" | "none" | null;
    unsupported_claims: string[];
    reason: string | null;
  } | null;
  explanation: string;
  flag_note: string | null;
  model: string | null;
  stop_reason: string | null;
  cost_usd: number;
  conversation_id: string | null;
  can_review: boolean;
  reviews: ReviewHistory[];
};

export type ReviewState =
  "open" | "claimed" | "needs_info" | "approved" | "edited" | "rejected" | "cancelled";

export type ReviewRow = {
  id: string;
  number: number;
  reason: "low_confidence" | "no_answer" | "admin" | "flag";
  reason_label: string;
  state: ReviewState;
  created_at: string;
  question: string;
  kind: "chat" | "marketing";
  asked_by: Person | null;
  claimed_by: Person | null;
  answer_id: string;
  channel: string;
  thread_id: string | null;
};

export type ReviewDetail = ReviewRow & {
  original_text: string;
  current_text: string;
  sources: Source[];
  confidence: number | null;
  explanation: string;
  unsupported_claims: string[];
  no_answer: boolean;
  notes: {
    kind: "question_to_asker" | "asker_reply" | "reviewer_note";
    author: Person | null;
    body: string;
    created_at: string;
  }[];
  decided_by: Person | null;
  decided_at: string | null;
  final_text: string | null;
  note: string | null;
  mine: boolean;
};

export type ReviewAction = "approve" | "edit" | "reject" | "no_answer" | "needs_info";

export type ReviewHistory = {
  number: number;
  reason_label: string;
  state: ReviewState;
  created_at: string;
  claimed_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  final_text: string | null;
  note: string | null;
  notes: { kind: string; author: string | null; body: string; created_at: string }[];
};

export type SettingsData = {
  values: Record<string, unknown>;
  telegram: {
    configured: boolean;
    bot_username: string;
    seen_chats: { id: number; title: string }[];
  };
  models: {
    choices: { id: string; input_usd: number; output_usd: number }[];
    efforts: string[];
    server: { answer_model: string; rewrite_model: string; check_model: string };
  };
};

export type UsageTotals = {
  requests: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
};

export type UsageData = {
  month: string;
  total: UsageTotals;
  alert_usd: number;
  by_kind: (UsageTotals & { kind: string })[];
  by_day: (UsageTotals & { date: string })[];
  by_person: (UsageTotals & { user_id: string | null; name: string })[];
};

export type SystemData = {
  version: string;
  environment: string;
  queued_jobs: number;
  oldest_queued_at: string | null;
  failed_jobs_7d: number;
  failed_jobs: { id: string; kind: string; attempts: number; error: string; at: string }[];
  backup: {
    found: boolean;
    ok: boolean | null;
    at: string | null;
    size_bytes: number | null;
    off_server: boolean | null;
    message: string | null;
    late: boolean;
  };
};

export type AuditEntry = {
  id: string;
  actor: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  title: string | null;
  changes: { field: string; from: unknown; to: unknown }[];
  at: string;
};

export type TelegramCode = { code: string; expires_at: string; bot_username: string };

export type Gap = {
  question: string;
  count: number;
  last_asked_at: string | null;
  answer_ids: string[];
  examples: string[];
};

export type ConversationDetail = Conversation & {
  messages: ChatMessage[];
  updated_answer_ids?: string[];
};

export type VerifiedStatus = "active" | "disabled" | "expired";

export type VerifiedRow = {
  id: string;
  question: string;
  answer: string;
  status: VerifiedStatus;
  expires_at: string | null;
  needs_check: boolean;
  needs_check_reason: string | null;
  approved_by: Person | null;
  origin: "review" | "admin" | "marketing";
  version: number;
  updated_at: string;
};

export type VerifiedDetail = VerifiedRow & {
  sources: { file_id: string; name: string; available: boolean }[];
  origin_answer_id: string | null;
  created_at: string;
  can_manage: boolean;
};

export type VerifiedPage = {
  items: VerifiedRow[];
  can_manage: boolean;
  counts: Record<"active" | "disabled" | "expired" | "needs_check" | "all", number>;
};

export type VerifiedVersion = {
  version: number;
  question: string;
  answer: string;
  changed_by: Person | null;
  at: string;
};

export type VerifiedPatch = {
  question?: string;
  answer?: string;
  expires_at?: string;
  clear_expiry?: boolean;
  checked?: boolean;
};

export type Community = { id: string; name: string; notes: string };

export type Platform = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  parser: "reddit" | "facebook" | "generic";
  hosts: string[];
  style_prompt: string;
  disclosure_line: string | null;
  position: number;
  communities: Community[];
};

export type ThreadStatus =
  "waiting_for_us" | "in_review" | "ready_to_post" | "waiting_for_them" | "closed";

export type ThreadRow = {
  id: string;
  platform: string;
  platform_name: string;
  community: string | null;
  title: string;
  original_url: string;
  person: string | null;
  status: ThreadStatus;
  created_by: Person | null;
  posted_by: Person[];
  last_activity_at: string;
  created_at: string;
};

export type ThreadList = { items: ThreadRow[]; counts: Record<ThreadStatus, number> };

export type DraftState = "draft" | "in_review" | "ready" | "posted" | "discarded";

export type ThreadMessage = {
  id: string;
  parent_id: string | null;
  author: "them" | "us";
  author_name: string | null;
  body: string;
  external_url: string | null;
  state: DraftState | null;
  posted_by: Person | null;
  posted_at: string | null;
  created_by: Person | null;
  created_at: string;
  draft: {
    answer_id: string;
    confidence: number | null;
    outcome: Outcome | null;
    status: AnswerStatus;
    sources: Source[];
    needs_info: { question: string; asked_by: string } | null;
    corrected_after_post: string | null;
  } | null;
};

export type ThreadDetail = ThreadRow & {
  closed_at: string | null;
  close_reason: "manual" | "inactive" | null;
  messages: ThreadMessage[];
  can_close: boolean;
  can_delete: boolean;
};

export type NameMatch = {
  thread: ThreadRow;
  first_question: string;
  our_last_reply: string | null;
  closest: boolean;
};

export type Resolved = {
  found: boolean;
  parsed: {
    platform: string;
    platform_name: string;
    thread_id: string;
    community: string | null;
    comment_id: string | null;
  } | null;
  thread: ThreadRow | null;
  matched_message_id: string | null;
  reopened: boolean;
  error: string | null;
};

export type ThreadFilters = {
  status?: ThreadStatus;
  platform?: string;
  community?: string;
  mine?: boolean;
};

/** Sent back with a 409 "duplicate" when a verified answer to the question exists. */
export type DuplicateDetails = { id: string; question: string; answer: string };

export type AskHandlers = {
  onDelta: (text: string) => void;
  onReplace: (text: string) => void;
  onSources: (sources: Source[]) => void;
  onConfidence?: (confidence: Confidence) => void;
  onDone: (done: {
    answer_id: string;
    outcome: string | null;
    status?: AnswerStatus;
    stop_reason: string | null;
  }) => void;
  onError: (message: string) => void;
};

/** Stream an answer: the server sends `event: name` / `data: json` blocks. */
async function askStream(chatId: string, question: string, on: AskHandlers): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/conversations/${chatId}/ask`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ question }),
    });
  } catch {
    on.onError("The server can't be reached. Check your connection.");
    return;
  }
  if (!response.ok || !response.body) {
    const data: unknown = await response.json().catch(() => null);
    on.onError(toApiError(response.status, data).message);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (block: string) => {
    let name = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!name || !data) return;
    const payload = JSON.parse(data);
    if (name === "delta") on.onDelta(payload.text);
    else if (name === "replace") on.onReplace(payload.text);
    else if (name === "sources") on.onSources(payload.sources);
    else if (name === "confidence") on.onConfidence?.(payload);
    else if (name === "done") on.onDone(payload);
    else if (name === "error") on.onError(payload.message);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      handle(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }
  if (buffer.trim()) handle(buffer);
}

export type Health = { status: "ok" | "error"; version: string; checks: Record<string, string> };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
    public details: Record<string, unknown> | null = null,
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
    error?.details ?? null,
  );
}

/** POST a file with upload progress (fetch can't report it). */
function sendFile<T>(path: string, field: string, file: File, onProgress?: (pct: number) => void) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}`);
    xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () =>
      reject(
        new ApiError(0, "network", "The upload stopped. Check your connection and try again."),
      );
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // not JSON (e.g. the web server refused a huge upload)
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else if (xhr.status === 413) reject(new ApiError(413, "too_large", "This file is too big."));
      else reject(toApiError(xhr.status, data));
    };
    const form = new FormData();
    form.append(field, file);
    xhr.send(form);
  });
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

export const api = {
  me: () => request<Me>("GET", "/auth/me"),
  login: (email: string, password: string) =>
    request<Me>("POST", "/auth/login", { email, password }),
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

  updateProfile: (name: string) => request<User>("PATCH", "/me", { name }),
  setChannel: (notify_channel: NotifyChannel) => request<User>("PATCH", "/me", { notify_channel }),
  listNotifications: () => request<NotificationList>("GET", "/notifications"),
  markRead: (ids?: string[]) =>
    request<NotificationList>("POST", "/notifications/read", ids ? { ids } : {}),
  updates: (since: string | null) =>
    request<Updates>("GET", `/updates${since ? `?since=${encodeURIComponent(since)}` : ""}`),
  changePassword: (current_password: string, new_password: string) =>
    request<{ message: string }>("POST", "/me/password", { current_password, new_password }),

  listFiles: (q = "", type: FileTypeFilter | "" = "") => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    const query = params.toString();
    return request<FileList>("GET", `/files${query ? `?${query}` : ""}`);
  },
  uploadFile: async (file: File, onProgress?: (pct: number) => void): Promise<UploadResult> => {
    const { results } = await sendFile<{ results: UploadResult[] }>(
      "/files",
      "files",
      file,
      onProgress,
    );
    return results[0]!;
  },
  newVersion: (id: string, file: File, onProgress?: (pct: number) => void) =>
    sendFile<StoredFile>(`/files/${id}/version`, "file", file, onProgress),
  retryFile: (id: string) => request<StoredFile>("POST", `/files/${id}/retry`),
  deleteFile: (id: string) => request<void>("DELETE", `/files/${id}`),
  fileUrl: (id: string, inline = false) =>
    `/api/files/${id}/download${inline ? "?inline=true" : ""}`,

  listTrash: () => request<TrashItem[]>("GET", "/trash"),
  restoreTrash: (id: string) => request<void>("POST", `/trash/${id}/restore`),
  purgeTrash: (id: string) => request<void>("DELETE", `/trash/${id}`),

  listConversations: () => request<Conversation[]>("GET", "/conversations"),
  createConversation: () => request<Conversation>("POST", "/conversations", {}),
  feedback: (answerId: string, value: Feedback | "none", note?: string) =>
    request<{ feedback: Feedback | null; flagged: boolean }>(
      "POST",
      `/answers/${answerId}/feedback`,
      note ? { value, note } : { value },
    ),
  answerLog: (filters: LogFilters = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const query = params.toString();
    return request<LogPage>("GET", `/answer-log${query ? `?${query}` : ""}`);
  },
  answerDetail: (id: string) => request<LogDetail>("GET", `/answer-log/${id}`),
  knowledgeGaps: () => request<Gap[]>("GET", "/answer-log/gaps"),
  needsInfoReply: (answerId: string, text: string) =>
    request<{ status: AnswerStatus }>("POST", `/answers/${answerId}/needs-info-reply`, { text }),

  listReviews: (show: "waiting" | "mine" | "decided" = "waiting") =>
    request<ReviewRow[]>("GET", `/reviews?show=${show}`),
  reviewCount: () => request<{ waiting: number }>("GET", "/reviews/count"),
  getReview: (id: string) => request<ReviewDetail>("GET", `/reviews/${id}`),
  claimReview: (id: string) => request<ReviewDetail>("POST", `/reviews/${id}/claim`),
  releaseReview: (id: string) => request<ReviewDetail>("POST", `/reviews/${id}/release`),
  decideReview: (
    id: string,
    action: ReviewAction,
    text?: string,
    note?: string,
    verified_choice?: string,
    add_to_kb?: boolean,
  ) =>
    request<ReviewDetail>("POST", `/reviews/${id}/decide`, {
      action,
      text,
      note,
      verified_choice,
      add_to_kb,
    }),
  adminReview: (
    answerId: string,
    action: Exclude<ReviewAction, "needs_info">,
    text?: string,
    note?: string,
    verified_choice?: string,
  ) =>
    request<{ status: AnswerStatus; current_text: string; review_number: number }>(
      "POST",
      `/answers/${answerId}/admin-review`,
      { action, text, note, verified_choice },
    ),

  listVerified: (show = "active", q = "") =>
    request<VerifiedPage>(
      "GET",
      `/verified?show=${encodeURIComponent(show)}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    ),
  getVerified: (id: string) => request<VerifiedDetail>("GET", `/verified/${id}`),
  updateVerified: (id: string, patch: VerifiedPatch) =>
    request<VerifiedDetail>("PATCH", `/verified/${id}`, patch),
  disableVerified: (id: string) => request<VerifiedDetail>("POST", `/verified/${id}/disable`),
  enableVerified: (id: string) => request<VerifiedDetail>("POST", `/verified/${id}/enable`),
  deleteVerified: (id: string) => request<void>("DELETE", `/verified/${id}`),
  verifiedHistory: (id: string) => request<VerifiedVersion[]>("GET", `/verified/${id}/history`),
  restoreVerifiedVersion: (id: string, version: number) =>
    request<VerifiedDetail>("POST", `/verified/${id}/restore-version`, { version }),

  telegramCode: () => request<TelegramCode>("POST", "/me/telegram-link"),
  telegramUnlink: () => request<void>("DELETE", "/me/telegram-link"),

  platforms: () => request<Platform[]>("GET", "/platforms"),
  addPlatform: (body: {
    name: string;
    slug: string;
    hosts: string[];
    style_prompt?: string;
    disclosure_line?: string | null;
  }) => request<Platform>("POST", "/platforms", body),
  updatePlatform: (
    id: string,
    patch: Partial<
      Pick<Platform, "name" | "enabled" | "hosts" | "style_prompt" | "disclosure_line">
    >,
  ) => request<Platform>("PATCH", `/platforms/${id}`, patch),
  addCommunity: (platformId: string, name: string, notes: string) =>
    request<Platform>("POST", `/platforms/${platformId}/communities`, { name, notes }),
  updateCommunity: (id: string, notes: string) =>
    request<Platform>("PATCH", `/communities/${id}`, { notes }),
  deleteCommunity: (id: string) => request<void>("DELETE", `/communities/${id}`),

  resolveThread: (url: string) => request<Resolved>("POST", "/threads/resolve", { url }),
  createThread: (body: {
    url?: string;
    platform?: string;
    question: string;
    title?: string;
    author_name?: string;
  }) => request<ThreadDetail>("POST", "/threads", body),
  threadsByName: (name: string, text?: string) => {
    const params = new URLSearchParams({ name });
    if (text) params.set("text", text);
    return request<NameMatch[]>("GET", `/threads/by-name?${params.toString()}`);
  },
  listThreads: (filters: ThreadFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.platform) params.set("platform", filters.platform);
    if (filters.community) params.set("community", filters.community);
    if (filters.mine) params.set("mine", "true");
    const query = params.toString();
    return request<ThreadList>("GET", `/threads${query ? `?${query}` : ""}`);
  },
  getThread: (id: string) => request<ThreadDetail>("GET", `/threads/${encodeURIComponent(id)}`),
  addReply: (
    id: string,
    body: { body: string; parent_id?: string; author_name?: string; url?: string },
  ) => request<ThreadDetail>("POST", `/threads/${encodeURIComponent(id)}/replies`, body),
  draftReply: (id: string, parent_id: string, instruction?: string) =>
    request<ThreadDetail>("POST", `/threads/${encodeURIComponent(id)}/draft`, {
      parent_id,
      instruction,
    }),
  editDraft: (messageId: string, body: string) =>
    request<ThreadDetail>("PATCH", `/thread-messages/${messageId}`, { body }),
  markPosted: (messageId: string, url?: string) =>
    request<ThreadDetail>("POST", `/thread-messages/${messageId}/posted`, url ? { url } : {}),
  closeThread: (id: string) =>
    request<ThreadDetail>("POST", `/threads/${encodeURIComponent(id)}/close`),
  reopenThread: (id: string) =>
    request<ThreadDetail>("POST", `/threads/${encodeURIComponent(id)}/reopen`),
  deleteThread: (id: string) => request<void>("DELETE", `/threads/${encodeURIComponent(id)}`),

  getSettings: () => request<SettingsData>("GET", "/settings"),
  updateSettings: (values: Record<string, unknown>) =>
    request<SettingsData>("PATCH", "/settings", { values }),
  telegramTest: () => request<{ message: string }>("POST", "/settings/telegram-test"),
  usage: (month?: string) =>
    request<UsageData>("GET", month ? `/usage?month=${encodeURIComponent(month)}` : "/usage"),
  system: () => request<SystemData>("GET", "/system"),
  audit: (before?: string) =>
    request<AuditEntry[]>(
      "GET",
      before ? `/audit?limit=30&before=${encodeURIComponent(before)}` : "/audit?limit=30",
    ),
  getConversation: (id: string) => request<ConversationDetail>("GET", `/conversations/${id}`),
  deleteConversation: (id: string) => request<void>("DELETE", `/conversations/${id}`),
  ask: askStream,

  kbStatus: () => request<KbStatus>("GET", "/kb/status"),
  kbRebuild: () => request<{ message: string }>("POST", "/kb/rebuild"),

  health: () => request<Health>("GET", "/health"),
};
