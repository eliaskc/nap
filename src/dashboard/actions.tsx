import {
  ArrowRightLeftIcon,
  ArrowUpRightIcon,
  EditIcon,
  FileIcon,
  FolderArchiveIcon,
  HistoryIcon,
  LinkIcon,
  Trash2Icon,
  UserRoundPenIcon,
  UsersIcon,
} from "lucide-react";
import * as React from "react";
import { OwnerPicker, ShareAccess, type Access } from "~/components/share-access";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Progress } from "~/components/ui/progress";
import { Skeleton } from "~/components/ui/skeleton";
import type { Item, Site } from "~/dashboard/data";
import { formatBytes, formatDateTime, slugify } from "~/dashboard/format";
import { KindIcon } from "~/dashboard/kinds";
import {
  celebrate,
  chooseFolder,
  directUpload,
  normalizeUploadFiles,
  type UploadFile,
} from "~/dashboard/upload";
import { napLabel } from "~/lib/nap-urls";
import { napConfig } from "~/nap.config";

/** What every layout can do with an item. The dialogs live in <DashboardActions>. */
export type Actions = {
  open: (item: Item) => void;
  copyLink: (item: Item) => void;
  history: (site: Site) => void;
  share: (site: Site) => void;
  transfer: (site: Site) => void;
  rename: (site: Site) => void;
  toggleKind: (site: Site) => void;
  remove: (site: Site) => void;
  /** Pick files for a new version of this site, or for something new without one. */
  pickFiles: (target?: Site) => void;
  pickFolder: (target?: Site) => void;
  /** Files dropped on the page, or on an item (a new version, after asking). */
  drop: (files: FileList | null, target?: Site) => void;
  uploading: boolean;
  uploadProgress: number;
  uploadError: string;
};

const ActionsContext = React.createContext<Actions | null>(null);

export function useActions() {
  const actions = React.useContext(ActionsContext);
  if (!actions) throw new Error("useActions outside <DashboardActions>");
  return actions;
}

type PendingUpload = {
  target: Site;
  files: Array<UploadFile>;
  fileCount: number;
  sizeLabel: string;
};

/** Holds the dialogs for renaming, sharing, history and so on, and gives layouts the actions. */
export function DashboardActions({
  refresh,
  onSiteChange,
  children,
}: {
  refresh: (quiet?: boolean) => Promise<void>;
  /** Optimistic local change, before the refresh. */
  onSiteChange: (slug: string, change: Partial<Site>) => void;
  children: React.ReactNode;
}) {
  const hostSuffix = napConfig.rootDomain;
  const [pendingUpload, setPendingUpload] = React.useState<PendingUpload | null>(null);
  const [publishProgress, setPublishProgress] = React.useState(0);
  const [uploading, setUploading] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState(0);
  const [uploadError, setUploadError] = React.useState("");
  const [renamingSite, setRenamingSite] = React.useState<Site | null>(null);
  const [renameTitle, setRenameTitle] = React.useState("");
  const [renameSlug, setRenameSlug] = React.useState("");
  const [renameError, setRenameError] = React.useState("");
  const [transferSite, setTransferSite] = React.useState<Site | null>(null);
  const [transferEmail, setTransferEmail] = React.useState("");
  const [transferError, setTransferError] = React.useState("");
  const [transferring, setTransferring] = React.useState(false);
  const [deletingSite, setDeletingSite] = React.useState<Site | null>(null);
  const [sharingSite, setSharingSite] = React.useState<Site | null>(null);
  const [shareAccess, setShareAccess] = React.useState<Access>({
    visibility: "private",
    emails: [],
  });
  const [shareError, setShareError] = React.useState("");
  const shareQueue = React.useRef<Promise<unknown>>(Promise.resolve());
  const [historySite, setHistorySite] = React.useState<Site | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement>(null);
  const pickTarget = React.useRef<Site | undefined>(undefined);

  async function upload(
    files: Array<UploadFile>,
    target?: Site,
    onProgress: (fraction: number) => void = () => {},
  ) {
    // New uploads from the dashboard start as artifacts, like an agent's first publish.
    const fields: Record<string, string> = target
      ? { targetSlug: target.slug, expectedCurrentVersion: target.currentVersion }
      : { kind: "artifact" };
    // Files go straight to R2. Without R2 signing (local development), through the Worker.
    if (await directUpload(files, fields, onProgress)) return;
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    for (const item of files) form.append("files", item.file, item.path);
    const response = await fetch("/api/upload", { method: "POST", body: form });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Upload failed");
  }

  async function uploadNew(files: Array<UploadFile>) {
    setUploading(true);
    setUploadProgress(0);
    try {
      await upload(files, undefined, (fraction) => setUploadProgress(Math.round(fraction * 100)));
      celebrate();
      await refresh(true);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  function drop(files: FileList | null, target?: Site) {
    if (!files?.length) return;
    const normalized = normalizeUploadFiles(Array.from(files));
    if (!normalized.some((item) => item.path === "index.html")) {
      setUploadError("Add an index.html file at the root, or drop a single HTML file.");
      return;
    }
    setUploadError("");
    if (!target) {
      void uploadNew(normalized);
      return;
    }
    if (target.hasSource) {
      setUploadError(`${target.title} keeps its source in Nap. Ask an agent to change it.`);
      return;
    }
    setPendingUpload({
      target,
      files: normalized,
      fileCount: normalized.length,
      sizeLabel: formatBytes(normalized.reduce((sum, item) => sum + item.file.size, 0)),
    });
  }

  async function publishUpload() {
    if (!pendingUpload) return;
    setPublishProgress(5);
    try {
      await upload(pendingUpload.files, pendingUpload.target, (fraction) =>
        setPublishProgress(Math.max(5, Math.round(fraction * 90))),
      );
      setPublishProgress(95);
      celebrate();
      setPendingUpload(null);
      await refresh(true);
    } catch (error) {
      console.error(error);
    } finally {
      setPublishProgress(0);
    }
  }

  async function renameSite() {
    if (!renamingSite) return;
    setRenameError("");
    const response = await fetch(`/api/sites/${renamingSite.slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: renameTitle, slug: slugify(renameSlug) }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setRenameError(body.error ?? "Rename failed");
      return;
    }
    setRenamingSite(null);
    await refresh(true);
  }

  async function transferOwner() {
    if (!transferSite || !transferEmail) return;
    setTransferring(true);
    setTransferError("");
    try {
      const response = await fetch(`/api/sites/${transferSite.slug}/owner`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: transferEmail }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not transfer it");
      setTransferSite(null);
      await refresh(true);
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : "Could not transfer it");
    } finally {
      setTransferring(false);
    }
  }

  async function deleteSite() {
    if (!deletingSite) return;
    const response = await fetch(`/api/sites/${deletingSite.slug}`, { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Delete failed");
    }
    setDeletingSite(null);
    await refresh(true);
  }

  /** Saves each change at once. Requests run in order, so the last change wins. */
  function changeShareAccess(site: Site, next: Access) {
    const previous = shareAccess;
    setShareAccess(next);
    setShareError("");
    shareQueue.current = shareQueue.current
      .then(async () => {
        const response = await fetch(`/api/sites/${site.slug}/access`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          // Keep the invited people when it is open to everyone, so switching back restores them.
          body: JSON.stringify(next),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Could not update access");
        await refresh(true);
      })
      .catch((error: unknown) => {
        setShareAccess(previous);
        setShareError(error instanceof Error ? error.message : "Could not update access");
      });
  }

  async function toggleKind(site: Site) {
    const kind = site.kind === "site" ? "artifact" : "site";
    onSiteChange(site.slug, { kind });
    try {
      const response = await fetch(`/api/sites/${site.slug}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not save the setting");
      }
    } finally {
      await refresh(true);
    }
  }

  const actions: Actions = {
    open: (item) => {
      if (item.kind === "app") window.location.assign(item.url);
      else window.open(item.url, "_blank", "noopener,noreferrer");
    },
    copyLink: (item) => {
      void navigator.clipboard.writeText(new URL(item.url, window.location.href).href);
    },
    history: setHistorySite,
    share: (site) => {
      setSharingSite(site);
      setShareAccess({ visibility: site.visibility, emails: site.viewerEmails });
      setShareError("");
    },
    transfer: (site) => {
      setTransferSite(site);
      setTransferEmail("");
      setTransferError("");
    },
    rename: (site) => {
      setRenamingSite(site);
      setRenameTitle(site.title);
      setRenameSlug(site.slug);
      setRenameError("");
    },
    toggleKind: (site) => void toggleKind(site),
    remove: setDeletingSite,
    pickFiles: (target) => {
      pickTarget.current = target;
      fileInput.current?.click();
    },
    pickFolder: (target) => {
      pickTarget.current = target;
      void chooseFolder(folderInput.current, (files) => drop(files, pickTarget.current));
    },
    drop,
    uploading,
    uploadProgress,
    uploadError,
  };

  return (
    <ActionsContext.Provider value={actions}>
      {children}

      <input
        ref={fileInput}
        className="hidden"
        type="file"
        multiple
        onChange={(event) => {
          drop(event.currentTarget.files, pickTarget.current);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={folderInput}
        className="hidden"
        type="file"
        multiple // @ts-expect-error browser-only directory picker extension
        webkitdirectory=""
        onChange={(event) => {
          drop(event.currentTarget.files, pickTarget.current);
          event.currentTarget.value = "";
        }}
      />

      <Dialog
        open={Boolean(pendingUpload)}
        onOpenChange={(open) => !open && setPendingUpload(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace {pendingUpload?.target.title}?</DialogTitle>
            <DialogDescription>
              This publishes a new version. Access and settings stay the same.
            </DialogDescription>
          </DialogHeader>
          {pendingUpload && (
            <FieldGroup>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FolderArchiveIcon data-icon="inline-start" />
                <span>{pendingUpload.fileCount} files</span>
                <span>·</span>
                <span>{pendingUpload.sizeLabel}</span>
              </div>
              {publishProgress > 0 && <Progress value={publishProgress} />}
            </FieldGroup>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingUpload(null)}>
              Cancel
            </Button>
            <Button onClick={() => void publishUpload()} disabled={publishProgress > 0}>
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(renamingSite)} onOpenChange={(open) => !open && setRenamingSite(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Rename {renamingSite?.kind === "artifact" ? "artifact" : "site"}
            </DialogTitle>
            <DialogDescription>
              {renamingSite?.kind === "artifact"
                ? "Change the name. The URL stays the same."
                : "Change the name and the URL. The old URL stops working."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="rename-title">Name</FieldLabel>
              <Input
                id="rename-title"
                value={renameTitle}
                onChange={(event) => setRenameTitle(event.target.value)}
              />
            </Field>
            {renamingSite?.kind !== "artifact" && (
              <Field>
                <FieldLabel htmlFor="rename-slug">URL</FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    id="rename-slug"
                    value={renameSlug}
                    onChange={(event) => setRenameSlug(slugify(event.target.value))}
                  />
                  <span className="shrink-0 text-sm text-muted-foreground">.{hostSuffix}</span>
                </div>
              </Field>
            )}
          </FieldGroup>
          {renameError && <p className="text-sm text-destructive">{renameError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenamingSite(null)}>
              Cancel
            </Button>
            <Button onClick={() => void renameSite()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(transferSite)} onOpenChange={(open) => !open && setTransferSite(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer {transferSite?.title}</DialogTitle>
            <DialogDescription>
              The new owner decides who can view it, and can rename or delete it. You keep access as
              an invited person.
            </DialogDescription>
          </DialogHeader>
          <OwnerPicker value={transferEmail} onChange={setTransferEmail} disabled={transferring} />
          {transferError && <p className="text-sm text-destructive">{transferError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferSite(null)}>
              Cancel
            </Button>
            <Button disabled={!transferEmail || transferring} onClick={() => void transferOwner()}>
              {transferring ? "Transferring…" : "Transfer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(sharingSite)} onOpenChange={(open) => !open && setSharingSite(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share {sharingSite?.title}</DialogTitle>
            <DialogDescription>
              {sharingSite && napLabel(sharingSite, hostSuffix)}
            </DialogDescription>
          </DialogHeader>
          <ShareAccess
            value={shareAccess}
            onChange={(next) => sharingSite && changeShareAccess(sharingSite, next)}
          />
          {shareError && <p className="text-sm text-destructive">{shareError}</p>}
          <DialogFooter>
            <Button onClick={() => setSharingSite(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <VersionHistoryDialog
        site={historySite}
        onClose={() => setHistorySite(null)}
        onRestored={() => void refresh(true)}
      />

      <Dialog open={Boolean(deletingSite)} onOpenChange={(open) => !open && setDeletingSite(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {deletingSite?.kind === "artifact" ? "artifact" : "site"}?
            </DialogTitle>
            <DialogDescription>
              {deletingSite
                ? `This removes ${napLabel(deletingSite, hostSuffix)} from Nap. Uploaded files may be cleaned up later.`
                : "This removes it from Nap."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingSite(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void deleteSite().catch(console.error)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ActionsContext.Provider>
  );
}

/**
 * Right-click on any item, in every layout. `render` replaces the wrapper element, so absolutely
 * positioned layouts keep their own element.
 */
export function ItemMenu({
  item,
  children,
  className,
  style,
}: {
  item: Item;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const actions = useActions();
  const site = item.site;
  const isOwner = item.mine;
  const canUpload = site && isOwner && !site.hasSource;
  return (
    <ContextMenu>
      <ContextMenuTrigger className={className} style={style}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <ContextMenuGroup>
          <ContextMenuLabel className="flex items-center gap-2 text-foreground">
            <KindIcon kind={item.kind} className="size-3.5" />
            <span className="truncate font-medium">{item.title}</span>
          </ContextMenuLabel>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => actions.open(item)}>
            <ArrowUpRightIcon data-icon="inline-start" />
            Open
          </ContextMenuItem>
          <ContextMenuItem onClick={() => actions.copyLink(item)}>
            <LinkIcon data-icon="inline-start" />
            Copy link
          </ContextMenuItem>
          {site && (
            <ContextMenuItem onClick={() => actions.history(site)}>
              <HistoryIcon data-icon="inline-start" />
              Version history…
            </ContextMenuItem>
          )}
        </ContextMenuGroup>
        {canUpload && (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem onClick={() => actions.pickFiles(site)}>
                <FileIcon data-icon="inline-start" />
                Upload file
              </ContextMenuItem>
              <ContextMenuItem onClick={() => actions.pickFolder(site)}>
                <FolderArchiveIcon data-icon="inline-start" />
                Upload folder
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        )}
        {site && isOwner && (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem onClick={() => actions.share(site)}>
                <UsersIcon data-icon="inline-start" />
                Share…
              </ContextMenuItem>
              <ContextMenuItem onClick={() => actions.transfer(site)}>
                <UserRoundPenIcon data-icon="inline-start" />
                Transfer ownership…
              </ContextMenuItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem onClick={() => actions.rename(site)}>
                <EditIcon data-icon="inline-start" />
                Rename
              </ContextMenuItem>
              {!site.hasSource && (
                <ContextMenuItem onClick={() => actions.toggleKind(site)}>
                  <ArrowRightLeftIcon data-icon="inline-start" />
                  {site.kind === "site" ? "Make it an artifact" : "Make it a site"}
                </ContextMenuItem>
              )}
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem variant="destructive" onClick={() => actions.remove(site)}>
                <Trash2Icon data-icon="inline-start" />
                Delete
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

type Version = {
  id: string;
  number: number;
  createdAt: string;
  uploadedByEmail: string;
  uploadedByName: string | null;
  fileCount: number;
  totalBytes: number;
  source: "dashboard" | "agent" | "claim" | "github" | "";
  client: string;
  message: string;
  sourceCommit: string | null;
  live: boolean;
};

function versionSource(version: Version) {
  if (version.source === "agent") return version.client || "Agent";
  if (version.source === "claim") return "Claim link";
  if (version.source === "dashboard") return "Dashboard";
  if (version.source === "github") return "GitHub";
  return "";
}

/** Who published it, and for builds from a source repo, the commit. */
function versionOrigin(version: Version) {
  const source = versionSource(version);
  const commit = version.sourceCommit?.slice(0, 7);
  return commit ? (source ? `${source} · ${commit}` : commit) : source;
}

/** Every upload is an immutable version. Restore makes an earlier one live again. */
function VersionHistoryDialog({
  site,
  onClose,
  onRestored,
}: {
  site: Site | null;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [versions, setVersions] = React.useState<Array<Version> | null>(null);
  const [error, setError] = React.useState("");
  const [restoring, setRestoring] = React.useState<string | null>(null);
  const slug = site?.slug;

  const load = React.useCallback(async (slug: string) => {
    const response = await fetch(`/api/sites/${slug}/versions`);
    const body = (await response.json().catch(() => ({}))) as {
      versions?: Array<Version>;
      error?: string;
    };
    if (!response.ok) throw new Error(body.error ?? "Could not load the history");
    setVersions(body.versions ?? []);
  }, []);

  React.useEffect(() => {
    setVersions(null);
    setError("");
    if (slug) load(slug).catch((caught: unknown) => setError(String(caught)));
  }, [slug, load]);

  async function restore(version: Version) {
    if (!site || !versions) return;
    setRestoring(version.id);
    setError("");
    try {
      const live = versions.find((item) => item.live);
      const response = await fetch(`/api/sites/${site.slug}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: version.id, expectedCurrentVersion: live?.id }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not restore");
      await load(site.slug);
      onRestored();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not restore");
    } finally {
      setRestoring(null);
    }
  }

  return (
    <Dialog open={Boolean(site)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            {site?.title} · newest first. Restore makes an earlier version live again. Access and
            settings stay the same.
            {site?.hasSource &&
              " The source repo is not changed, so ask an agent to revert the change there too."}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="-mx-4 max-h-[60vh] overflow-y-auto border-t">
          {versions === null ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : versions.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No versions.</p>
          ) : (
            <ul className="divide-y">
              {versions.map((version) => (
                <li key={version.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="tabular-nums">v{version.number}</span>
                      <span className="font-normal text-muted-foreground">
                        {formatDateTime(version.createdAt)}
                      </span>
                      {version.live && <Badge>Live</Badge>}
                    </div>
                    {version.message && (
                      <p className="text-sm whitespace-pre-wrap break-words">{version.message}</p>
                    )}
                    <p className="truncate text-xs text-muted-foreground">
                      {[
                        version.uploadedByName ?? version.uploadedByEmail,
                        versionOrigin(version),
                        `${version.fileCount} ${version.fileCount === 1 ? "file" : "files"}`,
                        formatBytes(version.totalBytes),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  {!version.live && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restoring !== null}
                      onClick={() => void restore(version)}
                    >
                      {restoring === version.id ? "Restoring…" : "Restore"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
