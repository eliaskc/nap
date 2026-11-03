import { SHARE_WIDGET_VERSION } from "~/lib/share-widget";

/**
 * The Nap bar: the title, the owner, and Share, with the page in an iframe below it. The bar
 * pushes the content down, so `100vh` and fixed elements work inside the frame.
 *
 * Sites with the toolbar on: a top-level visit to <slug>.<root> gets this page, and the iframe
 * loads the same URL from the same host. The Worker tells the two requests apart with
 * `Sec-Fetch-Dest`: `document` gets this page, `iframe` (and everything else) gets the files. One
 * host means one Access cookie, and the toolbar script can read the frame's address.
 *
 * Artifacts (`artifact` set): this page is <root>/artifact/<slug>. The iframe is sandboxed, with
 * an opaque origin, and loads the files from <root>/_nap/frame/<token>/. The frame tells this page
 * its address with postMessage (see artifact-viewer.ts).
 */
export function toolbarPage(options: {
  title: string;
  owner: string;
  updatedAt: string;
  isOwner: boolean;
  frameSrc: string;
  accessPath: string;
  dashboardUrl: string;
  /** Artifact viewer: the sandbox flags, the page URL that frame paths map to, and comments. */
  artifact?: { sandbox: string; base: string; commentsPath: string; versionsPath: string };
}) {
  const { title, owner, artifact } = options;
  const frame = artifact
    ? `<iframe data-nap-content data-src="${attr(options.frameSrc)}" data-base="${attr(artifact.base)}"
      sandbox="${attr(artifact.sandbox)}" title="${attr(title)}"
      allow="clipboard-read *; clipboard-write *; fullscreen *; autoplay *; camera *; microphone *; geolocation *; web-share *"
      allowfullscreen></iframe>
    <script src="/_nap/viewer.js?v=${VIEWER_SCRIPT_VERSION}" defer></script>
    <script type="module" src="/_nap/comments.js" data-nap-comments="${attr(artifact.commentsPath)}" data-nap-versions="${attr(artifact.versionsPath)}"></script>`
    : `<iframe data-nap-content src="${attr(options.frameSrc)}" title="${attr(title)}"
      allow="clipboard-read; clipboard-write; fullscreen; autoplay; camera; microphone; geolocation; web-share"
      allowfullscreen></iframe>
    <script src="/_nap/toolbar.js?v=${TOOLBAR_SCRIPT_VERSION}" defer></script>`;
  const body = `
    <header>
      <a class="home" href="${attr(options.dashboardUrl)}" title="Nap" aria-label="Go to Nap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      </a>
      <h1 title="${attr(`${title} · ${owner} · updated ${formatDate(options.updatedAt)}`)}">
        ${text(title)}<span class="owner"> · ${text(owner)}</span>
      </h1>
      <div class="actions"><span id="nap-history-slot"></span><span id="nap-comments-slot"></span><span id="nap-share-slot"></span></div>
    </header>
    <main>${frame}</main>
    ${
      options.isOwner
        ? `<script src="/_nap/share.js?v=${SHARE_WIDGET_VERSION}" data-access="${attr(options.accessPath)}" data-mount="#nap-share-slot" defer></script>`
        : ""
    }`;

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text(title)}</title>
<style>
  :root { color-scheme: light dark; --nap-bg: #fff; --nap-fg: #18181b; --nap-muted: #71717a; --nap-line: #e4e4e7; --nap-hover: #f4f4f5; }
  @media (prefers-color-scheme: dark) { :root { --nap-bg: #18181b; --nap-fg: #fafafa; --nap-muted: #a1a1aa; --nap-line: #3f3f46; --nap-hover: #27272a; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: var(--nap-bg); color: var(--nap-fg); font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 6px; border-bottom: 1px solid var(--nap-line); flex-shrink: 0; }
  .home { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px; color: var(--nap-muted); }
  .home:hover { color: var(--nap-fg); background: var(--nap-hover); }
  .home svg { width: 16px; height: 16px; }
  h1 { flex: 1; min-width: 0; margin: 0; font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  h1 .owner { color: var(--nap-muted); font-weight: 400; }
  .actions, .actions > span { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  main { position: relative; display: flex; flex: 1; min-height: 0; }
  iframe { flex: 1; width: 100%; min-width: 0; border: 0; background: #fff; }
  @media (max-width: 480px) { h1 .owner { display: none; } }
  @media print { header { display: none; } }
</style>
</head>
<body>${body}</body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        vary: "sec-fetch-dest",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "content-security-policy": [
          "default-src 'none'",
          "style-src 'unsafe-inline'",
          "script-src 'self'",
          "connect-src 'self'",
          "frame-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; "),
      },
    },
  );
}

// Keeps the address bar and the tab title in step with the framed page, so links and reloads
// keep the current path. Keep this source free of backticks and "${".
const TOOLBAR_SOURCE = String.raw`(() => {
  const frame = document.querySelector("iframe[data-nap-content]");
  if (!frame) return;
  const baseTitle = document.title;
  let first = true;

  function sync() {
    try {
      const inner = frame.contentWindow.location;
      const next = inner.pathname + inner.search + inner.hash;
      if (inner.origin === location.origin && next !== location.pathname + location.search + location.hash) {
        history.replaceState(null, "", next);
      }
      const title = frame.contentDocument && frame.contentDocument.title;
      document.title = title || baseTitle;
    } catch (error) {
      // The frame left this origin. Keep the last address.
    }
  }

  function watch() {
    try {
      const win = frame.contentWindow;
      ["pushState", "replaceState"].forEach((name) => {
        const original = win.history[name];
        win.history[name] = function () {
          const result = original.apply(this, arguments);
          sync();
          return result;
        };
      });
      win.addEventListener("popstate", sync);
      win.addEventListener("hashchange", sync);
      const head = frame.contentDocument && frame.contentDocument.querySelector("title");
      if (head) new MutationObserver(sync).observe(head, { childList: true, characterData: true, subtree: true });
    } catch (error) {
      // Other origin.
    }
  }

  frame.addEventListener("load", () => {
    // The server never sees the hash. Give it to the page on the first load.
    if (first && location.hash) {
      try {
        if (!frame.contentWindow.location.hash) frame.contentWindow.location.hash = location.hash;
      } catch (error) {
        // Other origin.
      }
    }
    first = false;
    watch();
    sync();
  });
})();`;

export const TOOLBAR_SCRIPT_VERSION = (() => {
  let hash = 5381;
  for (let index = 0; index < TOOLBAR_SOURCE.length; index++) {
    hash = ((hash << 5) + hash + TOOLBAR_SOURCE.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
})();

export function serveToolbarScript() {
  return new Response(TOOLBAR_SOURCE, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

// The artifact viewer. It starts the sandboxed frame (with the hash, which the server never
// sees) and keeps the address bar and the tab title in step with the frame's messages. The frame
// has an opaque origin, so this page cannot read its location.
//
// It also keeps the frame token alive while the page is open, so a dashboard on a TV keeps its
// data. Renewing goes through this page, which Access protects, so someone Access no longer lets
// in loses the frame when the token runs out. A token that already ran out (a laptop that slept)
// reloads the page for a new one. Keep this source free of backticks and "${".
const VIEWER_SOURCE = String.raw`(() => {
  const frame = document.querySelector("iframe[data-nap-content]");
  if (!frame) return;
  const base = frame.dataset.base;
  const baseTitle = document.title;
  frame.src = frame.dataset.src + location.hash;

  const token = (frame.dataset.src.match(/^\/_nap\/frame\/([A-Za-z0-9_-]+)\//) || [])[1];
  let lastRenew = Date.now();
  async function renew() {
    if (!token || Date.now() - lastRenew < 30 * 60 * 1000) return;
    lastRenew = Date.now();
    try {
      const response = await fetch(base + "/_nap/frame", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token }),
      });
      if (response.status === 404) location.reload();
    } catch (error) {
      // Offline, or Access wants a new login. The next try or a reload sorts it out.
    }
  }
  setInterval(renew, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") renew();
  });

  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.type !== "nap:location" || typeof data.path !== "string") return;
    if (data.path.charAt(0) !== "/" || data.path.charAt(1) === "/") return;
    // "/" and "/?q" belong to the artifact page itself: /artifact/<slug> and /artifact/<slug>?q.
    const rest = /^\/([?#]|$)/.test(data.path) ? data.path.slice(1) : data.path;
    const next = base + rest;
    if (next !== location.pathname + location.search + location.hash) {
      history.replaceState(null, "", next);
    }
    const title = typeof data.title === "string" ? data.title.trim() : "";
    document.title = title || baseTitle;
  });
})();`;

export const VIEWER_SCRIPT_VERSION = (() => {
  let hash = 5381;
  for (let index = 0; index < VIEWER_SOURCE.length; index++) {
    hash = ((hash << 5) + hash + VIEWER_SOURCE.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
})();

export function serveViewerScript() {
  return new Response(VIEWER_SOURCE, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function text(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attr(value: string) {
  return text(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
