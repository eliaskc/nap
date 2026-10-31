import { createFileRoute, notFound } from "@tanstack/react-router";
import * as React from "react";

/**
 * Dev only: /dev/claim uploads a sample draft and opens its claim page.
 * Query params go to /_nap/drafts, for example /dev/claim?slug=demo&title=Demo.
 */
export const Route = createFileRoute("/dev/claim")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: DevClaim,
});

function DevClaim() {
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("title")) params.set("title", "Sample draft");
    void (async () => {
      const response = await fetch(`/_nap/drafts?${params}`, {
        method: "POST",
        headers: { "content-type": "text/html" },
        body: SAMPLE_HTML,
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok || !body.id)
        throw new Error(body.error ?? `Upload failed (${response.status})`);
      window.location.replace(`/claim/${body.id}`);
    })().catch((uploadError: unknown) =>
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError)),
    );
  }, []);

  return (
    <main className="flex min-h-dvh items-center justify-center p-8 text-sm text-muted-foreground">
      {error ? <p className="text-destructive">{error}</p> : <p>Uploading sample draft…</p>}
    </main>
  );
}

const SAMPLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sample draft</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; color: #1a1a2e; background: linear-gradient(135deg, #e0e7ff, #fdf2f8); min-height: 100vh; }
  header { padding: 4rem 2rem 2rem; max-width: 60rem; margin: 0 auto; }
  h1 { font-size: clamp(2rem, 5vw, 3.5rem); margin: 0 0 1rem; }
  p { font-size: 1.125rem; line-height: 1.6; max-width: 40rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; padding: 0 2rem 4rem; max-width: 60rem; margin: 0 auto; }
  .card { background: white; border-radius: 1rem; padding: 1.5rem; box-shadow: 0 1px 3px rgb(0 0 0 / 0.1); }
</style>
</head>
<body>
<header>
  <h1>Sample draft</h1>
  <p>This page is a local test draft from /dev/claim. Use it to check the claim page layout.</p>
</header>
<section class="grid">
  ${Array.from({ length: 9 }, (_, i) => `<div class="card"><h3>Card ${i + 1}</h3><p>Placeholder content.</p></div>`).join("\n  ")}
</section>
</body>
</html>`;
