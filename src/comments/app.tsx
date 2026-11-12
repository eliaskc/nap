import {
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  EyeIcon,
  EyeOffIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Avatar, AvatarFallback } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { commentsApi, type Message, type Thread } from "./api";
import type { FrameAnchor, FrameState, FromBar, FromFrame } from "./protocol";

/**
 * Comments that float over an artifact. Commented text gets a soft highlight and nothing else:
 * there is no reliable margin to put markers in, and markers over the text would cover it.
 * Hovering the highlight previews the thread below it; clicking opens it with a reply box.
 * Selecting text shows a small button to comment. The eye button in the bar hides the
 * highlights. The Comments button lists every thread on the page, including comments on the
 * whole page, comments whose text is gone, and resolved ones.
 *
 * This runs in the Nap bar at /artifact/<slug>. The artifact is in a sandboxed frame with an
 * opaque origin, so this page cannot read it. The comments script in the frame (frame.ts) finds
 * the text and reports rectangles, the selection, hovers, and clicks with postMessage. Popovers
 * live here, above the frame, and only this page calls the comment API. Popovers follow the artifact's own background (light or dark); the bar button follows the
 * system, like the bar.
 */

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘⌥M" : "Ctrl+Alt+M";
const POLL_MS = 30_000;
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 400;
const DRAFT = "__draft";
const VISIBLE_KEY = "nap:comments:visible";

type Draft = { quote: string; prefix: string; suffix: string; path: string };
type Open = { kind: "thread"; id: string; pinned: boolean } | { kind: "draft" } | null;

export type CommentsConfig = {
  /** `/artifact/<slug>/_nap/comments`. */
  api: string;
  frame: HTMLIFrameElement;
  /** Where the bar button goes. */
  slot: HTMLElement;
  /** The element around the frame. Popover anchors are drawn over it. */
  stage: HTMLElement;
  /** Where popovers go. Its theme follows the artifact. */
  layer: HTMLElement;
};

export function CommentsApp({ api: apiPath, frame, slot, stage, layer }: CommentsConfig) {
  const api = useMemo(() => commentsApi(apiPath), [apiPath]);
  const [threads, setThreads] = useState<Array<Thread>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const systemDark = useSystemDark();

  // What the frame last reported.
  const [frameState, setFrameState] = useState<FrameState | null>(null);
  const [readyTick, setReadyTick] = useState(0);
  const path = frameState?.path ?? "/";
  const pageDark = frameState?.dark ?? false;
  const anchors = useMemo(
    () => new Map((frameState?.anchors ?? []).map((anchor) => [anchor.id, anchor])),
    [frameState],
  );
  const send = useCallback(
    // The frame's origin is opaque, so it has no name to send to. Messages carry only quotes
    // from the page itself and thread ids, never comment text.
    (message: FromBar) => frame.contentWindow?.postMessage(message, "*"),
    [frame],
  );

  useEffect(() => {
    layer.classList.toggle("dark", pageDark);
  }, [layer, pageDark]);

  const [open, setOpenState] = useState<Open>(null);
  const openRef = useRef<Open>(null);
  const setOpen = useCallback((next: Open) => {
    openRef.current = next;
    setOpenState(next);
  }, []);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Unsent text: "draft", "page", or a thread id for a reply.
  const [texts, setTexts] = useState<Record<string, string>>({});
  const setText = (key: string, value: string) => setTexts((all) => ({ ...all, [key]: value }));
  const [listOpen, setListOpen] = useState(false);
  // In the list: a thread id, "new" for a comment on the page, or null for the list.
  const [listDetail, setListDetail] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [visible, setVisibleState] = useState(() => readVisible());
  const setVisible = (next: boolean) => {
    setVisibleState(next);
    try {
      localStorage.setItem(VISIBLE_KEY, next ? "1" : "0");
    } catch {}
    if (!next && openRef.current?.kind === "thread") setOpen(null);
  };
  const highlights = useRef(new Map<string, HTMLElement>());
  const draftAnchor = useRef<HTMLSpanElement>(null);
  const timers = useRef({ open: 0, close: 0 });

  const refresh = useCallback(async () => {
    try {
      setThreads(await api.list());
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const here = useMemo(() => threads.filter((thread) => thread.path === path), [threads, path]);
  const openId = open?.kind === "thread" ? open.id : null;

  // Tell the frame which quotes to find and highlight: open threads on this page, unless hidden.
  const wanted = useMemo(
    () => (visible ? here.filter((thread) => !thread.resolved && thread.quote) : []),
    [here, visible],
  );
  const showDraft = Boolean(draft && open?.kind === "draft");
  useEffect(() => {
    send({
      type: "nap:comments:threads",
      threads: wanted.map(({ id, quote, prefix, suffix }) => ({ id, quote, prefix, suffix })),
      active: openId,
      draft:
        showDraft && draft
          ? { quote: draft.quote, prefix: draft.prefix, suffix: draft.suffix }
          : null,
    });
  }, [send, wanted, openId, draft, showDraft, readyTick]);

  const floating = useMemo(
    () =>
      wanted
        .filter((thread) => anchors.has(thread.id))
        .sort((a, b) => anchors.get(a.id)!.start - anchors.get(b.id)!.start),
    [wanted, anchors],
  );

  // Hover previews after a short delay and closes after a short delay. A click pins it open.
  const hover = useCallback(
    (id: string) => {
      clearTimeout(timers.current.close);
      const current = openRef.current;
      if (current && (current.kind === "draft" || current.pinned || current.id === id)) return;
      clearTimeout(timers.current.open);
      timers.current.open = window.setTimeout(
        () => setOpen({ kind: "thread", id, pinned: false }),
        current ? 0 : HOVER_OPEN_MS,
      );
    },
    [setOpen],
  );
  const leave = useCallback(() => {
    clearTimeout(timers.current.open);
    const current = openRef.current;
    if (!current || current.kind === "draft" || current.pinned) return;
    clearTimeout(timers.current.close);
    timers.current.close = window.setTimeout(() => setOpen(null), HOVER_CLOSE_MS);
  }, [setOpen]);
  const pin = useCallback(
    (id: string) => {
      clearTimeout(timers.current.open);
      clearTimeout(timers.current.close);
      setListOpen(false);
      setOpen({ kind: "thread", id, pinned: true });
    },
    [setOpen],
  );

  const selection = frameState?.selection ?? null;
  const startDraft = () => {
    if (!selection) {
      setOpen(null);
      setListOpen(true);
      setListDetail("new");
      return;
    }
    const { quote, prefix, suffix } = selection;
    send({ type: "nap:comments:clear-selection" });
    setListOpen(false);
    setDraft({ quote, prefix, suffix, path });
    setOpen({ kind: "draft" });
  };

  const closeDraft = () => {
    setDraft(null);
    setText("draft", "");
    setOpen(null);
  };

  // The latest handlers, for the message listener that is added once.
  const latest = useRef({ hover, leave, pin, startDraft, closeDraft, texts });
  latest.current = { hover, leave, pin, startDraft, closeDraft, texts };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only the artifact frame. Its origin is opaque ("null"), so check the window.
      if (event.source !== frame.contentWindow) return;
      const data = event.data as FromFrame;
      if (!data || typeof data !== "object" || typeof data.type !== "string") return;
      if (data.type === "nap:comments:ready") setReadyTick((tick) => tick + 1);
      else if (data.type === "nap:comments:state") setFrameState(cleanState(data));
      else if (data.type === "nap:comments:hover") {
        if (typeof data.id === "string") latest.current.hover(data.id);
        else latest.current.leave();
      } else if (data.type === "nap:comments:click") {
        if (typeof data.id === "string") return latest.current.pin(data.id);
        const current = openRef.current;
        if (current?.kind === "thread") setOpen(null);
        if (current?.kind === "draft" && !latest.current.texts.draft?.trim())
          latest.current.closeDraft();
      } else if (data.type === "nap:comments:shortcut") latest.current.startDraft();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame, setOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onShortcut(event, () => latest.current.startDraft());
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // ---- Server ----

  const replace = (thread: Thread) =>
    setThreads((all) =>
      all.some((item) => item.id === thread.id)
        ? all.map((item) => (item.id === thread.id ? thread : item))
        : [...all, thread],
    );

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitDraft = () =>
    act(async () => {
      const body = texts.draft?.trim();
      if (!body || !draft) return;
      const { quote, prefix, suffix } = draft;
      const created = await api.create({ body, path: draft.path, quote, prefix, suffix });
      replace(created);
      setDraft(null);
      setText("draft", "");
      setVisible(true);
      setOpen({ kind: "thread", id: created.id, pinned: true });
    });

  const submitPageComment = () =>
    act(async () => {
      const body = texts.page?.trim();
      if (!body) return;
      const created = await api.create({ body, path, quote: "", prefix: "", suffix: "" });
      replace(created);
      setText("page", "");
      setListDetail(created.id);
    });

  const submitReply = (id: string) =>
    act(async () => {
      const body = texts[id]?.trim();
      if (!body) return;
      replace(await api.reply(id, body));
      setText(id, "");
    });

  const toggleResolved = (thread: Thread) =>
    act(async () => {
      const updated = await api.resolve(thread.id, !thread.resolved);
      replace(updated);
      if (updated.resolved && openRef.current?.kind === "thread") setOpen(null);
    });

  // ---- Layout over the frame ----

  // The frame fills the stage, so the frame's viewport coordinates are the stage's.
  const width = frameState?.width ?? frame.clientWidth;
  const height = frame.clientHeight;
  const highlightBoxes = useMemo(() => {
    const boxes: Array<{ id: string; left: number; top: number; width: number; height: number }> =
      [];
    for (const thread of floating) {
      const rects = anchors.get(thread.id)!.rects;
      if (!rects.length) continue;
      const top = Math.min(...rects.map((r) => r.top));
      const bottom = Math.max(...rects.map((r) => r.top + r.height));
      const left = Math.min(...rects.map((r) => r.left));
      const right = Math.max(...rects.map((r) => r.left + r.width));
      if (bottom < 0 || top > height) continue;
      boxes.push({ id: thread.id, left, top, width: right - left, height: bottom - top });
    }
    return boxes;
  }, [floating, anchors, height]);

  const selectionEnd = selection?.rects[selection.rects.length - 1];
  const draftRects = showDraft ? anchors.get(DRAFT)?.rects : undefined;
  const draftRect = draftRects?.[draftRects.length - 1];
  const openThread = openId ? here.find((thread) => thread.id === openId) : undefined;
  // Cards open below the highlighted text (above when there is no room), never over it.
  const anchorReady =
    open?.kind === "draft"
      ? Boolean(draftRect)
      : highlightBoxes.some((box) => box.id === openId);

  const openCount = here.filter((thread) => !thread.resolved).length;
  const resolvedCount = here.length - openCount;
  const listed = here
    .filter((thread) => showResolved || !thread.resolved)
    .sort(
      (a, b) => order(a, anchors) - order(b, anchors) || a.createdAt.localeCompare(b.createdAt),
    );
  const detail = listDetail && listDetail !== "new" ? here.find((t) => t.id === listDetail) : null;
  // While hidden the frame looks for nothing, so no text counts as gone.
  const isLost = (thread: Thread) =>
    visible && Boolean(thread.quote) && !thread.resolved && !anchors.has(thread.id);

  const openFromList = (thread: Thread) => {
    if (!visible) {
      // Show the highlights again; the frame reports where the text is a moment later.
      setVisible(true);
      if (thread.quote && !thread.resolved) {
        setListOpen(false);
        setTimeout(() => send({ type: "nap:comments:scroll", id: thread.id }), 120);
        setTimeout(() => pin(thread.id), 240);
        return;
      }
    }
    if (!anchors.has(thread.id) || thread.resolved) return setListDetail(thread.id);
    setListOpen(false);
    send({ type: "nap:comments:scroll", id: thread.id });
    // Wait for the frame to report the new position.
    setTimeout(() => pin(thread.id), 120);
  };

  const threadCard = (thread: Thread, options: { preview?: boolean; quote?: boolean } = {}) => (
    <ThreadCard
      thread={thread}
      preview={options.preview}
      showQuote={options.quote}
      lost={isLost(thread)}
      text={texts[thread.id] ?? ""}
      onText={(value) => setText(thread.id, value)}
      onReply={() => submitReply(thread.id)}
      onResolve={() => toggleResolved(thread)}
      onFocus={() => openRef.current?.kind === "thread" && pin(thread.id)}
      busy={busy}
    />
  );

  return (
    <>
      {createPortal(
        <div className={cn("contents", systemDark && "dark")}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-inherit"
            aria-pressed={!visible}
            title={visible ? "Hide comments on the page" : "Show comments on the page"}
            aria-label={visible ? "Hide comments on the page" : "Show comments on the page"}
            onClick={() => setVisible(!visible)}
          >
            {visible ? <EyeIcon /> : <EyeOffIcon />}
          </Button>
          <Popover
            open={listOpen}
            onOpenChange={(next) => {
              setListOpen(next);
              if (next) setOpen(null);
              else setListDetail(null);
            }}
          >
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-inherit"
                  title={`Comments (${SHORTCUT})`}
                />
              }
            >
              <MessageSquareIcon />
              Comments
              {openCount > 0 && (
                <span className="text-muted-foreground tabular-nums">{openCount}</span>
              )}
            </PopoverTrigger>
            <PopoverContent
              container={layer}
              align="end"
              collisionPadding={8}
              className="w-80 gap-0 overflow-hidden p-0"
            >
              {listDetail ? (
                <div className="flex flex-col">
                  <div className="flex items-center border-b px-2 py-1.5">
                    <Button variant="ghost" size="xs" onClick={() => setListDetail(null)}>
                      <ChevronLeftIcon />
                      All comments
                    </Button>
                  </div>
                  {detail && threadCard(detail, { quote: true })}
                  {listDetail === "new" && (
                    <Composer
                      autoFocus
                      value={texts.page ?? ""}
                      placeholder="Comment on the whole page…"
                      busy={busy}
                      onChange={(value) => setText("page", value)}
                      onSubmit={submitPageComment}
                      onCancel={() => setListDetail(null)}
                    />
                  )}
                </div>
              ) : (
                <>
                  <div className="flex h-10 items-center gap-2 border-b pr-1.5 pl-3">
                    <span className="flex-1 font-medium">Comments</span>
                    {resolvedCount > 0 && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-muted-foreground"
                        onClick={() => setShowResolved((v) => !v)}
                      >
                        {showResolved ? "Hide" : "Show"} resolved ({resolvedCount})
                      </Button>
                    )}
                  </div>
                  <div className="flex max-h-96 flex-col overflow-y-auto">
                    {listed.length === 0 && (
                      <p className="px-6 py-8 text-center text-muted-foreground">
                        No comments yet. Select text on the page to comment, or press {SHORTCUT}.
                      </p>
                    )}
                    {listed.map((thread) => (
                      <ListItem
                        key={thread.id}
                        thread={thread}
                        lost={isLost(thread)}
                        onClick={() => openFromList(thread)}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="flex h-10 w-full items-center gap-2 border-t px-3 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => setListDetail("new")}
                  >
                    <MessageSquarePlusIcon className="size-4" />
                    Comment on the whole page
                  </button>
                </>
              )}
              {error && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
            </PopoverContent>
          </Popover>
        </div>,
        slot,
      )}

      {createPortal(
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-10 overflow-hidden",
            pageDark && "dark",
          )}
        >
          {highlightBoxes.map(({ id, ...box }) => (
            <span
              key={id}
              ref={(element) => {
                if (element) highlights.current.set(id, element);
                else highlights.current.delete(id);
              }}
              className="absolute"
              style={box}
            />
          ))}
          {selectionEnd && !draftRect && (
            <button
              type="button"
              aria-label={`Comment on the selection (${SHORTCUT})`}
              title={`Comment (${SHORTCUT})`}
              className="pointer-events-auto absolute flex size-8 items-center justify-center rounded-full bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 transition-transform hover:scale-105 animate-in fade-in-0 zoom-in-90"
              style={{
                left: Math.min(selectionEnd.left + selectionEnd.width + 4, width - 40),
                top: Math.max(4, selectionEnd.top - 38),
              }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={startDraft}
            >
              <MessageSquarePlusIcon className="size-4" />
            </button>
          )}
          {draftRect && (
            <span
              ref={draftAnchor}
              className="absolute"
              style={{
                left: draftRect.left,
                top: draftRect.top,
                width: draftRect.width,
                height: draftRect.height,
              }}
            />
          )}
        </div>,
        stage,
      )}

      <Popover
        // A new anchor needs a new popover: Base UI keeps the anchor it opened with.
        // Places come from the frame a moment after a draft or a new thread starts. Open once
        // there is one: Base UI keeps the anchor it opened with.
        key={`${openId ?? "draft"}:${anchorReady}`}
        open={Boolean(open && anchorReady && (open.kind === "draft" ? draft : openThread))}
        onOpenChange={(next, details) => {
          if (next) return;
          // Keep a comment that is being written when people click elsewhere.
          if (open?.kind === "draft" && texts.draft?.trim() && details.reason !== "escape-key")
            return;
          if (open?.kind === "draft") closeDraft();
          else setOpen(null);
        }}
      >
        <PopoverContent
          container={layer}
          anchor={() =>
            open?.kind === "draft"
              ? draftAnchor.current
              : openId
                ? (highlights.current.get(openId) ?? null)
                : null
          }
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          initialFocus={false}
          finalFocus={false}
          className="w-80 gap-0 overflow-hidden p-0"
          onMouseEnter={() => clearTimeout(timers.current.close)}
          onMouseLeave={leave}
        >
          {open?.kind === "draft" && draft && (
            <Composer
              autoFocus
              value={texts.draft ?? ""}
              placeholder="Add a comment…"
              busy={busy}
              onChange={(value) => setText("draft", value)}
              onSubmit={submitDraft}
              onCancel={closeDraft}
            />
          )}
          {openThread &&
            threadCard(openThread, { preview: open?.kind === "thread" && !open.pinned })}
          {open && error && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
        </PopoverContent>
      </Popover>
    </>
  );
}

// ---- Pieces ----

function PersonAvatar({
  email,
  name,
  size = "sm",
}: {
  email: string;
  name: string;
  size?: "sm" | "default";
}) {
  return (
    <Avatar size={size}>
      <AvatarFallback className="font-medium text-white" style={{ background: colorFor(email) }}>
        {initials(name || email)}
      </AvatarFallback>
    </Avatar>
  );
}

function ListItem({
  thread,
  lost,
  onClick,
}: {
  thread: Thread;
  lost: boolean;
  onClick: () => void;
}) {
  const replies = thread.replies.length;
  return (
    <button
      type="button"
      className="flex w-full gap-2.5 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/60"
      onClick={onClick}
    >
      <PersonAvatar email={thread.author.email} name={thread.author.name} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline gap-1.5 text-xs">
          <span className="truncate font-medium text-foreground">{thread.author.name}</span>
          <span className="shrink-0 text-muted-foreground">{ago(thread.createdAt)}</span>
          {thread.resolved && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 text-muted-foreground">
              <CheckIcon className="size-3" />
              Resolved
            </span>
          )}
        </span>
        {thread.quote ? (
          <span
            className={cn(
              "line-clamp-1 border-l-2 border-amber-400/80 pl-1.5 text-xs text-muted-foreground",
              lost && "border-border line-through",
            )}
          >
            {thread.quote}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">On the whole page</span>
        )}
        <span className="line-clamp-2 text-sm">{thread.body}</span>
        {replies > 0 && (
          <span className="text-xs text-muted-foreground">
            {replies} {replies === 1 ? "reply" : "replies"}
          </span>
        )}
      </span>
    </button>
  );
}

function ThreadCard({
  thread,
  preview,
  showQuote,
  lost,
  text,
  onText,
  onReply,
  onResolve,
  onFocus,
  busy,
}: {
  thread: Thread;
  preview?: boolean;
  showQuote?: boolean;
  lost: boolean;
  text: string;
  onText: (value: string) => void;
  onReply: () => void;
  onResolve: () => void;
  onFocus: () => void;
  busy: boolean;
}) {
  const messages = preview ? [thread] : [thread, ...thread.replies];
  const resolve = (
    <Button
      variant="ghost"
      size="icon-xs"
      className="-my-1 text-muted-foreground hover:text-foreground"
      disabled={busy}
      onClick={onResolve}
      title={thread.resolved ? "Reopen" : "Resolve"}
      aria-label={thread.resolved ? "Reopen" : "Resolve"}
    >
      {thread.resolved ? <RotateCcwIcon /> : <CheckIcon />}
    </Button>
  );
  return (
    <div className="flex flex-col">
      <div className="flex max-h-80 flex-col gap-4 overflow-y-auto p-3.5">
        {showQuote && thread.quote && (
          <p
            className={cn(
              "line-clamp-3 border-l-2 border-amber-400/80 pl-2 text-xs text-muted-foreground",
              lost && "border-border line-through",
            )}
          >
            {thread.quote}
          </p>
        )}
        {lost && (
          <p className="text-xs text-muted-foreground">This text is no longer on the page.</p>
        )}
        {messages.map((message, index) => (
          <MessageView
            key={message.id}
            message={message}
            action={index === 0 && !preview ? resolve : null}
          />
        ))}
        {preview && thread.replies.length > 0 && (
          <p className="pl-8.5 text-xs text-muted-foreground">
            {thread.replies.length} {thread.replies.length === 1 ? "reply" : "replies"} · click to
            open
          </p>
        )}
        {thread.resolved && !preview && (
          <p className="flex items-center gap-1 pl-8.5 text-xs text-muted-foreground">
            <CheckIcon className="size-3" />
            Resolved
          </p>
        )}
      </div>
      {!preview && (
        <Composer
          value={text}
          placeholder="Reply…"
          busy={busy}
          onChange={onText}
          onSubmit={onReply}
          onFocus={onFocus}
          className="border-t"
        />
      )}
    </div>
  );
}

function MessageView({ message, action }: { message: Message; action?: ReactNode }) {
  const name = message.author.name || message.author.email;
  return (
    <div className="flex gap-2.5">
      <PersonAvatar email={message.author.email} name={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="truncate font-medium" title={message.author.email}>
            {name}
          </span>
          <span
            className="shrink-0 text-muted-foreground"
            title={new Date(message.createdAt).toLocaleString()}
          >
            {ago(message.createdAt)}
          </span>
          {action && <span className="ml-auto">{action}</span>}
        </div>
        {message.client && (
          <span className="truncate text-[11px] text-muted-foreground">via {message.client}</span>
        )}
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{message.body}</p>
      </div>
    </div>
  );
}

function Composer({
  value,
  placeholder,
  autoFocus,
  busy,
  onChange,
  onSubmit,
  onCancel,
  onFocus,
  className,
}: {
  value: string;
  placeholder: string;
  autoFocus?: boolean;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  onFocus?: () => void;
  className?: string;
}) {
  const ready = Boolean(value.trim());
  return (
    <div className={cn("flex items-end gap-2 py-2 pr-2 pl-3.5", className)}>
      <Textarea
        autoFocus={autoFocus}
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        className="max-h-40 min-h-7 resize-none rounded-none border-0 bg-transparent px-0 py-1 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          } else if (event.key === "Escape" && onCancel) {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <Button
        size="icon-sm"
        className={cn("shrink-0 rounded-full", !ready && "invisible")}
        disabled={busy || !ready}
        aria-label="Send"
        title="Send (Enter)"
        onClick={onSubmit}
      >
        <ArrowUpIcon />
      </Button>
    </div>
  );
}

// ---- Helpers ----

function readVisible() {
  try {
    return localStorage.getItem(VISIBLE_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Keeps only well-formed numbers and strings from the frame's report. */
function cleanState(state: FrameState): FrameState {
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const rects = (value: unknown) =>
    (Array.isArray(value) ? value : []).slice(0, 200).map((item) => ({
      left: num(item?.left),
      top: num(item?.top),
      width: num(item?.width),
      height: num(item?.height),
    }));
  const str = (value: unknown) => (typeof value === "string" ? value.slice(0, 4000) : "");
  const anchors = (Array.isArray(state.anchors) ? state.anchors : [])
    .filter((anchor) => typeof anchor?.id === "string")
    .map((anchor) => ({
      id: anchor.id,
      start: num(anchor.start),
      rects: rects(anchor.rects),
    }));
  const selection =
    state.selection && typeof state.selection.quote === "string"
      ? {
          quote: str(state.selection.quote),
          prefix: str(state.selection.prefix),
          suffix: str(state.selection.suffix),
          rects: rects(state.selection.rects),
        }
      : null;
  const path = typeof state.path === "string" && state.path.startsWith("/") ? str(state.path) : "/";
  return {
    type: state.type,
    path,
    dark: state.dark === true,
    width: num(state.width),
    anchors,
    selection,
  };
}

export function useSystemDark() {
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return dark;
}

function onShortcut(event: KeyboardEvent, start: () => void) {
  if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyM") {
    event.preventDefault();
    start();
  }
}

/** Page comments first, then by place on the page, then comments whose text is gone. */
function order(thread: Thread, anchors: Map<string, FrameAnchor>) {
  if (!thread.quote) return -1;
  return anchors.get(thread.id)?.start ?? Number.MAX_SAFE_INTEGER;
}

/** The same color as the person's Nap profile (colorFromEmail in nap-server.ts). */
function colorFor(email: string) {
  let hash = 0;
  for (const char of email) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash} 70% 48%)`;
}

function initials(name: string) {
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? "?") + (parts.length > 1 && !name.includes("@") ? parts[1][0] : "")
  ).toUpperCase();
}

export function ago(iso: string) {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
