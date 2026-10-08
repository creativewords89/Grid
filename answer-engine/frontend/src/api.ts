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

  health: () => request<Health>("GET", "/health"),
};
