import { createFileRoute } from "@tanstack/react-router";
import { agentInstructionsFor } from "~/lib/agent-instructions";
import { EVERYONE_LABEL } from "~/lib/deployment-text";
import { napConfig } from "~/nap.config";
import confetti from "canvas-confetti";
import {
  ArrowRightLeftIcon,
  BotIcon,
  SmartphoneIcon,
  ChevronDownIcon,
  EditIcon,
  FileIcon,
  FolderArchiveIcon,
  GitBranchIcon,
  Globe2Icon,
  HistoryIcon,
  LockIcon,
  Trash2Icon,
  UserRoundPenIcon,
  UsersIcon,
} from "lucide-react";
import { ClaudeIcon, CodexIcon, CursorIcon } from "~/components/brand-icons";
import { OwnerPicker, ShareAccess, type Access } from "~/components/share-access";
import * as React from "react";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
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
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { browserPlace, napLabel, napUrl } from "~/lib/nap-urls";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

type Kind = "site" | "artifact";

type Site = {
  slug: string;
  kind: Kind;
  /** The source is in a Nap source repo. New versions come from agents, not uploads. */
  hasSource: boolean;
  title: string;
  createdByEmail: string;
  updatedByEmail: string;
  currentVersion: string;
  updatedAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  authorDisplayName: string | null;
  authorUsername: string | null;
  visibility: "everyone" | "private" | "selected";
  viewerEmails: Array<string>;
  listed: boolean;
  toolbar: boolean;
  invited: boolean;
};

const agentInstructions = agentInstructionsFor() ?? "";

type Settings = { kind?: Kind };

/**
 * Shared: other people's sites you can view, shared with everyone or with you. Mine: your sites.
 * Artifacts: only your own. Other people's artifacts are shared by link, not listed.
 */
type View = "shared" | "mine" | "artifacts";

const VIEWS: Array<{ value: View; label: string; empty: string }> = [
  {
    value: "shared",
    label: "Shared with me",
    empty: "Nobody has shared a site with you yet.",
  },
  {
    value: "mine",
    label: "Mine",
    empty: "No sites yet. Drop files above, or copy the prompt for your agent.",
  },
  {
    value: "artifacts",
    label: "Artifacts",
    empty: "No artifacts yet. Ask your agent to make one, or drop a file above.",
  },
];

const VIEW_STORAGE_KEY = "nap:view";

type Profile = {
  email: string;
  displayName: string | null;
  username: string | null;
  avatarColor: string | null;
};

type UploadFile = { file: File; path: string };

/** A new version for an existing site or artifact. It waits for the user to confirm. */
type PendingUpload = {
  target: Site;
  files: Array<UploadFile>;
  fileCount: number;
  sizeLabel: string;
};

function Home() {
  const [sites, setSites] = React.useState<Array<Site>>([]);
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [pendingUpload, setPendingUpload] = React.useState<PendingUpload | null>(null);
  const [renamingSite, setRenamingSite] = React.useState<Site | null>(null);
  const [transferSite, setTransferSite] = React.useState<Site | null>(null);
  const [transferEmail, setTransferEmail] = React.useState("");
  const [transferError, setTransferError] = React.useState("");
  const [transferring, setTransferring] = React.useState(false);
  const [renameTitle, setRenameTitle] = React.useState("");
  const [renameSlug, setRenameSlug] = React.useState("");
  const [deletingSite, setDeletingSite] = React.useState<Site | null>(null);
  const [sharingSite, setSharingSite] = React.useState<Site | null>(null);
  const [historySite, setHistorySite] = React.useState<Site | null>(null);
  const [agentsOpen, setAgentsOpen] = React.useState(false);
  const [shareAccess, setShareAccess] = React.useState<Access>({
    visibility: "private",
    emails: [],
  });
  const shareQueue = React.useRef<Promise<unknown>>(Promise.resolve());
  const [shareError, setShareError] = React.useState("");
  const [publishProgress, setPublishProgress] = React.useState(0);
  const [uploading, setUploading] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState(0);
  const [uploadError, setUploadError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [dragActive, setDragActive] = React.useState(false);
  const [dragTargetSlug, setDragTargetSlug] = React.useState<string | null>(null);
  const [instructionsOpen, setInstructionsOpen] = React.useState(false);
  const [instructionsCopied, setInstructionsCopied] = React.useState(false);
  const [view, setView] = React.useState<View>("shared");
  const dragDepth = React.useRef(0);
  const hostSuffix = napConfig.rootDomain;
  const myEmail = profile?.email.toLowerCase() ?? null;
  const isMine = React.useCallback(
    (site: Site) => myEmail !== null && site.createdByEmail.toLowerCase() === myEmail,
    [myEmail],
  );
  const visibleSites = React.useMemo(() => {
    const byRecent = (a: Site, b: Site) => b.updatedAt.localeCompare(a.updatedAt);
    const ofKind = (kind: Kind) => sites.filter((site) => site.kind === kind);
    if (view === "artifacts") return ofKind("artifact").filter(isMine).sort(byRecent);
    if (view === "mine") return ofKind("site").filter(isMine).sort(byRecent);
    return ofKind("site")
      .filter((site) => !isMine(site))
      .sort(byRecent);
  }, [sites, view, isMine]);

  React.useEffect(() => {
    const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (VIEWS.some((item) => item.value === saved)) setView(saved as View);
  }, []);

  function changeView(next: View) {
    setView(next);
    window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  }

  const refresh = React.useCallback(async (quiet = false) => {
    try {
      const [meRes, sitesRes] = await Promise.all([fetch("/api/me"), fetch("/api/sites")]);
      if (!meRes.ok || !sitesRes.ok) throw new Error("Failed to load data");
      const meJson = (await meRes.json()) as { profile: Profile };
      const sitesJson = (await sitesRes.json()) as { sites: Array<Site> };
      setProfile(meJson.profile);
      setSites(sitesJson.sites);
    } catch (error) {
      if (!quiet) console.error(error);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(true), 4_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  /**
   * A drop on the upload card publishes a new private site (or artifact, on the Artifacts tab)
   * at once, with a URL made from the title (artifacts: a random id). A drop on an existing row asks
   * first, because it replaces the live version.
   */
  function describeDrop(files: FileList | null, target?: Site) {
    if (!files?.length) return;
    const normalized = normalizeUploadFiles(Array.from(files));
    const totalBytes = normalized.reduce((sum, item) => sum + item.file.size, 0);
    const hasRootHtml = normalized.some((item) => item.path === "index.html");

    if (!hasRootHtml) {
      setUploadError("Add an index.html file at the root, or drop a single HTML file.");
      return;
    }
    setUploadError("");

    if (!target) {
      void uploadNew(normalized);
      return;
    }
    setPendingUpload({
      target,
      files: normalized,
      fileCount: normalized.length,
      sizeLabel: formatBytes(totalBytes),
    });
  }

  function startRename(site: Site) {
    setRenamingSite(site);
    setRenameTitle(site.title);
    setRenameSlug(site.slug);
  }

  async function copyAgentInstructions() {
    await navigator.clipboard.writeText(agentInstructions);
    setInstructionsCopied(true);
    window.setTimeout(() => setInstructionsCopied(false), 1_600);
  }

  async function renameSite() {
    if (!renamingSite) return;
    const finalSlug = slugify(renameSlug);
    const response = await fetch(`/api/sites/${renamingSite.slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: renameTitle, slug: finalSlug }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Rename failed");
    }
    setRenamingSite(null);
    await refresh(true);
  }

  function startTransfer(site: Site) {
    setTransferSite(site);
    setTransferEmail("");
    setTransferError("");
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

  function openShare(site: Site) {
    setSharingSite(site);
    setShareAccess({ visibility: site.visibility, emails: site.viewerEmails });
    setShareError("");
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
          // Keep the invited people when the site is open to everyone, so switching back restores them.
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

  async function changeSettings(site: Site, settings: Settings) {
    setSites((current) =>
      current.map((item) => (item.slug === site.slug ? { ...item, ...settings } : item)),
    );
    try {
      const response = await fetch(`/api/sites/${site.slug}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not save the setting");
      }
    } finally {
      await refresh(true);
    }
  }

  /** New uploads become artifacts on the Artifacts tab, and sites everywhere else. */
  const uploadKind: Kind = view === "artifacts" ? "artifact" : "site";

  async function upload(
    files: Array<UploadFile>,
    target?: Site,
    onProgress: (fraction: number) => void = () => {},
  ) {
    const fields: Record<string, string> = target
      ? { targetSlug: target.slug, expectedCurrentVersion: target.currentVersion }
      : { kind: uploadKind };
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
      changeView(uploadKind === "artifact" ? "artifacts" : "mine");
      await refresh(true);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
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

  return (
    <main
      className="nap-shell relative min-h-dvh overflow-hidden bg-background text-foreground"
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        setDragTargetSlug(null);
        describeDrop(event.dataTransfer.files);
      }}
    >
      <div className="nap-dot-field" />
      {dragActive && (
        <div className="pointer-events-none fixed inset-0 z-10 bg-background/45 backdrop-blur-sm" />
      )}

      <AgentInstructionsButton
        open={instructionsOpen}
        copied={instructionsCopied}
        onOpenChange={setInstructionsOpen}
        onCopy={() => void copyAgentInstructions().catch(console.error)}
      />

      {profile && (
        <div className="fixed right-5 top-5 z-30 flex items-center gap-3">
          <div className="grid justify-items-end text-right leading-tight">
            <span className="block max-w-56 truncate text-sm font-medium">
              {profile.displayName ?? profile.email}
            </span>
            <span className="block max-w-56 truncate text-xs text-muted-foreground">
              {profile.email}
            </span>
          </div>
          {napConfig.apps && (
            <a
              href="/apps"
              className={buttonVariants({
                variant: "outline",
                size: "icon",
                className: "rounded-full",
              })}
              aria-label="Apps"
              title="Apps"
            >
              <SmartphoneIcon />
            </a>
          )}
          <Button
            variant="outline"
            size="icon"
            className="rounded-full"
            aria-label="Connected agents"
            title="Connected agents"
            onClick={() => setAgentsOpen(true)}
          >
            <BotIcon />
          </Button>
        </div>
      )}

      <div className="relative z-20 mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-5 px-5 pb-8 pt-20 sm:pb-14 sm:pt-16 lg:pt-14">
        <UploadCard
          active={dragActive && !dragTargetSlug}
          kind={uploadKind}
          uploading={uploading}
          progress={uploadProgress}
          error={uploadError}
          onFiles={(files) => describeDrop(files)}
        />

        <Tabs value={view} onValueChange={(next) => changeView(next as View)}>
          <TabsList>
            {VIEWS.map((item) => (
              <TabsTrigger key={item.value} value={item.value} className="px-3">
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <Card className="-mt-2 overflow-hidden border-border/70 bg-card/75 py-0 shadow-sm backdrop-blur transition">
          <CardContent className="p-0">
            {loading ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-14 rounded-xl" />
                ))}
              </div>
            ) : visibleSites.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                {VIEWS.find((item) => item.value === view)?.empty}
              </p>
            ) : (
              <ul className="divide-y">
                {visibleSites.map((site) => (
                  <SiteRow
                    key={site.slug}
                    site={site}
                    isOwner={isMine(site)}
                    showOwner={view === "shared"}
                    hostSuffix={hostSuffix}
                    active={dragTargetSlug === site.slug}
                    onDragTargetChange={setDragTargetSlug}
                    onFiles={(files) => {
                      dragDepth.current = 0;
                      setDragActive(false);
                      setDragTargetSlug(null);
                      describeDrop(files, site);
                    }}
                    onRename={() => startRename(site)}
                    onTransfer={() => startTransfer(site)}
                    onDelete={() => setDeletingSite(site)}
                    onShare={() => openShare(site)}
                    onHistory={() => setHistorySite(site)}
                    onSettings={(settings) =>
                      void changeSettings(site, settings).catch(console.error)
                    }
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

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
            <Button onClick={publishUpload} disabled={publishProgress > 0}>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenamingSite(null)}>
              Cancel
            </Button>
            <Button onClick={() => void renameSite().catch(console.error)}>Save</Button>
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

      <ConnectedAgentsDialog open={agentsOpen} onOpenChange={setAgentsOpen} />

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
    </main>
  );
}

function AgentInstructionsButton({
  open,
  copied,
  onOpenChange,
  onCopy,
}: {
  open: boolean;
  copied: boolean;
  onOpenChange: (open: boolean) => void;
  onCopy: () => void;
}) {
  return (
    <div className="fixed left-5 top-5 z-40 flex max-w-[calc(100vw-2.5rem)] flex-col items-start">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          disabled={copied}
          className="rounded-full pl-3 disabled:opacity-100"
          onClick={onCopy}
        >
          <span
            className={cn("flex items-center gap-1.5 transition-opacity", copied && "opacity-50")}
            aria-hidden="true"
          >
            <ClaudeIcon className="size-4 text-[#D97757]" />
            <CodexIcon className="size-4 text-foreground" />
            <CursorIcon className="size-4 text-foreground" />
          </span>
          <span className="hidden sm:inline">{copied ? "Prompt copied" : "Copy prompt"}</span>
          <span className="sm:hidden">{copied ? "Copied" : "Copy"}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={open ? "Hide agent instructions" : "Show agent instructions"}
          aria-expanded={open}
          className="rounded-full"
          onClick={() => onOpenChange(!open)}
        >
          <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
        </Button>
      </div>

      {open && (
        <Card className="mt-2 max-h-[min(70vh,34rem)] w-[min(34rem,calc(100vw-2.5rem))] overflow-hidden border-border/70 bg-card/95 py-0 shadow-lg backdrop-blur">
          <CardHeader className="gap-1 px-4 py-3">
            <CardTitle className="text-base">Hand this to your agent</CardTitle>
            <CardDescription>
              Paste this into Claude (or any agent) and it&rsquo;ll know exactly what to build and
              upload for Nap.
            </CardDescription>
          </CardHeader>
          <CardContent className="border-t p-0">
            <pre className="max-h-[26rem] overflow-auto whitespace-pre-wrap p-4 text-left text-xs leading-relaxed text-muted-foreground">
              {agentInstructions}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function UploadCard({
  active,
  kind,
  uploading,
  progress,
  error,
  onFiles,
}: {
  active: boolean;
  kind: Kind;
  uploading: boolean;
  progress: number;
  error: string;
  onFiles: (files: FileList | null) => void;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const folderInputRef = React.useRef<HTMLInputElement>(null);

  return (
    <Card
      className={cn(
        "nap-upload relative z-20 border-dashed text-center backdrop-blur",
        active && "nap-upload-active border-primary",
      )}
    >
      <CardHeader className="items-center gap-5 py-16">
        <div>
          <CardTitle className="text-2xl">
            {kind === "artifact" ? "Drop an artifact here" : "Drop a site here"}
          </CardTitle>
          <CardDescription className="mt-1 text-base">
            {uploading
              ? progress > 0 && progress < 100
                ? `Uploading… ${progress}%`
                : "Uploading…"
              : "Drag in a file or folder. Only you can see it until you share it."}
          </CardDescription>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="secondary"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <FileIcon data-icon="inline-start" />
            Choose file
          </Button>
          <Button
            variant="outline"
            disabled={uploading}
            onClick={() => void chooseFolder(folderInputRef.current, onFiles)}
          >
            <FolderArchiveIcon data-icon="inline-start" />
            Choose folder
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardHeader>
      <CardContent className="hidden">
        <input
          ref={fileInputRef}
          className="hidden"
          type="file"
          multiple
          onChange={(event) => {
            onFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          className="hidden"
          type="file"
          multiple // @ts-expect-error browser-only directory picker extension
          webkitdirectory=""
          onChange={(event) => {
            onFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </CardContent>
    </Card>
  );
}

function SiteRow({
  site,
  isOwner,
  showOwner,
  hostSuffix,
  active,
  onDragTargetChange,
  onFiles,
  onRename,
  onTransfer,
  onDelete,
  onShare,
  onHistory,
  onSettings,
}: {
  site: Site;
  isOwner: boolean;
  showOwner: boolean;
  hostSuffix: string;
  active: boolean;
  onDragTargetChange: (slug: string | null) => void;
  onFiles: (files: FileList | null) => void;
  onRename: () => void;
  onTransfer: () => void;
  onDelete: () => void;
  onShare: () => void;
  onHistory: () => void;
  onSettings: (settings: Settings) => void;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const folderInputRef = React.useRef<HTMLInputElement>(null);
  const openSite = () => {
    window.open(napUrl(site, browserPlace(hostSuffix)), "_blank", "noopener,noreferrer");
  };
  const author = site.authorDisplayName ?? site.updatedByEmail;
  const managed = site.hasSource;

  return (
    <li>
      <input
        ref={fileInputRef}
        className="hidden"
        type="file"
        multiple
        onChange={(event) => {
          onFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        className="hidden"
        type="file"
        multiple // @ts-expect-error browser-only directory picker extension
        webkitdirectory=""
        onChange={(event) => {
          onFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <ContextMenu>
        <ContextMenuTrigger>
          <div
            className={cn(
              "relative flex w-full items-center justify-between gap-4 px-4 py-2 text-left transition-colors hover:bg-muted/35",
              active && "bg-primary/10 ring-2 ring-inset ring-primary/40",
            )}
            onDragEnter={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!managed) onDragTargetChange(site.slug);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!managed) onDragTargetChange(site.slug);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDragTargetChange(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDragTargetChange(null);
              if (!managed) onFiles(event.dataTransfer.files);
            }}
          >
            <button
              type="button"
              aria-label={`Open ${site.title}`}
              onClick={openSite}
              className="absolute inset-0 cursor-pointer focus-visible:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
            <div className="pointer-events-none relative min-w-0">
              <div className="truncate text-base font-semibold tracking-tight">{site.title}</div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <AccessIcon site={site} />
                <span className="truncate">
                  {napLabel(site, hostSuffix)}
                  {showOwner && ` · ${author}`}
                </span>
                {managed && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span
                      title="Source in Nap. Ask an agent to change it."
                      className="pointer-events-auto inline-flex shrink-0 items-center"
                    >
                      <GitBranchIcon className="size-3.5" aria-hidden="true" />
                      <span className="sr-only">Source in Nap. Ask an agent to change it.</span>
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="pointer-events-none relative w-20 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
              {formatCount(site.viewCount)} views
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            {!managed && (
              <>
                <ContextMenuItem onClick={() => fileInputRef.current?.click()}>
                  <FileIcon data-icon="inline-start" />
                  Upload file
                </ContextMenuItem>
                <ContextMenuItem onClick={() => void chooseFolder(folderInputRef.current, onFiles)}>
                  <FolderArchiveIcon data-icon="inline-start" />
                  Upload folder
                </ContextMenuItem>
              </>
            )}
            <ContextMenuItem onClick={onHistory}>
              <HistoryIcon data-icon="inline-start" />
              Version history…
            </ContextMenuItem>
            {isOwner && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={onShare}>
                  <UsersIcon data-icon="inline-start" />
                  Share…
                </ContextMenuItem>
                <ContextMenuItem onClick={onTransfer}>
                  <UserRoundPenIcon data-icon="inline-start" />
                  Transfer ownership…
                </ContextMenuItem>
              </>
            )}
            {isOwner && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={onRename}>
                  <EditIcon data-icon="inline-start" />
                  Rename
                </ContextMenuItem>
                {!managed && (
                  <ContextMenuItem
                    onClick={() => onSettings({ kind: site.kind === "site" ? "artifact" : "site" })}
                  >
                    <ArrowRightLeftIcon data-icon="inline-start" />
                    {site.kind === "site" ? "Move to Artifacts" : "Move to Sites"}
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2Icon data-icon="inline-start" />
                  Delete
                </ContextMenuItem>
              </>
            )}
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    </li>
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

type AgentToken = {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
};

/** Agents that signed in through /connect. Each one has a token that acts as you. */
function ConnectedAgentsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tokens, setTokens] = React.useState<Array<AgentToken> | null>(null);
  const [activeDays, setActiveDays] = React.useState(30);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    const response = await fetch("/api/tokens");
    const body = (await response.json().catch(() => ({}))) as {
      tokens?: Array<AgentToken>;
      activeDays?: number;
      error?: string;
    };
    if (!response.ok) throw new Error(body.error ?? "Could not load agents");
    setTokens(body.tokens ?? []);
    if (body.activeDays) setActiveDays(body.activeDays);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setError("");
    load().catch((caught: unknown) => setError(String(caught)));
  }, [open, load]);

  async function revoke(token: AgentToken) {
    setError("");
    const response = await fetch(`/api/tokens/${encodeURIComponent(token.id)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not disconnect");
    }
    await load().catch(() => undefined);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connected agents</DialogTitle>
          <DialogDescription>
            These agents can publish private sites and artifacts as you, and update the ones you
            own. They stop working if you do not open Nap for {activeDays} days, and work again when
            you come back.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="-mx-4 max-h-[50vh] overflow-y-auto border-t">
          {tokens === null ? (
            <div className="p-4">
              <Skeleton className="h-12" />
            </div>
          ) : tokens.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No agents yet. Copy the prompt for your agent. It signs in the first time it
              publishes.
            </p>
          ) : (
            <ul className="divide-y">
              {tokens.map((token) => (
                <li key={token.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{token.clientName}</p>
                    <p className="text-xs text-muted-foreground">
                      Connected {formatDateTime(token.createdAt)}
                      {token.lastUsedAt && ` · last used ${formatDateTime(token.lastUsedAt)}`}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void revoke(token)}>
                    Disconnect
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function AccessIcon({ site }: { site: Site }) {
  const [Icon, label] =
    site.visibility === "everyone"
      ? [Globe2Icon, EVERYONE_LABEL]
      : site.visibility === "selected"
        ? [UsersIcon, "Only people invited"]
        : [LockIcon, "Only you"];
  return (
    <span title={label} className="inline-flex shrink-0">
      <Icon className="size-3" aria-label={label} />
    </span>
  );
}

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

async function chooseFolder(
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
async function directUpload(
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

function normalizeUploadFiles(files: Array<File>) {
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

function celebrate() {
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

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCount(value: number) {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 32);
}
