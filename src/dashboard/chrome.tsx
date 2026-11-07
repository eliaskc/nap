import {
  ArrowDownUpIcon,
  BotIcon,
  FileIcon,
  FolderArchiveIcon,
  LayoutGridIcon,
  ListIcon,
  UploadIcon,
} from "lucide-react";
import * as React from "react";
import { Avatar } from "~/components/avatar";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Skeleton } from "~/components/ui/skeleton";
import { useActions } from "~/dashboard/actions";
import { Group, GroupButton, GroupTab, GroupTabs } from "~/dashboard/controls";
import {
  FILTERS,
  KIND_LABEL,
  KINDS,
  SORTS,
  type ItemView,
  type Profile,
  type Sort,
} from "~/dashboard/data";
import { formatDateTime } from "~/dashboard/format";
import { GetAppButton } from "~/dashboard/install";
import { KindIcon } from "~/dashboard/kinds";
import {
  PANEL_CLASS,
  PanelHeading,
  VariantSwitch,
  VARIANTS,
  type Mode,
  type Variant,
} from "~/dashboard/variant-switch";
import { iconUrl } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { napConfig } from "~/nap.config";

/**
 * Nap's mark, on its own in the top-left with no surface behind it: the instance's icon (Nap's
 * own unless instance/icon replaces it) and its name as a wordmark. On a phone just a larger icon,
 * which leaves the bar room for the rest.
 */
export function NapMark({ className }: { className?: string }) {
  const icon =
    "size-10 shrink-0 rounded-[22.5%] shadow-sm ring-1 ring-foreground/5 sm:size-8 dark:ring-foreground/10";
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <img src={iconUrl("app-icon.png")} alt="" className={cn(icon, "dark:hidden")} />
      <img src={iconUrl("app-icon-dark.png")} alt="" className={cn(icon, "hidden dark:block")} />
      <span className="text-[1.3rem] leading-none font-bold tracking-[-0.045em] whitespace-nowrap text-foreground max-sm:sr-only">
        {napConfig.orgName}
      </span>
    </span>
  );
}

/**
 * The bar every layout shares: Nap and anything a layout adds on the left, the mode switch in the
 * middle, upload, agents, and you on the right. It has no background: each group floats on its own
 * over whatever is under it.
 */
export function TopBar({
  profile,
  variant,
  onModeChange,
  onVariantChange,
  left,
  leftClassName,
  className,
}: {
  profile: Profile | null;
  variant: Variant;
  onModeChange: (mode: Mode) => void;
  onVariantChange: (variant: Variant) => void;
  left?: React.ReactNode;
  leftClassName?: string;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "pointer-events-none z-40 grid h-15 grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 sm:px-5",
        className,
      )}
    >
      <div className="flex min-w-0">
        <div data-flat className={cn("pointer-events-auto flex items-center gap-1", leftClassName)}>
          {left ?? <NapMark />}
        </div>
      </div>
      <div className="pointer-events-auto">
        <VariantSwitch
          variant={variant}
          onModeChange={onModeChange}
          onVariantChange={onVariantChange}
        />
      </div>
      <div className="flex justify-end">
        {/* Flat in Tidy, where the page is plain; a surface in Playful, over the layout. */}
        <Group floating flat={VARIANTS[variant].mode === "tidy"}>
          <UploadButton />
          <GetAppButton />
          <ConnectedAgents />
          {profile && (
            <GroupButton
              icon
              nativeButton={false}
              render={<a href="/welcome?next=/" />}
              title={`${profile.displayName ?? profile.email} · change your name and look`}
            >
              {profile.shape && profile.color ? (
                <Avatar
                  look={{ shape: profile.shape, color: profile.color }}
                  name={profile.displayName ?? profile.email}
                  size={24}
                />
              ) : (
                <span className="grid size-6 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
                  {(profile.displayName ?? profile.email).charAt(0).toUpperCase()}
                </span>
              )}
            </GroupButton>
          )}
        </Group>
      </div>
    </header>
  );
}

/** Upload is small now: a file or a folder, published as a private artifact. */
function UploadButton() {
  const actions = useActions();
  const label = actions.uploading
    ? actions.uploadProgress > 0 && actions.uploadProgress < 100
      ? `Uploading ${actions.uploadProgress}%`
      : "Uploading…"
    : "Upload";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<GroupButton disabled={actions.uploading} />}>
        <UploadIcon data-icon="inline-start" />
        <span className="max-sm:sr-only">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="leading-snug font-normal">
            Publish a private artifact. Only you see it until you share it. You can also drop files
            anywhere on the page.
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => actions.pickFiles()}>
            <FileIcon />
            Choose file
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => actions.pickFolder()}>
            <FolderArchiveIcon />
            Choose folder
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** All / Mine / Shared with me, the sort menu (which also picks kinds), and list or cards. */
export function FilterBar({
  view,
  compact,
  showLook,
  floating,
  className,
}: {
  view: ItemView;
  /** Icons only, for the playful layouts. */
  compact?: boolean;
  showLook?: boolean;
  /** Over the page, with nothing behind it. */
  floating?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <GroupTabs value={view.filter} onValueChange={view.setFilter} floating={floating}>
        {FILTERS.map((filter) => (
          <GroupTab key={filter.value} value={filter.value}>
            {filter.label}
            {/* Every tab shows its count, so switching tabs doesn't change their widths. */}
            {!compact && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {view.counts[filter.value]}
              </span>
            )}
          </GroupTab>
        ))}
      </GroupTabs>
      {!compact && <span className="flex-1" />}
      {/* Over the page (playful) everything is a surface; on a plain page these stay flat. */}
      <Group floating={floating} flat={!floating}>
        <SortMenu view={view} compact={compact} />
      </Group>
      {showLook && (
        <GroupTabs
          value={view.look}
          onValueChange={view.setLook}
          label="Show as"
          floating={floating}
          flat={!floating}
        >
          <GroupTab icon value="list" aria-label="List" title="List">
            <ListIcon />
          </GroupTab>
          <GroupTab icon value="cards" aria-label="Cards" title="Cards">
            <LayoutGridIcon />
          </GroupTab>
        </GroupTabs>
      )}
    </div>
  );
}

function SortMenu({ view, compact }: { view: ItemView; compact?: boolean }) {
  const current = SORTS.find((sort) => sort.value === view.sort);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <GroupButton
            icon={compact}
            aria-label={`Sort: ${current?.label}`}
            title="Sort and show"
          />
        }
      >
        <ArrowDownUpIcon />
        {!compact && (current?.value === "popular" ? "Popular" : current?.label)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Sort by</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={view.sort}
            onValueChange={(value) => view.setSort(value as Sort)}
          >
            {SORTS.map((sort) => (
              <DropdownMenuRadioItem key={sort.value} value={sort.value}>
                {sort.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show</DropdownMenuLabel>
          {KINDS.map((kind) => (
            <DropdownMenuCheckboxItem
              key={kind}
              checked={view.kinds.includes(kind)}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                const next = checked
                  ? KINDS.filter((each) => each === kind || view.kinds.includes(each))
                  : view.kinds.filter((each) => each !== kind);
                if (next.length) view.setKinds(next);
              }}
            >
              <KindIcon kind={kind} />
              {KIND_LABEL[kind].many}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function EmptyState({ view, className }: { view: ItemView; className?: string }) {
  return (
    <p className={cn("px-4 py-10 text-center text-sm text-muted-foreground", className)}>
      {FILTERS.find((filter) => filter.value === view.filter)?.empty}
    </p>
  );
}

export function LoadingRows({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2 p-3">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-14 rounded-xl" />
      ))}
    </div>
  );
}

export function UploadError() {
  const actions = useActions();
  if (!actions.uploadError) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {actions.uploadError}
    </p>
  );
}

type AgentToken = {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
};

/** Agents that signed in through /connect. Each one has a token that acts as you. */
function ConnectedAgents() {
  const [open, setOpen] = React.useState(false);
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<GroupButton icon aria-label="Connected agents" title="Connected agents" />}
      >
        <BotIcon />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className={cn(PANEL_CLASS, "w-96 gap-2 p-2 ring-0")}
      >
        <div className="flex flex-col gap-1 px-2 pt-2">
          <PanelHeading className="px-0">Connected agents</PanelHeading>
          <p className="text-xs leading-relaxed text-muted-foreground">
            They publish and update as you. They pause after {activeDays} days without you opening
            Nap, and work again when you come back.
          </p>
        </div>
        {error && <p className="px-2 text-sm text-destructive">{error}</p>}
        <div className="flex max-h-80 flex-col overflow-y-auto">
          {tokens === null ? (
            <Skeleton className="m-1 h-12 rounded-xl" />
          ) : tokens.length === 0 ? (
            <p className="rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground">
              No agents yet. Copy the prompt for your agent. It signs in the first time it
              publishes.
            </p>
          ) : (
            tokens.map((token) => (
              <div
                key={token.id}
                className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-muted/50"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
                    <BotIcon className="size-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{token.clientName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {token.lastUsedAt
                        ? `Last used ${formatDateTime(token.lastUsedAt)}`
                        : `Connected ${formatDateTime(token.createdAt)}`}
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => void revoke(token)}>
                  Disconnect
                </Button>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
