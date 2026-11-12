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

type SignedPage = {
  files: Array<{ path: string; url: string; headers: Record<string, string> }>;
  /** The next page of URLs, or null after the last. */
  nextPage: string | null;
};

type DirectUploadStart = SignedPage & { uploadId: string };

/** Files uploading at once. */
const CONCURRENCY = 6;

/**
 * Uploads straight to R2: Nap returns presigned URLs a page at a time, the browser PUTs each
 * file, and Nap commits the version. Returns false when Nap cannot sign URLs, so the caller can
 * fall back to an upload through the Worker.
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
  // Bytes sent: done files plus the ones in flight. A running total, since uploads can have many
  // thousands of files.
  let sent = 0;
  // Nap signs URLs a page at a time, and they last an hour. Ask for the next page only when the
  // queue runs out, so no URL waits long before it is used.
  const queue = [...data.files];
  let nextPage = data.nextPage ?? null;
  let fetching: Promise<void> | null = null;
  const take = async () => {
    while (true) {
      const next = queue.shift();
      if (next) return next;
      if (!nextPage) return null;
      fetching ??= fetchPage(nextPage).then((page) => {
        queue.push(...page.files);
        nextPage = page.nextPage;
        fetching = null;
      });
      await fetching;
    }
  };
  const worker = async () => {
    for (let next = await take(); next; next = await take()) {
      const file = byPath.get(next.path);
      if (!file) throw new Error(`Missing file: ${next.path}`);
      let mine = 0;
      await putFile(next.url, next.headers, file, (bytes) => {
        sent += bytes - mine;
        mine = bytes;
        onProgress(sent / total);
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  const committed = await fetch(`/api/uploads/${data.uploadId}/commit`, { method: "POST" });
  const result = (await committed.json().catch(() => ({}))) as { error?: string };
  if (!committed.ok) throw new Error(result.error ?? "Upload failed");
  return true;
}

async function fetchPage(url: string) {
  const response = await fetch(url);
  const data = (await response.json().catch(() => ({}))) as Partial<SignedPage> & {
    error?: string;
  };
  if (!response.ok || !data.files) throw new Error(data.error ?? "Upload failed");
  return { files: data.files, nextPage: data.nextPage ?? null };
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
