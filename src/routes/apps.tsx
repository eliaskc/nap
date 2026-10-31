import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, DownloadIcon, PlusIcon, SmartphoneIcon } from "lucide-react";
import * as React from "react";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";

/**
 * /apps — native apps people can install on a registered iPhone. Install opens an itms-services
 * link; iOS asks to confirm and installs, or updates the app in place.
 */
export const Route = createFileRoute("/apps")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { enrolled?: string; enroll_error?: string } => ({
    ...(typeof search.enrolled === "string" ? { enrolled: search.enrolled } : {}),
    ...(typeof search.enroll_error === "string" ? { enroll_error: search.enroll_error } : {}),
  }),
  component: AppsPage,
});

const ENROLL_ERRORS: Record<string, string> = {
  expired: "That profile expired or was already used. Tap Add this iPhone again.",
  unreadable: "iOS sent something Nap could not read. Try again.",
  apple: "Apple did not accept this iPhone. Ask Elias to check the developer account.",
  failed: "Adding the iPhone failed. Try again.",
};

type Build = {
  id: string;
  buildNumber: number;
  sourceCommit: string;
  notes: string;
  name: string;
  by: string;
  createdAt: string;
};

type App = {
  slug: string;
  title: string;
  updatedAt: string;
  targets: Array<{ target: string; bundleId: string; title: string; live: Build | null }>;
};

type Device = { name: string; product: string; addedBy: string; createdAt: string };

function AppsPage() {
  const [apps, setApps] = React.useState<Array<App> | null>(null);
  const [error, setError] = React.useState("");
  const [installing, setInstalling] = React.useState("");
  const [devices, setDevices] = React.useState<Array<Device> | null>(null);
  const [udid, setUdid] = React.useState("");
  const [deviceName, setDeviceName] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [added, setAdded] = React.useState("");
  const search = Route.useSearch();
  const isIOS = React.useMemo(
    () =>
      typeof navigator !== "undefined" &&
      (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)),
    [],
  );

  React.useEffect(() => {
    fetch("/api/apps")
      .then((response) => response.json() as Promise<{ apps: Array<App> }>)
      .then((data) => setApps(data.apps))
      .catch(() => setError("Could not load apps."));
    loadDevices();
  }, []);

  function loadDevices() {
    fetch("/api/devices")
      .then((response) => response.json() as Promise<{ devices: Array<Device> }>)
      .then((data) => setDevices(data.devices))
      .catch(() => setDevices([]));
  }

  async function addDevice(event: React.FormEvent) {
    event.preventDefault();
    setAdding(true);
    setError("");
    setAdded("");
    try {
      const response = await fetch("/api/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ udid, name: deviceName }),
      });
      const data = (await response.json()) as { ok?: boolean; name?: string; error?: string };
      if (!data.ok) throw new Error(data.error ?? "Adding the iPhone failed");
      setAdded(`${data.name} is added. It can install every app below now.`);
      setUdid("");
      setDeviceName("");
      loadDevices();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Adding the iPhone failed");
    } finally {
      setAdding(false);
    }
  }

  async function install(app: string, target: string) {
    setInstalling(`${app}/${target}`);
    setError("");
    try {
      const response = await fetch(`/api/apps/${app}/${target}/install`, { method: "POST" });
      const data = (await response.json()) as { install?: { url: string }; error?: string };
      if (!data.install) throw new Error(data.error ?? "Could not make an install link");
      window.location.href = data.install.url;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not make an install link");
    } finally {
      setTimeout(() => setInstalling(""), 1500);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-5 px-5 py-10">
      <div className="flex items-center gap-3">
        <a
          href="/"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label="Back"
        >
          <ArrowLeftIcon />
        </a>
        <h1 className="text-xl font-semibold">Apps</h1>
      </div>

      {!isIOS && (
        <p className="text-sm text-muted-foreground">
          Open this page in Safari on an added iPhone to install.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {search.enrolled && (
        <p className="flex items-center gap-2 text-sm">
          <CheckIcon className="size-4 text-primary" />
          This iPhone is added. Install the apps below; the first install can take a minute.
        </p>
      )}
      {search.enroll_error && (
        <p className="text-sm text-destructive">
          {ENROLL_ERRORS[search.enroll_error] ?? ENROLL_ERRORS.failed}
        </p>
      )}

      {apps === null ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      ) : apps.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No apps yet. Ask your agent to make one: it reads the instructions at
          /_nap/api/instructions.
        </p>
      ) : (
        apps.map((app) => (
          <Card key={app.slug}>
            <CardHeader>
              <CardTitle>{app.title}</CardTitle>
              <CardDescription>{app.slug}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col divide-y p-0">
              {app.targets.map((target) => (
                <div key={target.target} className="flex items-center gap-3 px-6 py-3">
                  <SmartphoneIcon className="size-5 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {target.live?.name || target.title}
                      </span>
                      {target.live && (
                        <Badge variant="secondary">Build {target.live.buildNumber}</Badge>
                      )}
                    </div>
                    {target.live ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {target.live.notes ||
                          `${target.live.sourceCommit.slice(0, 7)} by ${target.live.by}`}
                        {" · "}
                        {new Date(target.live.createdAt).toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">No build yet</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    disabled={!target.live || installing === `${app.slug}/${target.target}`}
                    onClick={() => install(app.slug, target.target)}
                  >
                    <DownloadIcon data-icon="inline-start" />
                    Install
                  </Button>
                </div>
              ))}
              {app.targets.length === 0 && (
                <p className="px-6 py-3 text-sm text-muted-foreground">No builds yet.</p>
              )}
            </CardContent>
          </Card>
        ))
      )}

      <Card>
        <CardHeader>
          <CardTitle>iPhones</CardTitle>
          <CardDescription>
            Apps only install on iPhones added here. To find an iPhone's UDID, connect it to a Mac
            with a cable, open System Information, and look under USB → iPhone → Serial Number (or
            in Finder, click the text under the iPhone's name until the UDID shows).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {devices && devices.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {devices.map((device) => (
                <li key={device.createdAt} className="flex items-center gap-2">
                  <SmartphoneIcon className="size-4 text-muted-foreground" />
                  {device.name || device.product || "iPhone"}
                  <span className="truncate text-muted-foreground">added by {device.addedBy}</span>
                </li>
              ))}
            </ul>
          )}
          {isIOS && (
            <div className="flex flex-col gap-2">
              <a
                href="/api/devices/profile"
                className={buttonVariants({ className: "self-start" })}
              >
                <SmartphoneIcon data-icon="inline-start" />
                Add this iPhone
              </a>
              <p className="text-xs text-muted-foreground">
                Tap Allow, then open Settings and tap Profile Downloaded to install it. iOS calls
                the profile unverified; that is expected, and nothing stays installed. Away from
                home, iOS may make you wait an hour first; the profile works for a day. Or paste a
                UDID below.
              </p>
            </div>
          )}
          <form onSubmit={addDevice} className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="Name, e.g. Alex's iPhone"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              className="sm:w-48"
            />
            <Input
              placeholder="UDID, e.g. 00008120-001E31091E52201E"
              value={udid}
              onChange={(event) => setUdid(event.target.value)}
              className="font-mono"
              required
            />
            <Button type="submit" disabled={adding || !udid.trim()}>
              <PlusIcon data-icon="inline-start" />
              {adding ? "Adding…" : "Add"}
            </Button>
          </form>
          {adding && (
            <p className="text-xs text-muted-foreground">
              Registering it with Apple and signing the apps again. This can take a minute.
            </p>
          )}
          {added && (
            <p className="flex items-center gap-2 text-sm">
              <CheckIcon className="size-4 text-primary" />
              {added}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
