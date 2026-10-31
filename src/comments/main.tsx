import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CommentsApp } from "./app";
import { HistoryApp } from "./history";
import css from "./comments.css?inline";

// Served at /_nap/comments.js. The artifact page (/artifact/<slug>) loads it below the Nap bar:
// <script type="module" src="/_nap/comments.js" data-nap-comments="/artifact/<slug>/_nap/comments"
//   data-nap-versions="/artifact/<slug>/_nap/versions"></script>
// It also has the history button.
const script = document.querySelector<HTMLScriptElement>("script[data-nap-comments]");
const api = script?.dataset.napComments;
const frame = document.querySelector<HTMLIFrameElement>("iframe[data-nap-content]");
const versionsApi = script?.dataset.napVersions;
const slot = document.getElementById("nap-comments-slot");
const historySlot = document.getElementById("nap-history-slot");
const stage = frame?.parentElement;

if (api && frame && slot && stage) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // React renders here, and popovers portal here. The app sets its theme from the artifact.
  const layer = document.createElement("div");
  layer.className = "font-sans";
  document.body.appendChild(layer);
  createRoot(layer).render(
    <StrictMode>
      <CommentsApp api={api} frame={frame} slot={slot} stage={stage} layer={layer} />
      {versionsApi && historySlot && (
        <HistoryApp
          api={versionsApi}
          frame={frame}
          slot={historySlot}
          stage={stage}
          layer={layer}
        />
      )}
    </StrictMode>,
  );
}
