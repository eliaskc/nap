import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  DownloadIcon,
  ExternalLinkIcon,
  SmartphoneIcon,
  TabletIcon,
} from "lucide-react";
import * as React from "react";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { napConfig } from "~/nap.config";

/**
 * /apps — the native app, one row per platform. The iOS launcher goes to TestFlight, and this
 * page shows Apple processing each build. The reMarkable launcher is installed over USB once and
 * then updates itself.
 */
export const Route = createFileRoute("/apps")({
  component: AppsPage,
});

type Build = {
  id: string;
  buildNumber: number;
  sourceCommit: string;
  notes: string;
  name: string;
  by: string;
  createdAt: string;
  testFlight: { state: "processing" | "ready" | "failed"; error: string | null } | null;
};

type TestFlight = { app: string; target: string; url: string };

/** The TestFlight app on the App Store. */
const TESTFLIGHT_STORE_URL = "https://apps.apple.com/app/testflight/id899247664";
/** While Apple processes a build, the page asks for news this often. */
const PROCESSING_POLL_MS = 5000;

type App = {
  slug: string;
  title: string;
  updatedAt: string;
  targets: Array<{
    target: string;
    platform: string;
    bundleId: string | null;
    title: string;
    live: Build | null;
  }>;
};

function AppsPage() {
  const [apps, setApps] = React.useState<Array<App> | null>(null);
  const [testFlight, setTestFlight] = React.useState<TestFlight | null>(null);
  const [error, setError] = React.useState("");
  const isIOS = React.useMemo(
    () =>
      typeof navigator !== "undefined" &&
      (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)),
    [],
  );

  const loadApps = React.useCallback(() => {
    fetch("/api/apps")
      .then(
        (response) =>
          response.json() as Promise<{ apps: Array<App>; testFlight: TestFlight | null }>,
      )
      .then((data) => {
        setApps(data.apps);
        setTestFlight(data.testFlight);
      })
      .catch(() => setError("Could not load apps."));
  }, []);

  React.useEffect(() => loadApps(), [loadApps]);

  const processing = Boolean(
    apps?.some((app) =>
      app.targets.some((target) => target.live?.testFlight?.state === "processing"),
    ),
  );
  React.useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(loadApps, PROCESSING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [processing, loadApps]);

  const testFlightBuild =
    testFlight &&
    apps
      ?.find((app) => app.slug === testFlight.app)
      ?.targets.find((target) => target.target === testFlight.target)?.live;

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

      {testFlight && (
        <Card>
          <CardHeader>
            <CardTitle>Install from TestFlight</CardTitle>
            <CardDescription>
              Get Apple's TestFlight app, accept the invite email from TestFlight, and install{" "}
              {testFlightBuild?.name || "the app"} there. TestFlight updates it after each publish.
              No invite? Ask {napConfig.admin} to add you as a tester.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {testFlightBuild?.testFlight && (
              <TestFlightStatus
                buildNumber={testFlightBuild.buildNumber}
                status={testFlightBuild.testFlight}
              />
            )}
            <div className="flex flex-wrap gap-2">
              {isIOS ? (
                <a href={testFlight.url} className={buttonVariants()}>
                  <ExternalLinkIcon data-icon="inline-start" />
                  Open in TestFlight
                </a>
              ) : null}
              <a
                href={TESTFLIGHT_STORE_URL}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: isIOS ? "outline" : "default" })}
              >
                <DownloadIcon data-icon="inline-start" />
                Get TestFlight
              </a>
            </div>
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {apps === null ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      ) : apps.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No app yet. Ask your agent to make one: it reads the instructions at
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
                  {target.target === "remarkable" ? (
                    <TabletIcon className="size-5 shrink-0 text-muted-foreground" />
                  ) : (
                    <SmartphoneIcon className="size-5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {target.live?.name || target.title}
                      </span>
                      <Badge variant="outline">{target.platform}</Badge>
                      {target.live && (
                        <Badge variant="secondary">Build {target.live.buildNumber}</Badge>
                      )}
                      {target.live?.testFlight && (
                        <TestFlightBadge state={target.live.testFlight.state} />
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
                    {target.target === "remarkable" && (
                      <span className="text-xs text-muted-foreground">
                        Install on a tablet once over USB (remarkable/scripts/install in the repo);
                        it updates itself after that.
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {app.targets.length === 0 && (
                <p className="px-6 py-3 text-sm text-muted-foreground">No builds yet.</p>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function TestFlightBadge({ state }: { state: "processing" | "ready" | "failed" }) {
  if (state === "processing") {
    return (
      <Badge variant="outline">
        <Spinner data-icon="inline-start" />
        Processing
      </Badge>
    );
  }
  if (state === "failed") return <Badge variant="destructive">TestFlight failed</Badge>;
  return <Badge variant="outline">In TestFlight</Badge>;
}

/** Where the TestFlight launcher's live build is, in words. */
function TestFlightStatus({
  buildNumber,
  status,
}: {
  buildNumber: number;
  status: NonNullable<Build["testFlight"]>;
}) {
  if (status.state === "processing") {
    return (
      <p className="flex items-center gap-2 text-sm">
        <Spinner className="text-muted-foreground" />
        Apple is processing build {buildNumber}. It reaches TestFlight in a few minutes.
      </p>
    );
  }
  if (status.state === "failed") {
    return (
      <p className="flex items-start gap-2 text-sm text-destructive">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
        Build {buildNumber} did not reach TestFlight. {status.error}
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm">
      <CheckIcon className="size-4 text-primary" />
      Build {buildNumber} is in TestFlight.
    </p>
  );
}
