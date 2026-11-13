import { createFileRoute } from "@tanstack/react-router";
import { CheckIcon, GlobeIcon, LockIcon, UserPlusIcon, XIcon } from "lucide-react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { EVERYONE_LABEL } from "~/lib/deployment-text";

/**
 * /requests/<id>: someone asks the owner for access to a nap. Channels (such as Slack) link here,
 * and the owner answers: invite them, share with everyone, or deny. Access protects this page,
 * and the API answers only the nap's owner.
 */
export const Route = createFileRoute("/requests/$id")({
  component: RequestPage,
});

type Decision = "add" | "everyone" | "deny";

type AccessRequest = {
  id: string;
  kind: "site" | "artifact";
  title: string;
  visibility: "everyone" | "private" | "selected";
  requesterEmail: string;
  requesterName: string | null;
  status: "pending" | "approved" | "denied";
  decision: Decision | null;
  createdAt: string;
  napUrl: string;
};

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; request: AccessRequest };

function RequestPage() {
  const { id } = Route.useParams();
  const [state, setState] = React.useState<State>({ kind: "loading" });
  const [busy, setBusy] = React.useState<Decision | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void fetch(`/api/access-requests/${encodeURIComponent(id)}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          request?: AccessRequest;
          error?: string;
        };
        if (cancelled) return;
        if (!response.ok || !body.request) {
          return setState({ kind: "error", message: body.error ?? "Request not found" });
        }
        setState({ kind: "ready", request: body.request });
      })
      .catch(() => !cancelled && setState({ kind: "error", message: "Something went wrong" }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function decide(decision: Decision) {
    setBusy(decision);
    setError("");
    try {
      const response = await fetch(`/api/access-requests/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        request?: AccessRequest;
        error?: string;
      };
      if (!response.ok || !body.request) throw new Error(body.error ?? "Something went wrong");
      setState({ kind: "ready", request: body.request });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-5 text-foreground">
      <Card className="w-full max-w-md">
        {state.kind === "loading" && (
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-16" />
            <Skeleton className="h-9" />
          </CardContent>
        )}
        {state.kind === "error" && (
          <CardHeader>
            <CardTitle>Can’t show this request</CardTitle>
            <CardDescription>{state.message}</CardDescription>
          </CardHeader>
        )}
        {state.kind === "ready" && (
          <RequestCard request={state.request} busy={busy} error={error} onDecide={decide} />
        )}
      </Card>
    </main>
  );
}

function RequestCard({
  request,
  busy,
  error,
  onDecide,
}: {
  request: AccessRequest;
  busy: Decision | null;
  error: string;
  onDecide: (decision: Decision) => void;
}) {
  const name = request.requesterName?.trim() || request.requesterEmail;
  const first = request.requesterName?.trim().split(/\s+/)[0] || request.requesterEmail;
  const what = request.kind === "artifact" ? "artifact" : "site";
  const napLink = (
    <a
      className="font-medium text-foreground underline-offset-4 hover:underline"
      href={request.napUrl}
    >
      {request.title}
    </a>
  );

  if (request.status !== "pending") {
    return (
      <CardHeader>
        <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-muted">
          {request.status === "approved" ? <CheckIcon /> : <XIcon />}
        </div>
        <CardTitle>
          {request.decision === "add" && `${first} can open it now`}
          {request.decision === "everyone" && `Shared with ${EVERYONE_LABEL.toLowerCase()}`}
          {request.decision === "deny" && "Request turned down"}
        </CardTitle>
        <CardDescription>
          {request.decision === "deny" ? (
            <>
              {name} can’t open {napLink}. They can ask again tomorrow.
            </>
          ) : (
            <>
              {name} can open {napLink}. If they still have it open, it loads by itself.
            </>
          )}
        </CardDescription>
      </CardHeader>
    );
  }

  return (
    <>
      <CardHeader>
        <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-muted">
          <LockIcon />
        </div>
        <CardTitle>{first} asks for access</CardTitle>
        <CardDescription>
          {name}
          {request.requesterName ? ` (${request.requesterEmail})` : ""} wants to open your {what}{" "}
          {napLink}.{" "}
          {request.visibility === "private"
            ? "Only you can open it right now."
            : "It’s shared with a few people right now."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button disabled={busy !== null} onClick={() => onDecide("add")}>
          <UserPlusIcon data-icon="inline-start" />
          Add {first}
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={() => onDecide("everyone")}>
          <GlobeIcon data-icon="inline-start" />
          Share with {EVERYONE_LABEL.toLowerCase()}
        </Button>
        <Button variant="ghost" disabled={busy !== null} onClick={() => onDecide("deny")}>
          Deny
        </Button>
      </CardContent>
    </>
  );
}
