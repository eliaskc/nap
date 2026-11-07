import {
  DownloadIcon,
  ExternalLinkIcon,
  MailIcon,
  SmartphoneIcon,
  TabletIcon,
  UsbIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { renderSVG } from "uqr";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "~/components/ui/drawer";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { GroupButton, GroupTab, GroupTabs } from "~/dashboard/controls";
import { iconUrl } from "~/lib/icons";
import type { InstallStatus } from "~/lib/testflight-testers";
import { cn } from "~/lib/utils";
import { napConfig } from "~/nap.config";

/**
 * Get the app: the instance's one Nap app, on each platform it has (iPhone through TestFlight,
 * reMarkable over USB once). It all happens in one sheet (Base UI's Drawer) that comes up from the bottom: the bar's
 * button opens it, and so do the nudge above the list, the playful layouts' QR spots, and any
 * link to /app (which lands on the dashboard as #app). The bar button says your next step.
 */

const IOS = Boolean(napConfig.apps?.ios?.appStoreId);
type Target = "ios" | "remarkable";
/** The platforms this Nap has, in the switch's order. iOS only once its app record exists. */
const TARGETS: Array<Target> = [
  ...(IOS ? (["ios"] as const) : []),
  ...(napConfig.apps?.remarkable ? (["remarkable"] as const) : []),
];
export const APP_ENABLED = TARGETS.length > 0;

const PLATFORM: Record<Target, { label: string; device: string; icon: typeof SmartphoneIcon }> = {
  ios: { label: "iPhone", device: "phone", icon: SmartphoneIcon },
  remarkable: { label: "reMarkable", device: "reMarkable", icon: TabletIcon },
};

/** The TestFlight app on the App Store. */
const TESTFLIGHT_STORE_URL = "https://apps.apple.com/app/testflight/id899247664";
/** The link to send people. It opens the dashboard with the sheet open. */
export const INSTALL_PAGE = "/app";
/** While Apple is busy (an invite, a build), the open sheet asks again this often. */
const POLL_MS = 8_000;

type Status = InstallStatus | { enabled: false };

type BuildApp = { slug: string; title: string; summary: string };
type LiveBuild = {
  buildNumber: number;
  status: "signing" | "ready" | "failed";
  notes: string;
  by: string;
  createdAt: string;
  apps: Array<BuildApp> | null;
  testFlight: { state: "processing" | "ready" | "failed"; error: string | null } | null;
};
type AppSheet = {
  title: string;
  platforms: Array<{ target: Target; live: LiveBuild | null }>;
  nudgeDismissed: boolean;
};

type InstallState = {
  /** The iPhone side: where the person is with Apple. Null while it loads or without iOS. */
  status: InstallStatus | null;
  /** Apple has answered (or failed to) at least once, here or in this browser before. */
  statusKnown: boolean;
  app: AppSheet | null;
  error: string;
  busy: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  target: Target;
  setTarget: (target: Target) => void;
  invite: (email: string) => Promise<void>;
  forget: () => Promise<void>;
  refresh: () => Promise<void>;
  dismissNudge: () => void;
  isIOS: boolean;
};

const InstallContext = React.createContext<InstallState | null>(null);

export function useInstall() {
  return React.use(InstallContext);
}

function useIsIOS() {
  return React.useMemo(
    () =>
      typeof navigator !== "undefined" &&
      (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)),
    [],
  );
}

async function call(method: "GET" | "POST" | "DELETE", body?: unknown) {
  const response = await fetch(
    "/api/testflight",
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const data = (await response.json().catch(() => ({}))) as Status & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Something went wrong. Try again.");
  return data;
}

async function loadApp() {
  const response = await fetch("/api/app");
  if (!response.ok) return null;
  const data = (await response.json()) as ({ enabled: true } & AppSheet) | { enabled: false };
  return data.enabled ? data : null;
}

/** Apple still has something to do: the person's team invite, or the build. */
function waiting(status: InstallStatus | null) {
  if (!status) return false;
  return (
    status.step.kind === "team_invited" ||
    (status.step.kind === "tester" && status.step.tester === "invited") ||
    status.build?.state === "processing"
  );
}

/** #app opens the sheet, and #app/remarkable on that platform. */
function fromHash(): Target | true | null {
  const match = /^#app(?:\/(\w+))?$/.exec(window.location.hash);
  if (!match) return null;
  const asked = match[1] as Target | undefined;
  return asked && TARGETS.includes(asked) ? asked : true;
}

/**
 * The last answers, kept in this browser, so the bar and the nudge are right from the first paint
 * instead of changing once Apple answers (which takes a moment).
 */
const CACHE_KEY = "nap:get-the-app";
type Cached = { status: InstallStatus | null; app: AppSheet | null };
function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}
function writeCache(change: Partial<Cached>) {
  try {
    const next = { status: null, app: null, ...readCache(), ...change };
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or full: it only saves a flicker.
  }
}
const useBeforePaint = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/** The state every spot shares, and the sheet. */
export function InstallProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<InstallStatus | null>(null);
  const [statusKnown, setStatusKnown] = React.useState(!IOS);
  const [app, setApp] = React.useState<AppSheet | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState<Target>(TARGETS[0] ?? "ios");
  const isIOS = useIsIOS();

  const run = React.useCallback(async (request: () => Promise<Status>) => {
    try {
      const next = await request();
      const fresh = next.enabled ? next : null;
      setStatus(fresh);
      writeCache({ status: fresh });
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStatusKnown(true);
    }
  }, []);

  const refreshApp = React.useCallback(async () => {
    const next = await loadApp().catch(() => null);
    if (next) {
      setApp(next);
      writeCache({ app: next });
    }
  }, []);

  useBeforePaint(() => {
    if (!APP_ENABLED) return;
    const cached = readCache();
    if (cached?.app) setApp(cached.app);
    if (IOS && cached?.status) {
      setStatus(cached.status);
      setStatusKnown(true);
    }
  }, []);
  const refresh = React.useCallback(
    () => Promise.all([IOS ? run(() => call("GET")) : null, refreshApp()]).then(() => {}),
    [run, refreshApp],
  );

  React.useEffect(() => {
    if (!APP_ENABLED) return;
    void refresh();
  }, [refresh]);

  // Links to /app land here as #app. Open, then drop the hash so closing stays closed.
  React.useEffect(() => {
    if (!APP_ENABLED) return;
    const check = () => {
      const asked = fromHash();
      if (!asked) return;
      if (asked !== true) setTarget(asked);
      setOpen(true);
      history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);

  // Opening asks again; while it is open and Apple is busy, keep asking.
  React.useEffect(() => {
    if (open && APP_ENABLED) void refresh();
  }, [open, refresh]);
  const poll = open && waiting(status);
  React.useEffect(() => {
    if (!poll) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [poll, refresh]);

  const withBusy = React.useCallback(
    async (request: () => Promise<Status>) => {
      setBusy(true);
      await run(request);
      setBusy(false);
    },
    [run],
  );

  const dismissNudge = React.useCallback(() => {
    setApp((current) => {
      const next = current && { ...current, nudgeDismissed: true };
      writeCache({ app: next });
      return next;
    });
    void fetch("/api/app", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dismissNudge: true }),
    });
  }, []);

  const value = React.useMemo<InstallState>(
    () => ({
      status,
      statusKnown,
      app,
      error,
      busy,
      open,
      setOpen,
      target,
      setTarget,
      invite: (email) => withBusy(() => call("POST", { email })),
      forget: () => withBusy(() => call("DELETE")),
      refresh: () => withBusy(() => call("GET")),
      dismissNudge,
      isIOS,
    }),
    [status, statusKnown, app, error, busy, open, target, withBusy, dismissNudge, isIOS],
  );

  if (!APP_ENABLED) return children;
  return (
    <InstallContext value={value}>
      {children}
      <AppSheetView />
    </InstallContext>
  );
}

/** The app's name: the app record's title, or the instance's name until there is one. */
function appTitle(install: InstallState | null) {
  return install?.app?.title || napConfig.orgName;
}

/** Apple says the iPhone app is installed. */
function installed(status: InstallStatus | null) {
  return status?.step.kind === "tester" && status.step.tester === "installed";
}

/**
 * The extra spots show until Apple says the app is installed; the bar button always stays. They
 * show while the status loads, so they don't pop in late. Only with iOS: they are QR codes.
 */
export function useShowInstallSpots() {
  const install = useInstall();
  if (!install || !IOS) return false;
  return !installed(install.status);
}

/** The link to send people, on this Nap. */
export function installPageUrl() {
  return typeof window === "undefined" ? "" : `${window.location.origin}${INSTALL_PAGE}`;
}

/** Where a QR code points: straight to TestFlight for testers, else the sheet. */
function qrTarget(status: InstallStatus | null) {
  if (status?.step.kind === "tester") return status.webUrl;
  return installPageUrl();
}

// ---- Pieces --------------------------------------------------------------------------------

/** The app's icon: Nap's, or the instance's (instance/icon), light or dark with the theme. */
export function AppIcon({ className }: { className?: string }) {
  const base = "size-11 shrink-0 rounded-[22.5%] shadow-sm";
  return (
    <>
      <img src={iconUrl("app-icon.png")} alt="" className={cn(base, "dark:hidden", className)} />
      <img
        src={iconUrl("app-icon-dark.png")}
        alt=""
        className={cn(base, "hidden dark:block", className)}
      />
    </>
  );
}

export function QrCode({
  value,
  className,
  dark = "#0a0a0a",
  light = "#ffffff",
}: {
  value: string;
  className?: string;
  dark?: string;
  light?: string;
}) {
  const svg = React.useMemo(
    () =>
      value ? renderSVG(value, { border: 2, ecc: "M", blackColor: dark, whiteColor: light }) : "",
    [value, dark, light],
  );
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block size-28 shrink-0 overflow-hidden rounded-lg [&_svg]:size-full",
        className,
      )}
      // uqr renders a self-contained SVG from the text alone.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** "Daily games, Weave and Hello": what's inside, for the nudge and the sheet's head. */
function inside(app: AppSheet | null) {
  const titles = [
    ...new Set(app?.platforms.flatMap((p) => p.live?.apps?.map((a) => a.title) ?? []) ?? []),
  ];
  if (titles.length === 0) return "";
  if (titles.length === 1) return titles[0]!;
  return `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
}

function platformList() {
  const names = TARGETS.map((t) => PLATFORM[t].label);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
}

/** The sheet's line under the name. */
function tagline(app: AppSheet | null) {
  const what = inside(app);
  return what
    ? `${what}, on your ${platformList()}.`
    : `The apps people make here, on your ${platformList()}.`;
}

const ROW = "flex items-center gap-3 border-b py-2.5 last:border-b-0";

/** The card's status line: a dot and a few words. */
function StatusLine({
  tone,
  children,
}: {
  tone: "ok" | "wait" | "error";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[12.5px] font-medium",
        tone === "ok" && "text-emerald-700 dark:text-emerald-400",
        tone === "wait" && "text-blue-700 dark:text-blue-400",
        tone === "error" && "text-destructive",
      )}
    >
      <i
        className={cn(
          "size-[7px] shrink-0 rounded-full",
          tone === "ok" && "bg-emerald-500",
          tone === "wait" && "bg-blue-600 ring-3 ring-blue-600/20",
          tone === "error" && "bg-destructive",
        )}
      />
      {children}
    </span>
  );
}

function BuildState({ build }: { build: InstallStatus["build"] }) {
  if (build?.state === "processing")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3" />
        Apple is processing build {build.buildNumber}. It's in TestFlight in a few minutes.
      </span>
    );
  if (build?.state === "failed")
    return (
      <span className="text-xs text-destructive">
        Build {build.buildNumber} didn't reach TestFlight.
      </span>
    );
  return null;
}

/** The card's text column: status, a title, a sentence, and whatever else. */
function CardText({
  status,
  title,
  detail,
  children,
}: {
  status?: React.ReactNode;
  title: string;
  detail: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 text-center sm:items-start sm:text-left">
      {status}
      <b className="text-xl font-semibold tracking-[-0.02em] sm:text-[22px]">{title}</b>
      <span className="max-w-[380px] text-sm leading-normal text-muted-foreground sm:text-[14.5px]">
        {detail}
      </span>
      {children}
    </div>
  );
}

/** The QR code (or what stands in for it) next to the text, stacked on phones. */
function CardRow({ art, children }: { art: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:gap-7">
      {art}
      {children}
    </div>
  );
}

// ---- The iPhone card -----------------------------------------------------------------------

function IosCard() {
  const install = useInstall()!;
  const { status, error, busy, isIOS } = install;
  const title = appTitle(install);
  if (!status) return error ? null : <Skeleton className="h-49 rounded-xl" />;

  if (status.step.kind === "new") return <InviteForm key="new" />;

  if (status.step.kind === "team_invited") {
    const pending = status.step.pending;
    return (
      <CardRow art={<MailArt />}>
        <CardText
          status={
            pending ? (
              <StatusLine tone="wait">Invite sent · {status.appleEmail}</StatusLine>
            ) : (
              <StatusLine tone="error">No open invite · {status.appleEmail}</StatusLine>
            )
          }
          title={pending ? "Check your email" : "Apple has no invite for you"}
          detail={
            pending
              ? `Accept Apple's email to join ${napConfig.orgName} in App Store Connect, then come back here.`
              : "If you accepted it with another Apple Account, use that email instead."
          }
        >
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button className="rounded-full" disabled={busy} onClick={install.refresh}>
              {busy && <Spinner data-icon="inline-start" />}
              I've accepted it
            </Button>
            <Button
              variant="outline"
              className="rounded-full"
              disabled={busy}
              onClick={install.forget}
            >
              Use another email
            </Button>
          </div>
        </CardText>
      </CardRow>
    );
  }

  const invited = status.step.tester === "invited";
  const line = invited ? (
    <StatusLine tone="wait">TestFlight invite sent · {status.appleEmail}</StatusLine>
  ) : (
    <StatusLine tone="ok">
      {status.step.tester === "installed" ? "Installed" : "You're a tester"} · {status.appleEmail}
    </StatusLine>
  );
  const extras = (
    <>
      <BuildState build={status.build} />
      <span className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:justify-start">
        <a
          href={TESTFLIGHT_STORE_URL}
          target="_blank"
          rel="noreferrer"
          className="underline-offset-2 hover:text-foreground hover:underline"
        >
          No TestFlight yet? Get it on the App Store
        </a>
        <button
          type="button"
          className="underline-offset-2 hover:text-foreground hover:underline"
          disabled={busy}
          onClick={install.forget}
        >
          Use another email
        </button>
      </span>
    </>
  );
  const detail = invited
    ? `Accept the TestFlight invite Apple emailed you, then install ${title} there. TestFlight keeps it up to date.`
    : `It opens ${title} in TestFlight. Install it there; TestFlight keeps it up to date.`;

  if (isIOS)
    return (
      // The sheet's head already shows the icon, and there's nothing to scan on the phone itself.
      <CardRow art={null}>
        <CardText status={line} title="Open it in TestFlight" detail={detail}>
          <div className="mt-1 flex flex-wrap justify-center gap-2 sm:justify-start">
            <Button
              size="lg"
              className="rounded-full px-4"
              nativeButton={false}
              render={<a href={status.url} />}
            >
              <ExternalLinkIcon data-icon="inline-start" />
              Open in TestFlight
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="rounded-full px-4"
              nativeButton={false}
              render={<a href={TESTFLIGHT_STORE_URL} target="_blank" rel="noreferrer" />}
            >
              <DownloadIcon data-icon="inline-start" />
              Get TestFlight
            </Button>
          </div>
          <BuildState build={status.build} />
        </CardText>
      </CardRow>
    );

  return (
    <CardRow
      art={
        <QrCode
          value={status.webUrl}
          className="size-44 rounded-xl ring-1 ring-border sm:size-49"
        />
      }
    >
      <CardText status={line} title="Scan with your iPhone camera" detail={detail}>
        {extras}
      </CardText>
    </CardRow>
  );
}

/** Stands in for the QR code while there is nothing to scan yet. */
function MailArt() {
  return (
    <span className="grid size-36 shrink-0 place-items-center rounded-2xl border-2 border-dashed bg-muted/50 text-muted-foreground sm:size-49">
      <MailIcon className="size-10" />
    </span>
  );
}

function InviteForm() {
  const install = useInstall()!;
  // Not the Nap sign-in: most people's Apple Account is a personal address.
  const [email, setEmail] = React.useState(install.status?.appleEmail ?? "");
  return (
    <form
      className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-7"
      onSubmit={(event) => {
        event.preventDefault();
        void install.invite(email);
      }}
    >
      <div className="flex flex-col gap-2 sm:w-[46%]">
        <b className="text-xl font-semibold tracking-[-0.02em] sm:text-[22px]">
          Get it with TestFlight
        </b>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm leading-normal text-muted-foreground">
          <li>Nap asks Apple to invite you.</li>
          <li>Accept Apple's emails: one for App Store Connect, then one for TestFlight.</li>
          <li>Install it from the TestFlight app.</li>
        </ol>
      </div>
      <label className="flex flex-1 flex-col gap-1.5 text-xs text-muted-foreground">
        Your Apple Account email
        <Input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@icloud.com"
          autoComplete="email"
          className="h-10 rounded-xl text-base sm:text-sm"
        />
        <span>
          The one you sign in to the App Store with. For most people that's a personal address, not
          their work email.
        </span>
        <Button type="submit" size="lg" className="mt-2 rounded-full" disabled={install.busy}>
          {install.busy && <Spinner data-icon="inline-start" />}
          Send me an invite
        </Button>
      </label>
    </form>
  );
}

// ---- The reMarkable card -------------------------------------------------------------------

function RemarkableCard() {
  return (
    <CardRow
      art={
        <span className="grid size-36 shrink-0 place-items-center rounded-2xl border-2 border-dashed bg-muted/50 text-muted-foreground sm:size-49">
          <UsbIcon className="size-10" />
        </span>
      }
    >
      <CardText
        title="Install over USB, once"
        detail="Plug in the tablet, then run this from the repo. After that it updates itself from Nap."
      >
        <code className="mt-1 rounded-[10px] border bg-muted px-3 py-2 font-mono text-[13px]">
          remarkable/scripts/install
        </code>
      </CardText>
    </CardRow>
  );
}

// ---- Inside and What's new -----------------------------------------------------------------

const TINTS = [
  "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  "bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200",
  "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
];
const tint = (slug: string) =>
  TINTS[[...slug].reduce((sum, c) => sum + c.charCodeAt(0), 0) % TINTS.length]!;

function Inside({ build, target }: { build: LiveBuild | null; target: Target }) {
  const apps = build?.apps ?? [];
  if (apps.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {build ? "This build doesn't say yet. The next one will." : "Nothing is published yet."}
      </p>
    );
  return (
    <div className="flex flex-col">
      {apps.map((app) => (
        <div key={app.slug} className={ROW}>
          <span
            className={cn(
              "grid size-[38px] shrink-0 place-items-center rounded-[10px] text-base font-semibold",
              target === "remarkable" ? "bg-muted text-foreground" : tint(app.slug),
            )}
          >
            {app.title.slice(0, 1).toUpperCase()}
          </span>
          <div className="flex min-w-0 flex-col gap-px">
            <b className="text-[14.5px] font-semibold">{app.title}</b>
            {app.summary && (
              <span className="truncate text-[13px] text-muted-foreground">{app.summary}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function when(iso: string) {
  const date = new Date(iso);
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function WhatsNew({ build }: { build: LiveBuild | null }) {
  if (!build) return <p className="text-sm text-muted-foreground">No builds yet.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <b className="text-[14.5px] font-semibold">Build {build.buildNumber}</b>
        <span className="text-[12.5px] text-muted-foreground">
          {when(build.createdAt)} · {build.by.split("@")[0]}
        </span>
      </div>
      <p className="text-[14.5px] leading-normal text-foreground/80">
        {build.notes || "No notes for this build."}
      </p>
    </div>
  );
}

// ---- The sheet -----------------------------------------------------------------------------

function AppSheetView() {
  const install = useInstall()!;
  const { app, target } = install;
  const title = appTitle(install);
  const live = app?.platforms.find((p) => p.target === target)?.live ?? null;
  const count = live?.apps?.length ?? 0;
  // Opening with a click focuses the page, not the close button (which would show its ring).
  const scroller = React.useRef<HTMLDivElement>(null);
  return (
    // Base UI's Drawer: swipe it down to close on a touch screen, or ×.
    <Drawer open={install.open} onOpenChange={install.setOpen}>
      <DrawerContent
        initialFocus={(type) => (type === "keyboard" ? true : scroller.current)}
        className={cn(
          "overflow-hidden border-0 bg-background shadow-[0_-10px_60px_rgb(0_0_0/0.25)]",
          "h-[calc(100dvh-3.5rem)] max-h-none rounded-t-[22px] data-[swipe-direction=down]:rounded-t-[22px]",
          "sm:mx-auto sm:h-[calc(100dvh-2.25rem)] sm:w-[min(900px,calc(100vw-2rem))] sm:data-[swipe-direction=down]:rounded-t-[28px]",
        )}
      >
        {/* One row, over the scrolling page: the handle (phones) and ×, on the same line. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-14 items-center justify-center">
          <span aria-hidden className="h-[5px] w-10 rounded-full bg-foreground/15 sm:hidden" />
          <DrawerClose
            render={
              <Button
                variant="secondary"
                size="icon"
                className="pointer-events-auto absolute top-1/2 right-3 size-9 -translate-y-1/2 rounded-full sm:right-4"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DrawerClose>
        </div>
        <div
          ref={scroller}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-muted/40 outline-none"
        >
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 pt-12 pb-12 sm:gap-[26px] sm:px-6 sm:pt-10">
            <div className="flex flex-col items-center gap-2.5 text-center">
              <AppIcon className="size-[72px] shadow-md sm:size-[88px]" />
              <DrawerTitle className="mt-1.5 text-3xl font-semibold tracking-[-0.03em] sm:text-[38px]">
                {title}
              </DrawerTitle>
              <DrawerDescription className="mb-2 text-balance text-muted-foreground sm:text-[15px]">
                {tagline(app)}
              </DrawerDescription>
              {TARGETS.length > 1 && (
                <GroupTabs value={target} onValueChange={install.setTarget} label="Platform">
                  {TARGETS.map((name) => {
                    const Icon = PLATFORM[name].icon;
                    return (
                      <GroupTab key={name} value={name}>
                        <Icon data-icon="inline-start" />
                        {PLATFORM[name].label}
                      </GroupTab>
                    );
                  })}
                </GroupTabs>
              )}
            </div>
            <section className="rounded-[22px] border bg-card p-5 text-card-foreground shadow-[0_12px_34px_-20px_rgb(0_0_0/0.25)] sm:px-7 sm:py-[26px]">
              {target === "ios" ? <IosCard /> : <RemarkableCard />}
              {target === "ios" && install.error && (
                <p role="alert" className="mt-4 text-center text-[13px] text-destructive">
                  {install.error}
                </p>
              )}
            </section>
            <div className="grid gap-8 sm:grid-cols-[1.3fr_1fr] sm:gap-9">
              <section className="min-w-0">
                <h2 className="mb-3 flex items-baseline gap-2 text-lg font-semibold tracking-[-0.02em]">
                  Inside
                  {count > 0 && (
                    <span className="text-[13px] font-medium text-muted-foreground">
                      {count} {count === 1 ? "app" : "apps"}
                    </span>
                  )}
                </h2>
                {app ? (
                  <Inside build={live} target={target} />
                ) : (
                  <Skeleton className="h-32 rounded-xl" />
                )}
              </section>
              <section className="min-w-0">
                <h2 className="mb-3 text-lg font-semibold tracking-[-0.02em]">What's new</h2>
                {app ? <WhatsNew build={live} /> : <Skeleton className="h-20 rounded-xl" />}
              </section>
            </div>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

// ---- Where it shows ------------------------------------------------------------------------

type Tone = "plain" | "wait" | "warn" | "busy" | "error";

/** The bar button's words: your next step, or how the newest build is doing. */
function nextStep(status: InstallStatus | null): { label: string; tone: Tone } | null {
  if (!status) return { label: "Get the app", tone: "plain" };
  const step = status.step;
  if (step.kind === "new") return { label: "Get the app", tone: "plain" };
  if (step.kind === "team_invited")
    return step.pending
      ? { label: "Check your email", tone: "wait" }
      : { label: "Invite not found", tone: "warn" };
  if (step.tester === "invited") return { label: "Accept in TestFlight", tone: "wait" };
  const build = status.build;
  if (build?.state === "processing")
    return { label: `Build ${build.buildNumber} on its way`, tone: "busy" };
  if (build?.state === "failed")
    return { label: `Build ${build.buildNumber} failed`, tone: "error" };
  if (step.tester === "installed") return null;
  return { label: "Install from TestFlight", tone: "plain" };
}

const TONE: Record<Tone, string> = {
  plain: "",
  wait: "text-blue-700 bg-blue-50 hover:bg-blue-100 hover:text-blue-800 dark:text-blue-300 dark:bg-blue-950/60 dark:hover:bg-blue-950",
  warn: "text-amber-700 bg-amber-50 hover:bg-amber-100 hover:text-amber-800 dark:text-amber-300 dark:bg-amber-950/60 dark:hover:bg-amber-950",
  busy: "",
  error:
    "text-red-700 bg-red-50 hover:bg-red-100 hover:text-red-800 dark:text-red-300 dark:bg-red-950/60 dark:hover:bg-red-950",
};
const DOT: Partial<Record<Tone, string>> = {
  wait: "bg-blue-600 ring-3 ring-blue-600/20",
  warn: "bg-amber-600 ring-3 ring-amber-600/20",
  error: "bg-red-600 ring-3 ring-red-600/20",
};

/** In the bar, in every layout. Its label is your next step; once installed, the app's icon. */
export function GetAppButton() {
  const install = useInstall();
  if (!install) return null;
  const title = appTitle(install);
  const next = IOS ? nextStep(install.status) : { label: "Get the app", tone: "plain" as Tone };
  if (!next)
    return (
      <GroupButton
        icon
        aria-label={`${title} · installed`}
        title={`${title} · installed`}
        onClick={() => install.setOpen(true)}
      >
        <AppIcon className="size-5 rounded-[5px] opacity-75 shadow-none" />
      </GroupButton>
    );
  return (
    <GroupButton
      aria-label={next.label}
      title={next.label}
      className={TONE[next.tone]}
      onClick={() => install.setOpen(true)}
    >
      {next.tone === "busy" ? (
        <Spinner data-icon="inline-start" />
      ) : DOT[next.tone] ? (
        <span data-icon="inline-start" className={cn("size-[7px] rounded-full", DOT[next.tone])} />
      ) : (
        <SmartphoneIcon data-icon="inline-start" />
      )}
      <span className="max-sm:sr-only">{next.label}</span>
    </GroupButton>
  );
}

/**
 * Between the prompt and the list: the app, until the person dismisses it (for good, on every
 * device) or Apple says it's installed.
 */
export function AppNudge({ className }: { className?: string }) {
  const install = useInstall();
  // Only once both are known: whether it was dismissed, and whether Apple says it's installed.
  if (!install?.app || !install.statusKnown) return null;
  if (install.app.nudgeDismissed || installed(install.status)) return null;
  const title = appTitle(install);
  const what = inside(install.app);
  const device = TARGETS.includes("ios") ? "phone" : PLATFORM[TARGETS[0]!].device;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-2xl border border-kind-app/20 bg-linear-to-r from-kind-app-soft/70 to-card to-70% p-2.5 pl-3 text-card-foreground sm:gap-4 sm:rounded-[18px] sm:px-[18px] sm:py-4",
        className,
      )}
    >
      <AppIcon className="size-10 shadow-none sm:size-12" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="truncate text-sm font-semibold sm:text-[15px]">
          {title} <span className="max-sm:hidden">is</span> on your {device}
          <span className="max-sm:hidden"> too</span>
        </b>
        <span className="truncate text-xs text-muted-foreground sm:text-[13.5px]">
          {what ? `${what}, on your ${platformList()}.` : `On your ${platformList()}.`}
        </span>
      </div>
      <Button className="rounded-full sm:px-3" onClick={() => install.setOpen(true)}>
        <SmartphoneIcon data-icon="inline-start" className="max-sm:hidden" />
        <span className="sm:hidden">Get</span>
        <span className="max-sm:hidden">Get the app</span>
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        className="-ml-1 shrink-0 rounded-full text-muted-foreground"
        aria-label="Dismiss"
        title="Dismiss. It stays in the bar."
        onClick={install.dismissNudge}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/** Steps: a card at the foot of the dark sidebar. */
export function SidebarInstallCard() {
  const install = useInstall();
  const show = useShowInstallSpots();
  if (!install || !show) return null;
  return (
    <button
      type="button"
      onClick={() => install.setOpen(true)}
      className="mt-auto flex items-center gap-4 rounded-2xl border bg-muted/60 p-3.5 text-left transition-colors hover:bg-muted"
    >
      <QrCode value={qrTarget(install.status)} className="size-[92px]" />
      <span className="flex min-w-0 flex-col gap-1.5">
        <b className="text-[15px] font-semibold">{appTitle(install)} for iPhone</b>
        <span className="text-[13px] leading-snug text-muted-foreground">
          The apps you make open here. Scan to install it with TestFlight.
        </span>
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-foreground/80">
          <SmartphoneIcon className="size-3.5" />
          Get the app
        </span>
      </span>
    </button>
  );
}

/** Canvas: a card pinned over the pile. */
export function PinnedInstallCard({ className }: { className?: string }) {
  const install = useInstall();
  const show = useShowInstallSpots();
  if (!install || !show) return null;
  return (
    <button
      type="button"
      onClick={() => install.setOpen(true)}
      className={cn(
        "relative flex w-[260px] rotate-3 flex-col items-center gap-2.5 rounded-[26px] bg-card p-3.5 text-card-foreground shadow-[0_30px_50px_-18px_rgb(0_0_0/0.4),0_6px_14px_rgb(0_0_0/0.1)] transition-transform hover:rotate-1",
        className,
      )}
    >
      <span className="absolute -top-2 left-1/2 size-[18px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_35%_35%,#f87171,#b91c1c)] shadow-[0_3px_5px_rgb(0_0_0/0.35)]" />
      <span className="flex w-full items-center gap-3 rounded-2xl bg-kind-app-soft/50 p-2.5">
        <QrCode value={qrTarget(install.status)} className="size-[104px]" />
        <span className="flex flex-col items-start gap-2">
          <AppIcon className="size-9" />
          <span className="text-left text-[11.5px] leading-snug text-muted-foreground">
            Scan with your iPhone camera
          </span>
        </span>
      </span>
      <b className="text-sm font-semibold">{appTitle(install)} for iPhone</b>
      <span className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-full bg-kind-app-soft text-[13.5px] font-semibold text-kind-app">
        <SmartphoneIcon className="size-3.5" />
        Get the app
      </span>
    </button>
  );
}

/** Vending: a QR sticker in the slot under the keypad. */
export function VendingInstallSticker() {
  const install = useInstall();
  const show = useShowInstallSpots();
  if (!install || !show) return null;
  return (
    <button
      type="button"
      onClick={() => install.setOpen(true)}
      className="flex items-center gap-2.5 rounded-xl bg-[#1c1917] p-3 text-left shadow-[inset_0_8px_16px_rgb(0_0_0/0.6)] hover:bg-[#292524]"
    >
      <span className="-rotate-3 rounded-md bg-[#fef3c7] p-1.5 shadow-[0_2px_4px_rgb(0_0_0/0.4)]">
        <QrCode
          value={qrTarget(install.status)}
          dark="#1c1917"
          light="#fef3c7"
          className="size-16 rounded-sm"
        />
      </span>
      <span className="font-mono text-[10.5px] leading-[1.45] tracking-[0.08em] text-[#fde68a]">
        GET THE
        <br />
        APP
        <br />
        <span className="opacity-60">SCAN ME</span>
      </span>
    </button>
  );
}
