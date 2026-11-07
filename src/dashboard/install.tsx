import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LinkIcon,
  SmartphoneIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { renderSVG } from "uqr";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { GroupButton } from "~/dashboard/controls";
import { PANEL_CLASS } from "~/dashboard/variant-switch";
import type { InstallStatus } from "~/lib/testflight-testers";
import { cn } from "~/lib/utils";
import { napConfig } from "~/nap.config";

/**
 * Get the app: the instance's one Nap app, from TestFlight. The bar has a Get the app button with
 * a popover (a sheet on phones); Steps, Canvas, and Vending each have a spot of their own with a
 * QR code, and phones get a banner. All of them share one state, so opening any of them opens
 * the same panel. Only on a Nap with napConfig.apps.testFlight.
 */

export const TESTFLIGHT_ENABLED = Boolean(napConfig.apps?.testFlight.appStoreId);
/** The TestFlight app on the App Store. */
const TESTFLIGHT_STORE_URL = "https://apps.apple.com/app/testflight/id899247664";
/** The page with the same flow, to send people a link to, and where QR codes go. */
export const INSTALL_PAGE = "/app";
/** While Apple is busy (an invite, a build), the open panel asks again this often. */
const POLL_MS = 8_000;

type Status = InstallStatus | { enabled: false };

type InstallState = {
  status: InstallStatus | null;
  error: string;
  busy: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  invite: (email: string) => Promise<void>;
  forget: () => Promise<void>;
  refresh: () => Promise<void>;
  isIOS: boolean;
  isPhone: boolean;
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

function useIsPhone() {
  const [phone, setPhone] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
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

/** Apple still has something to do: the person's team invite, or the build. */
function waiting(status: InstallStatus | null) {
  if (!status) return false;
  return (
    status.step.kind === "team_invited" ||
    (status.step.kind === "tester" && status.step.tester === "invited") ||
    status.build?.state === "processing"
  );
}

/**
 * The state every spot shares. `page`: the /app page, where the panel is always open and there is
 * no sheet.
 */
export function InstallProvider({
  children,
  page = false,
}: {
  children: React.ReactNode;
  page?: boolean;
}) {
  const [status, setStatus] = React.useState<InstallStatus | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(page);
  const isIOS = useIsIOS();
  const isPhone = useIsPhone();

  const run = React.useCallback(async (request: () => Promise<Status>) => {
    try {
      const next = await request();
      setStatus(next.enabled ? next : null);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const refresh = React.useCallback(() => run(() => call("GET")), [run]);

  React.useEffect(() => {
    if (!TESTFLIGHT_ENABLED) return;
    void refresh();
  }, [refresh]);

  // Opening asks again; while it is open and Apple is busy, keep asking.
  React.useEffect(() => {
    if (!open || !TESTFLIGHT_ENABLED) return;
    void refresh();
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

  const value = React.useMemo<InstallState>(
    () => ({
      status,
      error,
      busy,
      open,
      setOpen,
      invite: (email) => withBusy(() => call("POST", { email })),
      forget: () => withBusy(() => call("DELETE")),
      refresh: () => withBusy(() => call("GET")),
      isIOS,
      isPhone,
    }),
    [status, error, busy, open, withBusy, isIOS, isPhone],
  );

  if (!TESTFLIGHT_ENABLED) return children;
  if (page) return <InstallContext value={value}>{children}</InstallContext>;
  return (
    <InstallContext value={value}>
      {children}
      {/* On phones the panel is a sheet: the bar has no room for a popover. */}
      <Dialog open={open && isPhone} onOpenChange={setOpen}>
        <DialogContent className="gap-0 p-0 sm:max-w-sm">
          <DialogTitle className="sr-only">Nap for iPhone</DialogTitle>
          <InstallPanel />
        </DialogContent>
      </Dialog>
    </InstallContext>
  );
}

/**
 * The extra spots show until Apple says the app is installed; the bar button always stays. They
 * show while the status loads, so they don't pop in late.
 */
export function useShowInstallSpots() {
  const install = useInstall();
  if (!install) return false;
  const step = install.status?.step;
  return !(step?.kind === "tester" && step.tester === "installed");
}

/** The /app page's address on this Nap. */
export function installPageUrl() {
  return typeof window === "undefined" ? "" : `${window.location.origin}${INSTALL_PAGE}`;
}

/** Where a QR code points: straight to TestFlight for testers, else the /app page. */
function qrTarget(status: InstallStatus | null) {
  if (status?.step.kind === "tester") return status.webUrl;
  return installPageUrl();
}

// ---- Pieces --------------------------------------------------------------------------------

export function AppIcon({ className }: { className?: string }) {
  return (
    <img
      src="/app-icon.png"
      alt=""
      className={cn("size-11 shrink-0 rounded-[22.5%] shadow-sm ring-1 ring-black/5", className)}
    />
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

function BuildLine({ build }: { build: InstallStatus["build"] }) {
  if (!build) return <span>Nothing is published yet.</span>;
  if (build.state === "processing")
    return (
      <span className="inline-flex items-center gap-1.5">
        <Spinner className="size-3" />
        Apple is processing build {build.buildNumber}…
      </span>
    );
  if (build.state === "failed")
    return (
      <span className="text-destructive">Build {build.buildNumber} didn't reach TestFlight.</span>
    );
  return <span>Build {build.buildNumber} · ready</span>;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl bg-muted p-3 text-[13px] leading-snug text-foreground/80">
      {children}
    </div>
  );
}

/**
 * The panel: the same in the popover, the phone sheet, and the /app page. The page shows its own
 * header, a bigger QR code, and no link to itself.
 */
export function InstallPanel({ className, page = false }: { className?: string; page?: boolean }) {
  const install = useInstall();
  if (!install) return null;
  const { status, error, busy, isIOS } = install;
  return (
    <div className={cn("flex flex-col gap-4 p-4", className)}>
      <div className={cn("flex items-center gap-3", page && "hidden")}>
        <AppIcon />
        <div className="flex min-w-0 flex-col">
          <b className="text-[15px] font-semibold">Nap for iPhone</b>
          <span className="text-[13px] text-muted-foreground">
            Open the apps you make here, on your phone.
          </span>
        </div>
      </div>
      {!status ? (
        error ? null : (
          <Skeleton className="h-28 rounded-xl" />
        )
      ) : status.step.kind === "new" ? (
        <InviteForm key="new" />
      ) : status.step.kind === "team_invited" ? (
        <>
          <Note>
            {status.step.pending ? (
              <>
                <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                <span>
                  <b className="font-semibold">Invite sent.</b> Accept Apple's email to{" "}
                  {status.appleEmail} to join {napConfig.orgName} in App Store Connect, then come
                  back here.
                </span>
              </>
            ) : (
              <span>
                Apple has no open invite for {status.appleEmail}. If you accepted it with another
                Apple Account, use that email.
              </span>
            )}
          </Note>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="rounded-full" disabled={busy} onClick={install.refresh}>
              {busy && <Spinner data-icon="inline-start" />}
              I've accepted it
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              disabled={busy}
              onClick={install.forget}
            >
              Use another email
            </Button>
          </div>
        </>
      ) : (
        <>
          {status.step.tester === "invited" && (
            <Note>
              <span>
                Accept the TestFlight invite Apple emailed to {status.appleEmail}, then open Nap in
                TestFlight.
              </span>
            </Note>
          )}
          {isIOS ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  className="rounded-full"
                  nativeButton={false}
                  render={<a href={status.url} />}
                >
                  <ExternalLinkIcon data-icon="inline-start" />
                  Open in TestFlight
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  nativeButton={false}
                  render={<a href={TESTFLIGHT_STORE_URL} target="_blank" rel="noreferrer" />}
                >
                  <DownloadIcon data-icon="inline-start" />
                  Get TestFlight
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">
                <BuildLine build={status.build} />
              </span>
            </div>
          ) : (
            <div className={cn("flex items-center gap-4", page && "max-sm:flex-col sm:gap-6")}>
              <QrCode
                value={status.webUrl}
                className={cn("ring-1 ring-border", page && "size-44")}
              />
              <div className="flex flex-col gap-2 text-[13px] leading-snug text-muted-foreground">
                <span className="text-foreground/80">
                  Scan with your iPhone camera to open Nap in TestFlight.
                </span>
                <span className="text-xs">
                  <BuildLine build={status.build} />
                </span>
                <a
                  href={TESTFLIGHT_STORE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs underline-offset-2 hover:underline"
                >
                  No TestFlight yet? Get it on the App Store.
                </a>
              </div>
            </div>
          )}
          <span className="text-xs text-muted-foreground">
            Apple's emails go to {status.appleEmail}.{" "}
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
      )}
      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
      {!page && <ShareLink />}
    </div>
  );
}

/** The /app page's link, for sending to someone who wants the app. */
function ShareLink() {
  const [copied, setCopied] = React.useState(false);
  const url = installPageUrl();
  return (
    <div className="-mx-4 -mb-4 flex items-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
      <LinkIcon className="size-3.5 shrink-0" />
      <a
        href={INSTALL_PAGE}
        className="min-w-0 flex-1 truncate underline-offset-2 hover:text-foreground hover:underline"
      >
        {url.replace(/^https?:\/\//, "")}
      </a>
      <Button
        size="xs"
        variant="ghost"
        className="rounded-full"
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          });
        }}
      >
        {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
        {copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}

function InviteForm() {
  const install = useInstall()!;
  // Not the Nap sign-in: most people's Apple Account is a personal address.
  const [email, setEmail] = React.useState(install.status?.appleEmail ?? "");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void install.invite(email);
      }}
    >
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px] text-foreground/80">
        <li>Nap asks Apple to invite you.</li>
        <li>Accept Apple's emails: one for App Store Connect, then one for TestFlight.</li>
        <li>Install Nap from the TestFlight app.</li>
      </ol>
      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        Your Apple Account email
        <Input
          type="email"
          required
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@icloud.com"
          autoComplete="email"
        />
        <span>
          The one you sign in to the App Store with. For most people that's a personal address, not
          their work email.
        </span>
      </label>
      <Button type="submit" className="rounded-full" disabled={install.busy}>
        {install.busy && <Spinner data-icon="inline-start" />}
        Send me an invite
      </Button>
    </form>
  );
}

// ---- Where it shows ------------------------------------------------------------------------

/** In the bar, in every layout. A popover on wider screens; on phones it opens the sheet. */
export function GetAppButton() {
  const install = useInstall();
  if (!install) return null;
  const label = (
    <>
      <SmartphoneIcon data-icon="inline-start" />
      <span className="max-sm:sr-only">Get the app</span>
    </>
  );
  if (install.isPhone)
    return (
      <GroupButton aria-label="Get the app" onClick={() => install.setOpen(true)}>
        {label}
      </GroupButton>
    );
  return (
    <Popover open={install.open} onOpenChange={install.setOpen}>
      <PopoverTrigger render={<GroupButton aria-label="Get the app" />}>{label}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className={cn(PANEL_CLASS, "w-[380px] max-w-[calc(100vw-2rem)] gap-0 p-0 ring-0")}
      >
        <InstallPanel />
      </PopoverContent>
    </Popover>
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
        <b className="text-[15px] font-semibold">Nap for iPhone</b>
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
      <b className="text-sm font-semibold">Nap for iPhone</b>
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
        NAP FOR
        <br />
        iPHONE
        <br />
        <span className="opacity-60">SCAN ME</span>
      </span>
    </button>
  );
}

const BANNER_KEY = "nap:app-banner-dismissed";

/** Phones: a banner under the bar, until it's installed or dismissed. iPhones only. */
export function PhoneInstallBanner({ className }: { className?: string }) {
  const install = useInstall();
  const show = useShowInstallSpots();
  const [dismissed, setDismissed] = React.useState(true);
  React.useEffect(() => setDismissed(localStorage.getItem(BANNER_KEY) === "1"), []);
  if (!install || !show || dismissed || !install.isIOS || !install.isPhone) return null;
  const tester = install.status?.step.kind === "tester";
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-2xl border bg-card p-3 text-card-foreground shadow-sm",
        className,
      )}
    >
      <AppIcon className="size-[42px]" />
      <div className="flex min-w-0 flex-1 flex-col">
        <b className="text-[14.5px] font-semibold">Nap for iPhone</b>
        <span className="truncate text-xs text-muted-foreground">Open the apps you make here</span>
      </div>
      {tester ? (
        <Button
          size="sm"
          className="rounded-full"
          nativeButton={false}
          render={<a href={install.status!.url} />}
        >
          Get
        </Button>
      ) : (
        <Button size="sm" className="rounded-full" onClick={() => install.setOpen(true)}>
          Get
        </Button>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        className="-mr-1 rounded-full text-muted-foreground"
        aria-label="Dismiss"
        onClick={() => {
          localStorage.setItem(BANNER_KEY, "1");
          setDismissed(true);
        }}
      >
        <XIcon />
      </Button>
    </div>
  );
}
