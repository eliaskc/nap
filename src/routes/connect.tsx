import { createFileRoute } from "@tanstack/react-router";
import { BotIcon, CheckIcon, TriangleAlertIcon } from "lucide-react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";

/**
 * /connect?code=QXRT-KLMB — an agent asks to publish as the signed-in person. Access protects
 * this page, so only people that Access allows can approve.
 */
export const Route = createFileRoute("/connect")({
  validateSearch: (search: Record<string, unknown>): { code?: string } =>
    typeof search.code === "string" ? { code: search.code } : {},
  component: ConnectPage,
});

type DeviceRequest = {
  userCode: string;
  clientName: string;
  requestedFrom: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
};

type State =
  | { kind: "enter" }
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; request: DeviceRequest };

function ConnectPage() {
  const { code } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [state, setState] = React.useState<State>(code ? { kind: "loading" } : { kind: "enter" });
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!code) {
      setState({ kind: "enter" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    void fetch(`/api/connect/${encodeURIComponent(code)}`)
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) return setState({ kind: "missing" });
        const body = (await response.json()) as { request: DeviceRequest };
        setState({ kind: "ready", request: body.request });
      })
      .catch(() => !cancelled && setState({ kind: "missing" }));
    return () => {
      cancelled = true;
    };
  }, [code]);

  async function decide(request: DeviceRequest, action: "approve" | "deny") {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/connect/${encodeURIComponent(request.userCode)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        status?: DeviceRequest["status"];
      };
      if (!response.ok) throw new Error(body.error ?? "Something went wrong");
      setState({ kind: "ready", request: { ...request, status: body.status ?? request.status } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-5 text-foreground">
      <Card className="w-full max-w-md">
        {state.kind === "enter" && (
          <>
            <CardHeader>
              <CardTitle>Connect an agent</CardTitle>
              <CardDescription>Type the code that your agent shows.</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void navigate({ search: { code: typed.trim() } });
                }}
              >
                <Field>
                  <FieldLabel htmlFor="connect-code">Code</FieldLabel>
                  <Input
                    id="connect-code"
                    autoFocus
                    autoComplete="off"
                    placeholder="XXXX-XXXX"
                    className="font-mono uppercase tracking-widest"
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                  />
                </Field>
                <Button type="submit" disabled={!typed.trim()}>
                  Continue
                </Button>
              </form>
            </CardContent>
          </>
        )}

        {state.kind === "loading" && (
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-16" />
            <Skeleton className="h-9" />
          </CardContent>
        )}

        {state.kind === "missing" && (
          <CardHeader>
            <CardTitle>Code not found</CardTitle>
            <CardDescription>
              Check the code, or ask your agent to start the sign-in again.
            </CardDescription>
            <Button
              variant="outline"
              className="mt-2 self-start"
              onClick={() => void navigate({ search: {} })}
            >
              Type a code
            </Button>
          </CardHeader>
        )}

        {state.kind === "ready" && (
          <RequestCard
            request={state.request}
            busy={busy}
            error={error}
            onDecide={(action) => void decide(state.request, action)}
          />
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
  request: DeviceRequest;
  busy: boolean;
  error: string;
  onDecide: (action: "approve" | "deny") => void;
}) {
  if (request.status === "approved") {
    return (
      <CardHeader>
        <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <CheckIcon />
        </div>
        <CardTitle>Agent connected</CardTitle>
        <CardDescription>
          {request.clientName} can now publish as you. Go back to your agent. You can disconnect it
          on the Nap dashboard.
        </CardDescription>
      </CardHeader>
    );
  }
  if (request.status === "denied") {
    return (
      <CardHeader>
        <CardTitle>Request denied</CardTitle>
        <CardDescription>The agent did not get access.</CardDescription>
      </CardHeader>
    );
  }
  if (request.status === "expired") {
    return (
      <CardHeader>
        <CardTitle>Code expired</CardTitle>
        <CardDescription>Codes work for 10 minutes. Ask your agent to start again.</CardDescription>
      </CardHeader>
    );
  }

  return (
    <>
      <CardHeader>
        <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-muted">
          <BotIcon />
        </div>
        <CardTitle>Connect {request.clientName}?</CardTitle>
        <CardDescription>
          The agent can publish new private sites and artifacts as you, and update the ones you own.
          It cannot share, list, or delete anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Field>
          <FieldLabel>Code</FieldLabel>
          <p className="font-mono text-2xl font-semibold tracking-widest">{request.userCode}</p>
          <FieldDescription>
            It must be the same as the code in your agent.
            {request.requestedFrom && ` Requested from ${request.requestedFrom}.`}
          </FieldDescription>
        </Field>

        <p className="flex gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>
            Approve only if you started this sign-in yourself, just now. If someone sent you this
            link, deny it.
          </span>
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" disabled={busy} onClick={() => onDecide("deny")}>
            Deny
          </Button>
          <Button disabled={busy} onClick={() => onDecide("approve")}>
            Approve
          </Button>
        </div>
      </CardContent>
    </>
  );
}
