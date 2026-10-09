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
  last_login_at: string | null;
  created_at: string;
};

export type Me = { user: User; csrf_token: string };

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

export type Conversation = { id: string; title: string; last_message_at: string };

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
};

export type Gap = {
  question: string;
  count: number;
  last_asked_at: string | null;
  answer_ids: string[];
  examples: string[];
};

export type ConversationDetail = Conversation & { messages: ChatMessage[] };

export type AskHandlers = {
  onDelta: (text: string) => void;
  onReplace: (text: string) => void;
  onSources: (sources: Source[]) => void;
  onConfidence?: (confidence: Confidence) => void;
  onDone: (done: { answer_id: string; outcome: string | null; stop_reason: string | null }) => void;
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
  if (!response.ok) {
    const error = (
      data as { error?: { code?: string; message?: string; fields?: Record<string, string> } }
    )?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "error",
      error?.message ?? `Something went wrong (${response.status}).`,
      error?.fields ?? {},
    );
  }
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
  getConversation: (id: string) => request<ConversationDetail>("GET", `/conversations/${id}`),
  deleteConversation: (id: string) => request<void>("DELETE", `/conversations/${id}`),
  ask: askStream,

  kbStatus: () => request<KbStatus>("GET", "/kb/status"),
  kbRebuild: () => request<{ message: string }>("POST", "/kb/rebuild"),

  health: () => request<Health>("GET", "/health"),
};
