import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { NapMark } from "~/dashboard/chrome";
import { GroupButton } from "~/dashboard/controls";
import { AppIcon, InstallPanel, InstallProvider, TESTFLIGHT_ENABLED } from "~/dashboard/install";
import { napConfig } from "~/nap.config";

/**
 * /app: Get the app as a page of its own, to send to people. The same flow as the dashboard's
 * popover: the Apple Account email, Apple's invites, then a QR code (or Open in TestFlight on an
 * iPhone).
 */
export const Route = createFileRoute("/app")({
  component: AppPage,
  head: () => ({ meta: [{ title: "Nap for iPhone · Nap" }] }),
});

function AppPage() {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-clip">
      <div className="nap-dot-field" />
      <header className="relative z-10 flex h-15 items-center px-4 sm:px-5">
        <div data-flat className="flex items-center gap-1 text-foreground">
          <GroupButton
            icon
            nativeButton={false}
            render={<a href="/" />}
            aria-label="Back to Nap"
            title="Back to Nap"
          >
            <ArrowLeftIcon />
          </GroupButton>
          <NapMark />
        </div>
      </header>
      <main className="relative z-10 mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-6 px-4 pt-6 pb-16 sm:justify-center sm:pt-0 sm:pb-24">
        <div className="flex flex-col items-center gap-4 text-center">
          <AppIcon className="size-24 shadow-lg sm:size-28" />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-3xl leading-tight font-semibold tracking-[-0.03em] sm:text-4xl">
              Nap for iPhone
            </h1>
            <p className="text-balance text-muted-foreground">
              Open the apps you make on {napConfig.orgName}'s Nap, on your phone. It comes from
              Apple's TestFlight.
            </p>
          </div>
        </div>
        {TESTFLIGHT_ENABLED ? (
          <InstallProvider page>
            <div className="w-full rounded-2xl border bg-card text-card-foreground shadow-lg">
              <InstallPanel page className="gap-5 p-5 sm:p-6" />
            </div>
          </InstallProvider>
        ) : (
          <p className="rounded-2xl border bg-card p-5 text-center text-sm text-muted-foreground">
            This Nap has no iPhone app.
          </p>
        )}
      </main>
    </div>
  );
}
