import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api, ApiError, type FileList, type FileTypeFilter, type StoredFile } from "../api";
import { useAuth } from "../auth";
import { Alert, Confirm } from "../components/ui";
import { formatDate, formatSize } from "../format";
import { Trash } from "./Trash";

// SPEC section 6.1. The server checks the real type from the content.
const ACCEPT = ".pdf,.docx,.xlsx,.csv,.png,.jpg,.jpeg,.webp,.tif,.tiff,.heic";
const MAX_BATCH = 20;
const POLL_MS = 3000;

/** Pages for documents, sheets for Excel workbooks. */
function extent(file: StoredFile): string {
  if (file.page_count !== null) return String(file.page_count);
  if (file.sheet_count !== null)
    return file.sheet_count === 1 ? "1 sheet" : `${file.sheet_count} sheets`;
  return "—";
}

const STATUS_LABEL = {
  queued: "Queued",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

type Upload = {
  key: string;
  name: string;
  progress: number;
  state: "waiting" | "uploading" | "done" | "error";
  message?: string;
};

export function Documents() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"files" | "trash">("files");
  const isOwner = user?.role === "owner";

  return (
    <section className="page">
      <div className="page-head">
        <h1>Documents</h1>
        {isOwner && (
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}>
              Files
            </button>
            <button role="tab" aria-selected={tab === "trash"} onClick={() => setTab("trash")}>
              Trash
            </button>
          </div>
        )}
      </div>
      {tab === "files" ? <Files /> : <Trash />}
    </section>
  );
}

function Files() {
  const [data, setData] = useState<FileList | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<FileTypeFilter | "">("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<StoredFile | null>(null);

  const load = useCallback(() => {
    api
      .listFiles(query.trim(), type)
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [query, type]);

  useEffect(() => {
    const timer = window.setTimeout(load, 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Keep statuses fresh while anything is still being read.
  const busy = data?.files.some((f) => f.status === "queued" || f.status === "processing");
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  const update = (key: string, patch: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  async function uploadAll(picked: File[]) {
    if (picked.length === 0) return;
    const batch = picked.slice(0, MAX_BATCH);
    setNotice(
      picked.length > MAX_BATCH
        ? `Only the first ${MAX_BATCH} files were uploaded. Add the rest in another batch.`
        : "",
    );
    const items = batch.map((file, i) => ({
      file,
      upload: {
        key: `${Date.now()}-${i}`,
        name: file.name,
        progress: 0,
        state: "waiting" as const,
      },
    }));
    setUploads((list) => [...items.map((i) => i.upload), ...list]);
    for (const { file, upload } of items) {
      update(upload.key, { state: "uploading" });
      try {
        const result = await api.uploadFile(file, (progress) => update(upload.key, { progress }));
        update(
          upload.key,
          result.error
            ? { state: "error", message: result.error.message }
            : { state: "done", progress: 100 },
        );
      } catch (err) {
        update(upload.key, {
          state: "error",
          message: err instanceof ApiError ? err.message : "Upload failed.",
        });
      }
      load();
    }
  }

  async function replace(file: StoredFile, picked: File) {
    try {
      await api.newVersion(file.id, picked);
      setNotice(
        `New version of ${file.name} uploaded. The old one is used until the new one is ready.`,
      );
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Not uploaded.");
    }
    load();
  }

  async function act(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      setNotice(done);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Something went wrong.");
    }
    load();
  }

  return (
    <>
      <DropZone onFiles={(files) => void uploadAll(files)} />
      {uploads.length > 0 && (
        <UploadList
          uploads={uploads}
          onClear={() =>
            setUploads((l) => l.filter((u) => u.state === "uploading" || u.state === "waiting"))
          }
        />
      )}
      {notice && <Alert kind="info">{notice}</Alert>}
      <div className="toolbar">
        <input
          type="search"
          className="input"
          placeholder="Search documents"
          aria-label="Search documents"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="input"
          aria-label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as FileTypeFilter | "")}
        >
          <option value="">All types</option>
          <option value="pdf">PDF</option>
          <option value="word">Word</option>
          <option value="excel">Excel and CSV</option>
          <option value="image">Images</option>
        </select>
        {data && (
          <span className="muted small totals">
            {data.totals.files} files · {data.totals.pages} pages ·{" "}
            {data.totals.ocr_pages_this_month} scanned pages read this month
          </span>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {data && data.files.length === 0 && (
        <div className="card empty">
          <p>{query || type ? "No documents match." : "No documents yet. Upload some above."}</p>
        </div>
      )}
      {data && data.files.length > 0 && (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Pages / sheets</th>
                <th>Status</th>
                <th>Uploaded by</th>
                <th>Date</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.files.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  onReplace={(picked) => void replace(file, picked)}
                  onRetry={() =>
                    void act(() => api.retryFile(file.id), `${file.name} will be read again.`)
                  }
                  onDelete={() => setDeleting(file)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deleting && (
        <Confirm
          title="Delete this file?"
          message={
            <>
              <strong>{deleting.name}</strong> stops being used in answers straight away. The Owner
              can restore it from the trash for 30 days.
            </>
          }
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const file = deleting;
            setDeleting(null);
            void act(() => api.deleteFile(file.id), `${file.name} was moved to the trash.`);
          }}
        />
      )}
    </>
  );
}

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function drop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    onFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <div
      className={`dropzone ${over ? "over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <p>
        <strong>Drag files here</strong> or{" "}
        <button type="button" className="link-button" onClick={() => input.current?.click()}>
          browse
        </button>
      </p>
      <p className="muted small">
        PDF, Word, Excel, CSV and images (scans or photos) · up to 50 MB each · {MAX_BATCH} at a
        time
      </p>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        data-testid="upload-input"
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </div>
  );
}

function UploadList({ uploads, onClear }: { uploads: Upload[]; onClear: () => void }) {
  const finished = uploads.some((u) => u.state === "done" || u.state === "error");
  return (
    <div className="card uploads" aria-label="Uploads">
      <ul>
        {uploads.map((u) => (
          <li key={u.key} className={`upload upload-${u.state}`}>
            <span className="upload-name">{u.name}</span>
            <span className="upload-state">
              {u.state === "waiting" && "Waiting…"}
              {u.state === "uploading" && `Uploading ${u.progress}%`}
              {u.state === "done" && "✔ Added"}
              {u.state === "error" && `✘ ${u.message}`}
            </span>
          </li>
        ))}
      </ul>
      {finished && (
        <button type="button" className="link-button small" onClick={onClear}>
          Clear finished
        </button>
      )}
    </div>
  );
}

function FileRow({
  file,
  onReplace,
  onRetry,
  onDelete,
}: {
  file: StoredFile;
  onReplace: (picked: File) => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const versionInput = useRef<HTMLInputElement>(null);
  const viewable = file.mime === "application/pdf" || /^image\/(png|jpeg|webp)$/.test(file.mime);
  return (
    <tr>
      <td>
        <div className="cell-strong">
          {file.name}
          {file.version > 1 && <span className="tag">v{file.version}</span>}
        </div>
        <div className="muted small">{formatSize(file.size)}</div>
      </td>
      <td className="hide-narrow">{file.type}</td>
      <td className="hide-narrow">{extent(file)}</td>
      <td>
        <span className={`pill pill-file-${file.status}`}>{STATUS_LABEL[file.status]}</span>
        {file.status === "failed" && file.error && <div className="field-error">{file.error}</div>}
        {file.status === "ready" && file.warning && (
          <div className="file-warning">{file.warning}</div>
        )}
      </td>
      <td className="hide-narrow">{file.uploaded_by?.name ?? "—"}</td>
      <td className="hide-narrow nowrap">{formatDate(file.created_at)}</td>
      <td className="actions">
        <a
          className="button button-small"
          href={api.fileUrl(file.id, viewable)}
          target={viewable ? "_blank" : undefined}
          rel="noopener noreferrer"
        >
          Open
        </a>
        <button
          type="button"
          className="button button-small"
          onClick={() => versionInput.current?.click()}
        >
          New version
        </button>
        <input
          ref={versionInput}
          type="file"
          accept={ACCEPT}
          hidden
          aria-label={`New version of ${file.name}`}
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = "";
            if (picked) onReplace(picked);
          }}
        />
        {file.status === "failed" && (
          <button type="button" className="button button-small" onClick={onRetry}>
            Retry
          </button>
        )}
        {file.can_delete && (
          <button type="button" className="button button-small" onClick={onDelete}>
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}
