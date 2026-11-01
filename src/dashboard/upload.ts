import confetti from "canvas-confetti";

/** A file to upload, with its path inside the site. */
export type UploadFile = { file: File; path: string };

type DirectoryHandle = {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<DirectoryHandle | FileHandle>;
};

type FileHandle = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
};

export async function chooseFolder(
  fallbackInput: HTMLInputElement | null,
  onFiles: (files: FileList | null) => void,
) {
  const picker = (
    window as typeof window & {
      showDirectoryPicker?: () => Promise<DirectoryHandle>;
    }
  ).showDirectoryPicker;

  if (!picker) {
    fallbackInput?.click();
    return;
  }

  try {
    const root = await picker.call(window);
    const transfer = new DataTransfer();
    await collectDirectoryFiles(root, root.name, transfer);
    onFiles(transfer.files);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
  }
}

async function collectDirectoryFiles(
  directory: DirectoryHandle,
  path: string,
  transfer: DataTransfer,
) {
  for await (const entry of directory.values()) {
    const entryPath = `${path}/${entry.name}`;
    if (entry.kind === "directory") {
      await collectDirectoryFiles(entry, entryPath, transfer);
      continue;
    }

    const file = await entry.getFile();
    Object.defineProperty(file, "webkitRelativePath", { value: entryPath });
    transfer.items.add(file);
  }
}

type DirectUploadStart = {
  uploadId: string;
  files: Array<{ path: string; url: string; headers: Record<string, string> }>;
};

/**
 * Uploads straight to R2: Nap returns a presigned URL per file, the browser PUTs each file, and
 * Nap commits the version. Returns false when Nap cannot sign URLs, so the caller can fall back
 * to an upload through the Worker.
 */
export async function directUpload(
  files: Array<UploadFile>,
  fields: Record<string, string>,
  onProgress: (fraction: number) => void,
) {
  const started = await fetch("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...fields,
      files: files.map((item) => ({ path: item.path, size: item.file.size, type: item.file.type })),
    }),
  });
  const data = (await started.json().catch(() => ({}))) as Partial<DirectUploadStart> & {
    error?: string;
    code?: string;
  };
  if (started.status === 503 && data.code === "direct_uploads_unavailable") return false;
  if (!started.ok || !data.uploadId || !data.files) throw new Error(data.error ?? "Upload failed");

  const byPath = new Map(files.map((item) => [item.path, item.file]));
  const total = files.reduce((sum, item) => sum + item.file.size, 0) || 1;
  const sent = new Map<string, number>();
  const report = () => onProgress([...sent.values()].reduce((sum, n) => sum + n, 0) / total);
  const queue = [...data.files];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const file = byPath.get(next.path);
      if (!file) throw new Error(`Missing file: ${next.path}`);
      const { path } = next;
      await putFile(next.url, next.headers, file, (bytes) => {
        sent.set(path, bytes);
        report();
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

  const committed = await fetch(`/api/uploads/${data.uploadId}/commit`, { method: "POST" });
  const result = (await committed.json().catch(() => ({}))) as { error?: string };
  if (!committed.ok) throw new Error(result.error ?? "Upload failed");
  return true;
}

/** PUTs one file to a presigned URL, with progress. Retries network errors twice. */
async function putFile(
  url: string,
  headers: Record<string, string>,
  file: File,
  onBytes: (bytes: number) => void,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("PUT", url);
        for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
        request.upload.onprogress = (event) => onBytes(event.loaded);
        request.onload = () =>
          request.status >= 200 && request.status < 300
            ? resolve()
            : reject(new Error(`Upload of ${file.name} failed (${request.status})`));
        request.onerror = () => reject(new Error(`Upload of ${file.name} failed`));
        request.send(file);
      });
      onBytes(file.size);
      return;
    } catch (error) {
      onBytes(0);
      if (attempt >= 2) throw error;
    }
  }
}

export function normalizeUploadFiles(files: Array<File>) {
  const initial = files.map((file) => ({ file, path: getUploadPath(file) }));
  if (initial.length === 1 && initial[0].path.toLowerCase().endsWith(".html")) {
    return [{ ...initial[0], path: "index.html" }];
  }
  return stripCommonRoot(initial);
}

function getUploadPath(file: File) {
  const withDirectory = file as File & { webkitRelativePath?: string };
  return (withDirectory.webkitRelativePath || file.name).replace(/^\/+/, "");
}

function stripCommonRoot(items: Array<{ file: File; path: string }>) {
  if (items.some((item) => item.path === "index.html")) return items;
  const firstSegments = items.map((item) => item.path.split("/")[0]).filter(Boolean);
  const commonRoot = firstSegments[0];
  if (!commonRoot || !firstSegments.every((segment) => segment === commonRoot)) return items;
  return items.map((item) => ({
    ...item,
    path: item.path.split("/").slice(1).join("/") || item.path,
  }));
}

export function celebrate() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#7c5cff", "#4ade80", "#f6c453", "#f472b6", "#38bdf8"];
  const fire = (particleRatio: number, opts: confetti.Options) =>
    confetti({
      origin: { y: 0.7 },
      colors,
      disableForReducedMotion: true,
      particleCount: Math.floor(200 * particleRatio),
      ...opts,
    });
  fire(0.25, { spread: 26, startVelocity: 55 });
  fire(0.2, { spread: 60 });
  fire(0.35, { spread: 100, decay: 0.91, scalar: 0.8 });
  fire(0.1, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 });
  fire(0.1, { spread: 120, startVelocity: 45 });
}
