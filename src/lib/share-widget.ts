import { EVERYONE_LABEL } from "~/lib/deployment-text";

// Served at /_nap/share.js. Sites without the Nap toolbar opt in with
// <script src="/_nap/share.js" defer></script>. The toolbar loads it with data-mount.
// It shows a Share button only to the owner. Everyone else sees nothing.
// It matches the dashboard share dialog: "Only people invited" or "Everyone at <org>".
// Keep this source free of backticks and "${": it lives inside String.raw.
const SHARE_SOURCE = String.raw`(() => {
  if (window.__napShare) return;
  window.__napShare = true;
  // Inside a frame (the Nap toolbar, the claim preview), the outer page owns sharing.
  if (window.self !== window.top) return;

  const script = document.currentScript;
  const data = (script && script.dataset) || {};
  const positions = ["bottom-right", "bottom-left", "top-right", "top-left"];
  const position = positions.includes(data.position) ? data.position : "bottom-right";
  const accessOverride = data.access || "";
  // data-mount="#id" renders the button inline in that element (for example a page header).
  const mountSelector = data.mount || "";

  const GENERAL = [
    { value: "invited", label: "Only people invited", icon: "lock" },
    { value: "everyone", label: __NAP_EVERYONE__, icon: "globe" },
  ];

  const ICONS = {
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  };

  const STYLE = [
    ":host { all: initial; }",
    ".root { position: fixed; z-index: 2147483000; font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--fg);",
    "  --bg: #fff; --fg: #18181b; --muted: #71717a; --line: #e4e4e7; --hover: #f4f4f5; --soft: #f4f4f5; --danger: #dc2626; --warn: #d97706; }",
    "@media (prefers-color-scheme: dark) { .root { --bg: #18181b; --fg: #fafafa; --muted: #a1a1aa; --line: #3f3f46; --hover: #27272a; --soft: #27272a; --danger: #f87171; --warn: #fbbf24; } }",
    ".bottom-right { right: 16px; bottom: 16px; } .bottom-left { left: 16px; bottom: 16px; }",
    ".top-right { right: 16px; top: 16px; } .top-left { left: 16px; top: 16px; }",
    ".root.inline { position: relative; }",
    ".inline .trigger { height: 28px; padding: 0 10px 0 8px; border-radius: 7px; box-shadow: none; }",
    "button, input, select { font: inherit; color: inherit; margin: 0; }",
    "button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #3b82f6; outline-offset: 1px; }",
    "[hidden] { display: none !important; }",
    ".trigger { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px 0 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg); cursor: pointer; font-weight: 500; box-shadow: 0 1px 2px rgb(0 0 0 / .06), 0 4px 14px rgb(0 0 0 / .08); }",
    ".trigger:hover { background: var(--hover); }",
    ".panel { position: absolute; display: flex; flex-direction: column; gap: 10px; width: min(340px, calc(100vw - 32px)); max-height: calc(100vh - 80px); overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 12px; padding: 12px; box-sizing: border-box; box-shadow: 0 10px 38px rgb(0 0 0 / .14), 0 2px 8px rgb(0 0 0 / .06); }",
    ".bottom-right .panel { right: 0; bottom: 40px; } .bottom-left .panel { left: 0; bottom: 40px; }",
    ".top-right .panel { right: 0; top: 40px; } .top-left .panel { left: 0; top: 40px; }",
    ".inline .panel { right: 0; top: 34px; }",
    ".heading { font-size: 14px; font-weight: 600; }",
    ".select { position: relative; display: flex; align-items: center; }",
    ".select .icon { position: absolute; pointer-events: none; color: var(--muted); }",
    ".select .lead { left: 10px; } .select .tail { right: 8px; }",
    "select { appearance: none; width: 100%; height: 34px; padding: 0 30px 0 34px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); cursor: pointer; }",
    "input { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; box-sizing: border-box; }",
    "input::-webkit-search-cancel-button { display: none; }",
    ".invited { display: flex; flex-direction: column; gap: 6px; }",
    ".suggestions { display: flex; flex-direction: column; gap: 1px; padding: 4px; border: 1px solid var(--line); border-radius: 8px; }",
    ".suggestion { display: flex; align-items: center; gap: 10px; width: 100%; padding: 5px 6px; border: 0; border-radius: 6px; background: none; text-align: left; cursor: pointer; }",
    ".suggestion[aria-selected='true'] { background: var(--hover); }",
    ".suggestion .hint { display: none; flex-shrink: 0; font-size: 12px; color: var(--muted); }",
    ".suggestion[aria-selected='true'] .hint { display: inline; }",
    ".empty { padding: 6px; color: var(--muted); }",
    ".people { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }",
    ".person { display: flex; flex-direction: column; gap: 2px; padding: 3px 0; }",
    ".person-row { display: flex; align-items: center; gap: 10px; min-height: 32px; }",
    ".avatar { display: flex; flex-shrink: 0; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 999px; background: var(--soft); font-size: 12px; font-weight: 500; text-transform: uppercase; }",
    ".avatar.unknown { background: none; border: 1px dashed var(--line); color: var(--muted); box-sizing: border-box; }",
    ".who { display: flex; flex: 1; flex-direction: column; min-width: 0; }",
    ".who span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".sub, .muted { color: var(--muted); } .sub { font-size: 12px; }",
    ".role { padding-right: 6px; font-size: 12px; color: var(--muted); }",
    ".warning { display: flex; align-items: flex-start; gap: 6px; padding-left: 38px; font-size: 12px; color: var(--warn); }",
    ".warning .icon svg { width: 13px; height: 13px; margin-top: 2px; }",
    ".icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; border-radius: 6px; background: none; cursor: pointer; color: var(--muted); }",
    ".icon-btn:hover { color: var(--fg); background: var(--hover); }",
    ".footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 10px; border-top: 1px solid var(--line); }",
    ".link-btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); cursor: pointer; font-weight: 500; }",
    ".link-btn:hover { background: var(--hover); }",
    ".status { font-size: 12px; color: var(--muted); } .status.error { color: var(--danger); }",
    ".icon { display: inline-flex; flex-shrink: 0; } .icon svg { width: 16px; height: 16px; }",
    ".icon-btn .icon svg { width: 14px; height: 14px; }",
    "@media print { .root { display: none; } }",
  ].join("\n");

  function napPath(suffix) {
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (!local) return "/_nap/" + suffix;
    const match = location.pathname.match(/^\/s\/([^/]+)(?:\/|$)/);
    return match ? "/s/" + encodeURIComponent(match[1]) + "/_nap/" + suffix : null;
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([key, value]) => {
      if (value == null || value === false) return;
      if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    });
    (children || []).forEach((child) => child && node.append(child));
    return node;
  }

  function icon(name, extra) {
    const span = el("span", { class: "icon" + (extra ? " " + extra : ""), "aria-hidden": "true" });
    span.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      ICONS[name] +
      "</svg>";
    return span;
  }

  function avatar(label, unknown) {
    return el("span", { class: "avatar" + (unknown ? " unknown" : ""), "aria-hidden": "true", text: (label || "?").charAt(0) });
  }

  function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  async function start() {
    const path = /^\/[^/]/.test(accessOverride) ? accessOverride : napPath("access");
    if (!path) return;
    const response = await fetch(path, { headers: { accept: "application/json" } }).catch(() => null);
    if (!response || !response.ok) return;
    const body = await response.json().catch(() => null);
    if (!body || !body.canManage) return;
    mount(path, body);
  }

  function mount(path, initial) {
    const me = initial.me || null;
    const people = Array.isArray(initial.people) ? initial.people : [];
    const names = new Map(people.map((person) => [person.email, person.name]));
    const domain = me ? me.email.slice(me.email.lastIndexOf("@") + 1) : null;
    let current = { visibility: initial.visibility, emails: (initial.viewerEmails || []).slice() };
    let open = false;
    let status = null;
    let options = [];
    let highlighted = 0;
    let queue = Promise.resolve();

    const host = document.createElement("div");
    host.setAttribute("data-nap-share", "");
    const shadow = host.attachShadow({ mode: "closed" });
    const mountPoint = mountSelector ? document.querySelector(mountSelector) : null;
    const root = el("div", { class: "root " + (mountPoint ? "inline" : position) });
    shadow.append(el("style", { text: STYLE }), root);

    const trigger = el("button", {
      class: "trigger",
      type: "button",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      onclick: () => setOpen(!open),
    });
    const select = el(
      "select",
      { "aria-label": "General access", onchange: () => changeGeneral(select.value) },
      GENERAL.map((item) => el("option", { value: item.value, text: item.label })),
    );
    const leadIcon = el("span", { class: "icon lead" });
    const input = el("input", {
      // Not the user's own address: keep browser autofill and password managers away.
      type: "search",
      inputmode: "email",
      name: "share-with",
      enterkeyhint: "done",
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "off",
      spellcheck: "false",
      "data-1p-ignore": true,
      "data-lpignore": "true",
      "data-bwignore": true,
      "data-form-type": "other",
      "aria-label": "Add a person",
      "aria-autocomplete": "list",
      placeholder: "Search for people to invite…",
      oninput: () => {
        highlighted = 0;
        renderSuggestions();
      },
      onkeydown: onKey,
    });
    const suggestions = el("div", { class: "suggestions", role: "listbox", hidden: true });
    const list = el("ul", { class: "people" });
    const invited = el("div", { class: "invited" }, [input, suggestions, list]);
    const statusLine = el("span", { class: "status", role: "status", "aria-live": "polite" });
    const panel = el("div", { class: "panel", role: "dialog", "aria-label": "Share", hidden: true }, [
      el("div", { class: "heading", text: "Who can view" }),
      el("div", { class: "select" }, [leadIcon, select, icon("chevron", "tail")]),
      invited,
      el("div", { class: "footer" }, [
        el("button", { class: "link-btn", type: "button", onclick: copyLink }, [
          icon("link"),
          el("span", { text: "Copy link" }),
        ]),
        statusLine,
      ]),
    ]);
    root.append(trigger, panel);
    (mountPoint || document.body).append(host);

    function setOpen(next) {
      open = next;
      if (!open) {
        input.value = "";
        status = null;
      }
      render();
    }

    function changeGeneral(value) {
      commit(
        value === "everyone"
          ? { visibility: "everyone", emails: current.emails }
          : { visibility: current.emails.length ? "selected" : "private", emails: current.emails },
      );
    }

    function setEmails(emails) {
      commit({ visibility: emails.length ? "selected" : "private", emails });
    }

    /** Saves each change at once. Requests run in order, so the last change wins. */
    function commit(next) {
      const previous = current;
      current = next;
      status = { text: "Saving…" };
      render();
      queue = queue
        .then(async () => {
          const response = await fetch(path, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            // Keep invited people when open to everyone, so switching back restores them.
            body: JSON.stringify({ visibility: next.visibility, emails: next.emails }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || "Could not update access");
          if (current === next) status = { text: "Saved" };
        })
        .catch((error) => {
          current = previous;
          status = { text: error.message || "Could not update access", error: true };
        })
        .then(render);
    }

    function add(email) {
      if (!current.emails.includes(email)) setEmails(current.emails.concat(email));
      input.value = "";
      highlighted = 0;
      renderSuggestions();
      input.focus();
    }

    function onKey(event) {
      const typed = input.value.trim();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!options.length) return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        highlighted = (highlighted + step + options.length) % options.length;
        renderSuggestions();
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (options[highlighted]) add(options[highlighted]);
      } else if (event.key === "Tab" && !event.shiftKey && typed && options[highlighted]) {
        // Tab adds the highlighted person, like Enter.
        event.preventDefault();
        add(options[highlighted]);
      } else if (event.key === "Escape" && typed) {
        event.stopPropagation();
        input.value = "";
        renderSuggestions();
      }
    }

    function matches(email, query) {
      const name = names.get(email);
      return email.includes(query) || Boolean(name && name.toLowerCase().includes(query));
    }

    function renderSuggestions() {
      const typed = input.value.trim().toLowerCase();
      if (!typed) {
        options = [];
        suggestions.hidden = true;
        suggestions.replaceChildren();
        return;
      }
      // People already added are left out. A full address that is not a known person can be added.
      const known = people
        .map((person) => person.email)
        .filter((email) => !current.emails.includes(email) && matches(email, typed))
        .slice(0, 8);
      options =
        isEmail(typed) && !names.has(typed) && !current.emails.includes(typed) ? [typed].concat(known) : known;
      highlighted = Math.min(highlighted, Math.max(options.length - 1, 0));
      suggestions.hidden = false;
      if (!options.length) {
        suggestions.replaceChildren(el("div", { class: "empty", text: "No match. Type a full address." }));
        return;
      }
      suggestions.replaceChildren(
        ...options.map((email, index) => {
          const name = names.get(email);
          return el(
            "button",
            {
              class: "suggestion",
              type: "button",
              role: "option",
              tabindex: "-1",
              "aria-selected": String(index === highlighted),
              // Keep focus in the input.
              onpointerdown: (event) => event.preventDefault(),
              onclick: () => add(email),
              onpointermove: () => {
                if (highlighted === index) return;
                highlighted = index;
                renderSuggestions();
              },
            },
            [
              avatar(name || email, name === undefined),
              el("span", { class: "who" }, [
                el("span", { text: name || email }),
                el("span", { class: "sub", text: name ? email : "Invite by address" }),
              ]),
              el("span", { class: "hint", text: "tab to add" }),
            ],
          );
        }),
      );
    }

    function personRow(email, name, opts) {
      const row = el("li", { class: "person" }, [
        el("div", { class: "person-row" }, [
          avatar(name || email, opts.unknown),
          el("span", { class: "who" }, [
            el("span", {}, [
              document.createTextNode(name || email),
              opts.suffix ? el("span", { class: "muted", text: " " + opts.suffix }) : null,
            ]),
            name ? el("span", { class: "sub", text: email }) : null,
          ]),
          opts.action,
        ]),
      ]);
      if (opts.warning) {
        row.append(el("p", { class: "warning", style: "margin: 0" }, [icon("alert"), el("span", { text: opts.warning })]));
      }
      return row;
    }

    function renderPeople() {
      const rows = [];
      if (me) {
        rows.push(personRow(me.email, me.name, { suffix: "(you)", action: el("span", { class: "role", text: "Owner" }) }));
      }
      current.emails.forEach((email) => {
        const outside = domain !== null && !email.endsWith("@" + domain);
        rows.push(
          personRow(email, names.get(email) || null, {
            unknown: !names.has(email),
            warning: outside ? "Outside " + domain + ". Cloudflare Access can block this person." : "",
            action: el(
              "button",
              {
                class: "icon-btn",
                type: "button",
                "aria-label": "Remove " + email,
                onclick: () => setEmails(current.emails.filter((item) => item !== email)),
              },
              [icon("x")],
            ),
          }),
        );
      });
      list.replaceChildren(...rows);
    }

    async function copyLink() {
      try {
        await navigator.clipboard.writeText(location.href.split("#")[0]);
        status = { text: "Link copied" };
      } catch (error) {
        status = { text: "Could not copy the link", error: true };
      }
      render();
    }

    function render() {
      const everyone = current.visibility === "everyone";
      const triggerIcon = everyone ? "globe" : current.visibility === "selected" ? "users" : "lock";
      trigger.replaceChildren(icon(triggerIcon), el("span", { text: "Share" }));
      trigger.setAttribute("aria-expanded", String(open));
      trigger.title = everyone
        ? __NAP_EVERYONE__ + " can view"
        : current.emails.length
          ? "Only people invited can view"
          : "Only you can view";
      panel.hidden = !open;
      if (!open) return;
      select.value = everyone ? "everyone" : "invited";
      leadIcon.innerHTML = icon(everyone ? "globe" : "lock").innerHTML;
      invited.hidden = everyone;
      renderPeople();
      renderSuggestions();
      statusLine.textContent = status ? status.text : "";
      statusLine.className = "status" + (status && status.error ? " error" : "");
    }

    document.addEventListener("pointerdown", (event) => {
      if (open && !event.composedPath().includes(host)) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (open && event.key === "Escape") setOpen(false);
    });
    // A click in a frame (the toolbar's page) moves focus out of this window.
    window.addEventListener("blur", () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (open && active && active.tagName === "IFRAME") setOpen(false);
      });
    });

    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();`;

/** Changes when the widget source changes. Pages add it as ?v= so browsers do not use an old copy. */
export const SHARE_WIDGET_VERSION = (() => {
  let hash = 5381;
  for (let index = 0; index < SHARE_SOURCE.length; index++) {
    hash = ((hash << 5) + hash + SHARE_SOURCE.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
})();

export function serveShareWidget() {
  return new Response(SHARE_SOURCE.replaceAll("__NAP_EVERYONE__", JSON.stringify(EVERYONE_LABEL)), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
