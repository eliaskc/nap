import type { NapFile, NapFileUploadOptions } from "./api";
import { NapError } from "./errors";
import { napPath } from "./paths";

/**
 * The page's files (nap.files): photos and other blobs up to 15 MB, stored by Nap for the site.
 * Who can read and write them follows who can view the page, like its collections.
 */
export async function upload(file: Blob, options: NapFileUploadOptions = {}): Promise<NapFile> {
  if (!(file instanceof Blob)) throw new NapError("nap.files.upload needs a Blob or File", 400);
  const name =
    options.name ?? (typeof File !== "undefined" && file instanceof File ? file.name : "");
  const headers: Record<string, string> = {
    "content-type": file.type || "application/octet-stream",
  };
  if (name) headers["x-nap-file-name"] = encodeURIComponent(name);
  const response = await fetch(napPath("files"), { method: "POST", headers, body: file });
  const result = (await response.json().catch(() => ({}))) as { error?: string; file?: NapFile };
  if (!response.ok || !result.file) {
    throw new NapError(result.error || "Nap upload failed", response.status);
  }
  return result.file;
}

/** A URL of the file for this page, such as for <img src>. */
export function url(id: string) {
  return napPath("files/" + encodeURIComponent(id));
}

export async function remove(id: string): Promise<void> {
  const response = await fetch(url(id), { method: "DELETE" });
  if (response.ok) return;
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  throw new NapError(result.error || "Nap request failed", response.status);
}
