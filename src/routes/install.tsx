import { createFileRoute, redirect } from "@tanstack/react-router";

/** /install is easy to guess too; the page is /app. */
export const Route = createFileRoute("/install")({
  beforeLoad: () => {
    throw redirect({ to: "/app", replace: true });
  },
});
