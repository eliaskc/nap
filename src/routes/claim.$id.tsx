import { DEFAULT_ACCESS } from "~/lib/deployment-text";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCwIcon, SparklesIcon } from "lucide-react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import { ShareAccess, type Access, type Visibility } from "~/components/share-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { ARTIFACT_PATH, browserPlace, napLabel, napUrl } from "~/lib/nap-urls";
import { cn } from "~/lib/utils";
import { napConfig } from "~/nap.config";

export const Route = createFileRoute("/claim/$id")({ component: ClaimPage });

type Kind = "site" | "artifact";

type Draft = {
  id: string;
  kind: Kind;
  title: string;
  slug: string;
  fileCount: number;
  totalBytes: number;
  expiresAt: string;
  expired: boolean;
  claimed: boolean;
  claimedByMe: boolean;
  siteSlug: string | null;
  supersededBy: string | null;
};

type SuggestedSite = {
  slug: string;
  kind: Kind;
  title: string;
  currentVersion: string;
  canUpdate: boolean;
  isOwner: boolean;
  visibility?: Visibility;
  viewerEmails?: Array<string>;
};

const DEFAULT: Access = { visibility: DEFAULT_ACCESS, emails: [] };

function accessOf(site: SuggestedSite | null): Access {
  if (!site?.visibility) return DEFAULT;
  return { visibility: site.visibility, emails: site.viewerEmails ?? [] };
}

type LoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; draft: Draft; suggestedSite: SuggestedSite | null };

function ClaimPage() {
  const { id } = Route.useParams();
  const [state, setState] = React.useState<LoadState>({ kind: "loading" });
  const [title, setTitle] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [replace, setReplace] = React.useState(false);
  const [access, setAccess] = React.useState<Access>(DEFAULT);
  const [publishing, setPublishing] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/drafts/${encodeURIComponent(id)}`);
      if (cancelled) return;
      if (!response.ok) {
        setState({ kind: "missing" });
        return;
      }
      const body = (await response.json()) as { draft: Draft; suggestedSite: SuggestedSite | null };
      // Reopening your own claim link goes straight to what it published.
      if (body.draft.claimedByMe && body.draft.siteSlug) {
        // The artifact page sends sites on to their own host.
        window.location.replace(`${ARTIFACT_PATH}/${body.draft.siteSlug}`);
        return;
      }
      setState({ kind: "ready", ...body });
      const updatable = body.suggestedSite?.canUpdate ? body.suggestedSite : null;
      setReplace(Boolean(updatable));
      setAccess(accessOf(updatable));
      setTitle(
        updatable && !updatable.isOwner
          ? updatable.title
          : body.draft.title || updatable?.title || "",
      );
      setSlug(body.suggestedSite && !updatable ? "" : body.draft.slug);
    })().catch(() => !cancelled && setState({ kind: "missing" }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const draft = state.kind === "ready" ? state.draft : null;
  const suggestedSite = state.kind === "ready" ? state.suggestedSite : null;
  // A site this person may update: their own, or one shared with them.
  const ownedSite = suggestedSite?.canUpdate ? suggestedSite : null;
  const updating = Boolean(replace && ownedSite);
  // Someone else's site keeps its name and access. Only its owner changes those.
  const othersSite = updating && ownedSite && !ownedSite.isOwner ? ownedSite : null;
  // An update keeps the kind of what it updates.
  const kind: Kind = updating && ownedSite ? ownedSite.kind : (draft?.kind ?? "artifact");
  const noun = kind === "artifact" ? "artifact" : "site";
  const takenByOther = suggestedSite && !suggestedSite.canUpdate ? suggestedSite.slug : null;
  // Without a URL, Nap makes one from the title. Artifacts always get a random id.
  const finalSlug = updating && ownedSite ? ownedSite.slug : slugify(slug);
  const titlePlaceholder =
    updating && ownedSite
      ? ownedSite.title
      : kind === "artifact"
        ? "Untitled artifact"
        : "Untitled site";

  async function publish() {
    if (!draft) return;
    setPublishing(true);
    setError("");
    try {
      const response = await fetch(`/api/drafts/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: othersSite ? undefined : title.trim(),
          slug: (kind === "site" || updating) && finalSlug ? finalSlug : undefined,
          replace: updating,
          expectedCurrentVersion: updating ? ownedSite?.currentVersion : undefined,
          ...(!othersSite && {
            visibility: access.visibility,
            emails: access.visibility === "selected" ? access.emails : [],
          }),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        site?: { slug: string; kind: Kind; replaced: boolean; visibility?: Visibility };
      };
      if (!response.ok || !body.site) throw new Error(body.error ?? "Could not publish");
      // Go to the published artifact or site. Keep the button disabled while the page changes.
      window.location.replace(napUrl(body.site, browserPlace()));
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Could not publish");
      setPublishing(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col bg-background text-foreground lg:h-dvh lg:flex-row lg:overflow-hidden">
      <section className="flex h-[70dvh] min-w-0 flex-1 flex-col lg:h-auto">
        <div className="flex items-center justify-between gap-3 border-b bg-card px-4 py-2 text-xs text-muted-foreground">
          <span className="truncate">Preview</span>
          {draft && (
            <span className="tabular-nums">
              {draft.fileCount} {draft.fileCount === 1 ? "file" : "files"} ·{" "}
              {formatBytes(draft.totalBytes)}
            </span>
          )}
        </div>
        {state.kind === "loading" ? (
          <Skeleton className="flex-1 rounded-none" />
        ) : draft && !draft.claimed && !draft.expired ? (
          <iframe
            title="Draft preview"
            src={`/api/drafts/${encodeURIComponent(id)}/preview/`}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            className="size-full flex-1 bg-white"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            No preview.
          </div>
        )}
      </section>

      <aside className="w-full shrink-0 border-t bg-card lg:w-96 lg:overflow-y-auto lg:border-t-0 lg:border-l">
        <Card className="rounded-none bg-transparent ring-0">
          {state.kind === "loading" && (
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </CardContent>
          )}

          {state.kind === "missing" && (
            <Message
              title="Draft not found"
              description="The link is wrong, or the draft was removed. Ask your agent to upload again."
            />
          )}

          {draft && draft.claimed && (
            <Message
              title="Already published"
              description="Someone already published this draft. Ask your agent to upload again for a new link."
            />
          )}

          {draft && !draft.claimed && draft.expired && (
            <Message
              title="Draft expired"
              description="Drafts are kept for 24 hours. Ask your agent to upload again."
            />
          )}

          {draft && !draft.claimed && !draft.expired && (
            <>
              <CardHeader>
                <CardTitle>{updating ? `Update ${noun}` : `Publish ${noun}`}</CardTitle>
                <CardDescription>
                  Your agent uploaded this draft. Check the preview, then publish it.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                {draft.supersededBy && (
                  <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
                    Your agent uploaded a newer version.{" "}
                    <a
                      className="font-medium text-foreground underline"
                      href={`/claim/${draft.supersededBy}`}
                    >
                      Open the newer draft
                    </a>
                  </p>
                )}

                {ownedSite && (
                  <div className="grid grid-cols-2 gap-1 rounded-lg border p-1" role="radiogroup">
                    <ModeButton
                      selected={replace}
                      onClick={() => {
                        setReplace(true);
                        setAccess(accessOf(ownedSite));
                      }}
                    >
                      <RefreshCwIcon data-icon="inline-start" />
                      Update
                    </ModeButton>
                    <ModeButton
                      selected={!replace}
                      onClick={() => {
                        setReplace(false);
                        setAccess(DEFAULT);
                      }}
                    >
                      <SparklesIcon data-icon="inline-start" />
                      {draft.kind === "artifact" ? "New artifact" : "New site"}
                    </ModeButton>
                  </div>
                )}

                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="claim-title">Name</FieldLabel>
                    <Input
                      id="claim-title"
                      value={title}
                      placeholder={titlePlaceholder}
                      disabled={Boolean(othersSite)}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </Field>
                  {updating && ownedSite ? (
                    <Field>
                      <FieldLabel>Updates</FieldLabel>
                      <p className="truncate text-sm text-muted-foreground">
                        {napLabel(ownedSite, hostSuffix())}
                      </p>
                      <FieldDescription>
                        {othersSite
                          ? "This publishes a new version. Its owner keeps the name and who can view it."
                          : "This publishes a new version."}
                      </FieldDescription>
                    </Field>
                  ) : kind === "site" ? (
                    <Field data-invalid={Boolean(error) || undefined}>
                      <FieldLabel htmlFor="claim-slug">URL</FieldLabel>
                      <div className="flex items-center gap-2">
                        <Input
                          id="claim-slug"
                          value={slug}
                          placeholder="random"
                          onChange={(event) => setSlug(slugify(event.target.value))}
                        />
                        <span className="shrink-0 text-sm text-muted-foreground">
                          .{hostSuffix()}
                        </span>
                      </div>
                      <FieldDescription>
                        {takenByOther
                          ? `${takenByOther} is taken. Choose a different URL, or leave it empty.`
                          : "Optional. Leave it empty for a random URL. You can rename it later."}
                      </FieldDescription>
                    </Field>
                  ) : null}
                  {!othersSite && (
                    <Field>
                      <FieldLabel>Who can view</FieldLabel>
                      <ShareAccess value={access} onChange={setAccess} />
                    </Field>
                  )}
                </FieldGroup>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <Button size="lg" disabled={publishing} onClick={() => void publish()}>
                  {publishing ? "Publishing…" : updating ? "Publish update" : "Publish"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Link expires {formatRelative(draft.expiresAt)}.
                </p>
              </CardContent>
            </>
          )}
        </Card>
      </aside>
    </main>
  );
}

function ModeButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      role="radio"
      aria-checked={selected}
      variant={selected ? "secondary" : "ghost"}
      className={cn(!selected && "text-muted-foreground")}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function Message({ title, description }: { title: string; description: string }) {
  return (
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
  );
}

function isLocal() {
  return ["localhost", "127.0.0.1"].includes(window.location.hostname);
}

function hostSuffix() {
  if (typeof window === "undefined" || isLocal()) return napConfig.rootDomain;
  return window.location.hostname;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 32);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatRelative(iso: string) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes < 60) return `in ${Math.max(minutes, 1)} min`;
  return `in ${Math.round(minutes / 60)} h`;
}
