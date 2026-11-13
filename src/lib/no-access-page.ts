import type { VisitorRequestState } from "~/lib/access-requests";
import type { Visibility } from "~/lib/site-access";

/**
 * The page someone gets when they open a site or artifact that is not shared with them. It says
 * whose it is and what to do: ask the owner for access (with access requests on, a button that
 * tells the owner), or ask them to share it. It shows which account they are signed in with, in
 * case they meant another one. /_nap/access.js polls `<accessPath>/status` and reloads the page
 * once they are let in or the request is answered.
 */
export function noAccessPage(options: {
  kind: "site" | "artifact";
  title: string;
  visibility: Visibility;
  ownerName: string | null;
  ownerEmail: string;
  viewerEmail: string;
  dashboardUrl: string;
  /** Signs out of Cloudflare Access. Unset locally, where there is no Access. */
  signOutUrl?: string;
  /** Where this person's request stands. */
  request: VisitorRequestState;
  /** The nap's /_nap/access path on this origin; requests and status are below it. */
  accessPath: string;
  /** This page's path and query, where the request form comes back to. */
  back: string;
}) {
  const owner = options.ownerName?.trim() || options.ownerEmail;
  const firstName = options.ownerName?.trim().split(/\s+/)[0] || options.ownerEmail;
  const what = options.kind === "artifact" ? "artifact" : "site";
  const request = options.request;

  const lead =
    request.state === "pending"
      ? "Request sent"
      : request.state === "denied"
        ? `${firstName} turned down your request`
        : options.visibility === "private"
          ? `Only ${owner} can open it right now.`
          : `${owner} has shared it with a few people, and you are not one of them yet.`;
  const title =
    request.state === "pending" ? `Waiting for ${firstName}` : `This ${what} isn’t shared with you`;

  const button = (label: string) => `
  <form method="post" action="${attr(`${options.accessPath}/request`)}">
    <input type="hidden" name="back" value="${attr(options.back)}">
    <button type="submit">${text(label)}</button>
  </form>`;

  let body: string;
  if (request.state === "off") {
    body = `<p class="how">Ask ${text(firstName)}, or whoever sent you the link, to add you from the Share menu. This page opens the ${what} by itself once they have.</p>`;
  } else if (request.state === "pending") {
    body = request.notified
      ? `<p class="how"><span class="dot" aria-hidden="true"></span>${text(firstName)} got a message on ${text(request.channel)}. Keep this page open: it opens the ${what} as soon as they let you in.</p>`
      : `<p class="how">Nap couldn’t reach ${text(firstName)} on ${text(request.channel)}. Ask them yourself to add you from the Share menu. This page opens the ${what} by itself once they have.</p>`;
  } else if (request.state === "denied") {
    body = request.canRequest
      ? `<p class="how">If you think that was a mistake, ask again or talk to ${text(firstName)}.</p>${button("Ask again")}`
      : `<p class="how">You can ask again tomorrow, or talk to ${text(firstName)}.</p>`;
  } else {
    body = request.canRequest
      ? `<p class="how">Ask ${text(firstName)} for access, and Nap sends them a message on ${text(request.channel)}. This page opens the ${what} as soon as they let you in.</p>${button("Request access")}`
      : `<p class="how">You asked today. You can ask again tomorrow, or ask ${text(firstName)} to add you from the Share menu.</p>`;
  }

  const account = options.viewerEmail
    ? `<p class="account">Signed in as <strong>${text(options.viewerEmail)}</strong>${
        options.signOutUrl ? ` · <a href="${attr(options.signOutUrl)}">Use another account</a>` : ""
      } · <a href="${attr(options.dashboardUrl)}">Nap</a></p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<noscript><meta http-equiv="refresh" content="30"></noscript>
<title>No access · Nap</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --card: #fff; --fg: #18181b; --muted: #71717a; --line: #e4e4e7; --soft: #f4f4f5; --primary: #18181b; --on-primary: #fafafa; --ok: #16a34a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111113; --card: #18181b; --fg: #fafafa; --muted: #a1a1aa; --line: #2e2e33; --soft: #27272a; --primary: #fafafa; --on-primary: #18181b; --ok: #4ade80; } }
  * { box-sizing: border-box; }
  body { display: grid; min-height: 100vh; margin: 0; padding: 24px; place-items: center; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 26rem; padding: 32px 28px 24px; border: 1px solid var(--line); border-radius: 16px; background: var(--card); box-shadow: 0 1px 2px rgb(0 0 0 / .04), 0 8px 24px rgb(0 0 0 / .04); text-align: center; }
  .icon { display: inline-grid; width: 48px; height: 48px; margin-bottom: 16px; place-items: center; border-radius: 999px; background: var(--soft); color: var(--muted); }
  .icon svg { width: 22px; height: 22px; }
  h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; letter-spacing: -.01em; }
  .lead { margin: 0; color: var(--muted); }
  .nap { display: flex; align-items: center; gap: 12px; margin: 20px 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; text-align: left; }
  .avatar { display: grid; flex-shrink: 0; width: 36px; height: 36px; place-items: center; border-radius: 999px; background: var(--soft); font-weight: 600; text-transform: uppercase; }
  .nap div { min-width: 0; }
  .nap strong, .nap span { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .nap strong { font-weight: 500; }
  .nap span { color: var(--muted); font-size: 13px; }
  .how { margin: 0; }
  .dot { display: inline-block; width: 8px; height: 8px; margin-right: 8px; border-radius: 999px; background: var(--ok); vertical-align: 1px; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  form { margin: 20px 0 0; }
  button { width: 100%; height: 38px; padding: 0 16px; border: 1px solid var(--primary); border-radius: 10px; background: var(--primary); color: var(--on-primary); font: inherit; font-weight: 500; cursor: pointer; }
  button:hover { opacity: .9; }
  button:disabled { opacity: .6; cursor: default; }
  .account { margin: 20px 0 0; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .account strong { color: var(--fg); font-weight: 500; }
  .account a { color: inherit; }
</style>
</head>
<body>
<main>
  <div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
  <h1>${text(title)}</h1>
  <p class="lead">${text(lead)}</p>
  <div class="nap">
    <div class="avatar" aria-hidden="true">${text(owner.charAt(0))}</div>
    <div><strong>${text(options.title)}</strong><span>${text(owner)}${
      options.ownerName ? ` · ${text(options.ownerEmail)}` : ""
    }</span></div>
  </div>
  ${body}
  ${account}
</main>
<script src="/_nap/access.js?v=${ACCESS_SCRIPT_VERSION}" data-status="${attr(`${options.accessPath}/status`)}" data-state="${attr(request.state)}" defer></script>
</body>
</html>`;
}

/** Headers for the page: HTML, never cached, only Nap's own script, never framed. */
export const noAccessHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// Served at /_nap/access.js. Asks every few seconds whether the person may open the nap now, and
// reloads the page once they may or the request was answered. Quiet while the tab is hidden; asks
// right away when it comes back. Keep this source free of backticks and "${".
const ACCESS_SOURCE = String.raw`(() => {
  const script = document.currentScript;
  const statusUrl = script && script.dataset.status;
  const shown = script && script.dataset.state;
  if (!statusUrl) return;
  let timer = 0;

  for (const form of document.querySelectorAll("form")) {
    form.addEventListener("submit", () => {
      const button = form.querySelector("button");
      if (button) button.disabled = true;
    });
  }

  async function check() {
    clearTimeout(timer);
    if (document.hidden) return;
    try {
      const response = await fetch(statusUrl, { headers: { accept: "application/json" }, cache: "no-store" });
      if (response.ok) {
        const body = await response.json();
        if (body.allowed || body.state !== shown) return location.reload();
      }
    } catch (error) {
      // Offline for a moment. Try again later.
    }
    timer = setTimeout(check, 5000);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) check();
  });
  timer = setTimeout(check, 5000);
})();`;

const ACCESS_SCRIPT_VERSION = hash(ACCESS_SOURCE);

export function serveAccessScript() {
  return new Response(ACCESS_SOURCE, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

function hash(value: string) {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function text(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attr(value: string) {
  return text(value).replace(/'/g, "&#39;");
}
