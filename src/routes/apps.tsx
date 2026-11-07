import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /apps: Get the app lives on the dashboard, in a sheet. This link opens the dashboard with it open
 * (#app), so "get the app at the Nap's address" is all anyone needs to hear.
 */
export const Route = createFileRoute("/apps")({
  beforeLoad: () => {
    throw redirect({ to: "/", hash: "app", replace: true });
  },
});
