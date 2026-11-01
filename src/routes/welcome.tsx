import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { Avatar } from "~/components/avatar";
import { captureScreen } from "~/components/welcome/capture";
import { CARD, canRunDust, cardTheme, runDust } from "~/components/welcome/dust";
import {
  COLORS,
  SHAPES,
  firstName,
  lookKey,
  type Color,
  type Look,
  type Shape,
} from "~/lib/looks";
import { cn } from "~/lib/utils";
import { napConfig } from "~/nap.config";

/**
 * /welcome?next=<url> — where Nap sends people who have not picked a name yet (and where they
 * change their name and look later). They confirm or fix our guess at their name, pick a look,
 * and a transition takes them on to the page they wanted.
 */
export const Route = createFileRoute("/welcome")({
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === "string" ? { next: search.next } : {},
  head: () => ({ meta: [{ title: "What should we call you? · Nap" }] }),
  component: Welcome,
});

type State = {
  me: { email: string; name: string } & Look;
  named: boolean;
  guess: { guess: string; score: number; confident: boolean };
  taken: Array<{ name: string } & Look>;
};

type Stage = "ask" | "react" | "leaving" | "card";
type Outcome = "nailed" | "missed" | "fixed" | "clickthrough";

const COPY: Record<Outcome, { emoji: string; title: string; body?: string }> = {
  nailed: { emoji: "😎", title: "Nailed it." },
  missed: { emoji: "😩", title: "Ah man! We thought we'd nailed that :(" },
  fixed: { emoji: "🙏", title: "Yeah, fair. That was rough." },
  clickthrough: {
    emoji: "🤨",
    title: "Wait really?? Haha! Didn't think we had it!",
    body: "… or wait… did you just click right on through?",
  },
};

/** Only Nap's own hosts: this origin, the dashboard, and its sites. Anything else goes home. */
function safeNext(raw: string | undefined) {
  if (!raw) return "/";
  try {
    const url = new URL(raw, window.location.origin);
    const root = napConfig.rootDomain.toLowerCase();
    if (url.origin === window.location.origin) return url.href;
    if (url.protocol === "https:" && (url.hostname === root || url.hostname.endsWith(`.${root}`))) {
      return url.href;
    }
  } catch {
    // Not a URL.
  }
  return "/";
}

function Welcome() {
  const { next: rawNext } = Route.useSearch();
  const [state, setState] = React.useState<State | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [stage, setStage] = React.useState<Stage>("ask");
  const [name, setName] = React.useState("");
  const [look, setLook] = React.useState<Look | null>(null);
  const [saved, setSaved] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [picking, setPicking] = React.useState(false);
  const screenRef = React.useRef<HTMLDivElement>(null);
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const tap = React.useRef<{ x: number; y: number } | null>(null);
  const [next, setNext] = React.useState("/");

  const load = React.useCallback(async () => {
    const response = await fetch("/api/profile", { cache: "no-store" });
    if (!response.ok) throw new Error("Nap could not load your profile. Reload to try again.");
    return (await response.json()) as State;
  }, []);

  React.useEffect(() => {
    setNext(safeNext(rawNext));
    load()
      .then((data) => {
        setState(data);
        setName(data.me.name);
        setLook({ shape: data.me.shape, color: data.me.color });
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [load, rawNext]);

  // Once the name is saved, fetch the next page while the person reads the reaction.
  React.useEffect(() => {
    if (!saved || next === "/") return;
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = next;
    document.head.appendChild(link);
    return () => {
      link.remove();
    };
  }, [saved, next]);

  const taken = React.useMemo(() => new Set(state?.taken.map(lookKey)), [state]);
  const editing = Boolean(state?.named);

  const save = async (value: string, chosen: Look) => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: value, ...chosen }),
      });
      const result = (await response.json()) as { error?: string };
      if (response.status === 409) {
        const fresh = await load();
        setState(fresh);
        setPicking(true);
      }
      if (!response.ok) throw new Error(result.error || "Saving failed. Try again.");
      setSaved(value);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const leave = async () => {
    if (!look || !state) return;
    setPicking(false);
    (document.activeElement as HTMLElement | null)?.blur();
    // Let a closing keyboard give the page its height back before we capture it.
    await new Promise((resolve) => setTimeout(resolve, 120));
    setStage("leaving");
    const person = { name: saved || name, ...look };
    const dark = document.documentElement.classList.contains("dark");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const go = () => {
      setStage("card");
      window.setTimeout(() => window.location.replace(next), 650);
    };
    if (reduced || !canRunDust() || !screenRef.current || !overlayRef.current) return go();
    try {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const page = await captureScreen(screenRef.current, dpr);
      const canvas = document.createElement("canvas");
      canvas.style.cssText = `position:absolute;inset:0;width:${width}px;height:${height}px`;
      overlayRef.current.replaceChildren(canvas);
      await runDust({
        canvas,
        width,
        height,
        dpr,
        page,
        origin: tap.current ?? { x: width / 2, y: height * 0.8 },
        person,
        dark,
        subtitle: subtitleFor(next),
        font: getComputedStyle(document.body).fontFamily,
      });
    } catch (e) {
      console.warn("The transition failed; going straight on", e);
    }
    go();
  };

  const submit = async () => {
    if (!look || !state) return;
    const value = name.replace(/\s+/g, " ").trim();
    if (!value) return;
    if (!(await save(value, look))) return;
    if (editing) void leave();
    else setStage("react");
  };

  const fixIt = () => {
    setStage("ask");
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 60);
  };

  const shuffle = () => {
    const free = SHAPES.flatMap((shape) =>
      COLORS.map((color) => ({ shape, color })).filter(
        (option) => !taken.has(lookKey(option)) && (!look || lookKey(option) !== lookKey(look)),
      ),
    );
    if (free.length) setLook(free[Math.floor(Math.random() * free.length)]);
  };

  const outcome: Outcome = (() => {
    if (!state) return "nailed";
    const changed = saved.trim() !== state.guess.guess.trim();
    if (state.guess.confident) return changed ? "missed" : "nailed";
    return changed ? "fixed" : "clickthrough";
  })();

  return (
    <div
      className="fixed inset-0 overflow-hidden bg-background text-foreground"
      onPointerDownCapture={(event) => {
        tap.current = { x: event.clientX, y: event.clientY };
      }}
    >
      <div
        ref={screenRef}
        inert={stage === "leaving" || stage === "card"}
        className="absolute inset-0 overflow-y-auto bg-background"
      >
        <div className="mx-auto flex min-h-full w-full max-w-[460px] flex-col px-6 pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:justify-center sm:py-20">
          <div className="text-sm font-bold tracking-tight sm:fixed sm:top-6 sm:left-8">nap</div>
          <div className="mt-auto pt-10 sm:mt-0 sm:pt-0">
            {loadError ? (
              <p className="text-sm text-destructive">{loadError}</p>
            ) : !state || !look ? null : stage === "ask" ? (
              <AskForm
                state={state}
                name={name}
                setName={setName}
                look={look}
                setLook={setLook}
                taken={taken}
                picking={picking}
                setPicking={setPicking}
                onShuffle={shuffle}
                onSubmit={() => void submit()}
                saving={saving}
                error={error}
                editing={editing}
                inputRef={inputRef}
              />
            ) : (
              <Reaction
                outcome={outcome}
                name={saved}
                look={look}
                guess={state.guess.guess}
                busy={saving || stage !== "react"}
                error={error}
                onContinue={() => void leave()}
                onFix={fixIt}
                onRevert={async () => {
                  setName(state.guess.guess);
                  if (await save(state.guess.guess, look)) void leave();
                }}
              />
            )}
          </div>
        </div>
      </div>
      <div ref={overlayRef} className="pointer-events-none absolute inset-0" />
      {stage === "card" && look && <Card name={saved || name} look={look} subtitle={subtitleFor(next)} />}
    </div>
  );
}

function subtitleFor(next: string) {
  try {
    const url = new URL(next, window.location.origin);
    return url.host + (url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : "");
  } catch {
    return napConfig.rootDomain;
  }
}

function AskForm({
  state,
  name,
  setName,
  look,
  setLook,
  taken,
  picking,
  setPicking,
  onShuffle,
  onSubmit,
  saving,
  error,
  editing,
  inputRef,
}: {
  state: State;
  name: string;
  setName: (value: string) => void;
  look: Look;
  setLook: (look: Look) => void;
  taken: Set<string>;
  picking: boolean;
  setPicking: (open: boolean) => void;
  onShuffle: () => void;
  onSubmit: () => void;
  saving: boolean;
  error: string;
  editing: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const edited = name.trim() !== state.guess.guess.trim();
  const emoji = editing ? "👋" : edited ? "✍️" : state.guess.confident ? "😏" : "😬";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div key={emoji} className="text-6xl leading-none animate-in zoom-in-50 duration-200 sm:text-7xl">
        {emoji}
      </div>
      <h1 className="mt-4 text-[34px] leading-[1.05] font-bold tracking-tight sm:text-[44px]">
        What should we call you?
      </h1>
      <div className="mt-6 flex items-center gap-3 border-b-2 border-border pb-2 transition-colors focus-within:border-foreground">
        <button
          type="button"
          onClick={() => setPicking(!picking)}
          className="relative shrink-0 rounded-full transition-transform outline-none active:scale-90 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Change your shape and colour"
          aria-expanded={picking}
        >
          <Avatar
            key={lookKey(look)}
            look={look}
            name={name || state.guess.guess}
            size={44}
            className="animate-in zoom-in-50 spin-in-12 duration-300"
          />
        </button>
        <input
          ref={inputRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          className="min-w-0 flex-1 bg-transparent text-[26px] font-semibold tracking-tight outline-none sm:text-[30px]"
          aria-label="Your name"
          autoComplete="name"
          spellCheck={false}
        />
      </div>
      {!editing && (
        <p
          className={cn(
            "mt-2 text-[13px] leading-snug text-muted-foreground transition-opacity duration-300",
            edited && "opacity-0",
          )}
        >
          {state.guess.confident
            ? "This is our best guess. We think it's pretty good."
            : "This is our best guess. It's probably a bit awful though innit?"}
        </p>
      )}
      {picking && (
        <LookPicker
          look={look}
          name={name || state.guess.guess}
          taken={taken}
          onPick={(chosen) => {
            setLook(chosen);
            setPicking(false);
          }}
          onShuffle={onShuffle}
        />
      )}
      {error && <p className="mt-3 text-[13px] text-destructive">{error}</p>}
      <button
        type="submit"
        disabled={!name.trim() || saving}
        className="mt-6 h-12 w-full rounded-md bg-primary text-[15px] font-semibold text-primary-foreground transition-opacity disabled:opacity-40"
      >
        {editing ? "Save" : edited ? "Save" : state.guess.confident ? "That's me" : "Sure, whatever"}
      </button>
      {!picking && (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="mt-1 h-10 w-full text-[13px] font-medium text-muted-foreground hover:text-foreground"
        >
          Not feeling the {look.color} {look.shape}?
        </button>
      )}
    </form>
  );
}

/** Every free shape and colour. Looks other people have are left out. */
function LookPicker({
  look,
  name,
  taken,
  onPick,
  onShuffle,
}: {
  look: Look;
  name: string;
  taken: Set<string>;
  onPick: (look: Look) => void;
  onShuffle: () => void;
}) {
  return (
    <div className="mt-4 animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="flex items-baseline justify-between">
        <p className="text-[13px] font-medium">Pick your look</p>
        <button type="button" onClick={onShuffle} className="text-[13px] font-medium text-muted-foreground hover:text-foreground">
          🎲 Surprise me
        </button>
      </div>
      <p className="text-xs text-muted-foreground">Everyone gets their own. The missing ones are taken.</p>
      <div className="mt-3 grid max-w-[340px] grid-cols-7 gap-1.5" role="listbox" aria-label="Shapes and colours">
        {SHAPES.flatMap((shape: Shape) =>
          COLORS.map((color: Color) => {
            const option = { shape, color };
            const key = lookKey(option);
            if (taken.has(key)) return <div key={key} aria-hidden className="aspect-square" />;
            const selected = key === lookKey(look);
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={`${color} ${shape}`}
                onClick={() => onPick(option)}
                className={cn(
                  "grid aspect-square place-items-center rounded-md transition-transform outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring",
                  selected && "bg-muted ring-2 ring-foreground",
                )}
              >
                <Avatar look={option} name={name} size={30} letters={false} className="size-[70%]" />
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}

function Reaction({
  outcome,
  name,
  look,
  guess,
  busy,
  error,
  onContinue,
  onFix,
  onRevert,
}: {
  outcome: Outcome;
  name: string;
  look: Look;
  guess: string;
  busy: boolean;
  error: string;
  onContinue: () => void;
  onFix: () => void;
  onRevert: () => void;
}) {
  const copy = COPY[outcome];
  return (
    <div>
      <div className="text-7xl leading-none animate-in zoom-in-[0.2] spin-in-12 duration-300 sm:text-8xl">
        {copy.emoji}
      </div>
      <h1 className="mt-4 text-[30px] leading-[1.08] font-bold tracking-tight sm:text-[40px]">{copy.title}</h1>
      {copy.body && <p className="mt-2 text-[15px] text-muted-foreground sm:text-base">{copy.body}</p>}
      <div className="mt-6 flex items-center gap-2.5">
        <Avatar look={look} name={name} size={36} />
        <span className="text-[17px] font-semibold tracking-tight">{name}</span>
      </div>
      {error && <p className="mt-3 text-[13px] text-destructive">{error}</p>}
      <div className="mt-6 grid gap-1">
        {outcome === "clickthrough" ? (
          <>
            <button
              className="h-12 rounded-md bg-primary text-[15px] font-semibold text-primary-foreground disabled:opacity-40"
              onClick={onFix}
              disabled={busy}
            >
              Busted. Let me fix it
            </button>
            <button className="h-11 text-[15px] font-medium disabled:opacity-40" onClick={onContinue} disabled={busy}>
              No really, that's me
            </button>
          </>
        ) : (
          <>
            <button
              className="h-12 rounded-md bg-primary text-[15px] font-semibold text-primary-foreground disabled:opacity-40"
              onClick={onContinue}
              disabled={busy}
            >
              Let's go
            </button>
            {outcome === "missed" && (
              <button
                className="h-11 text-[15px] font-medium text-muted-foreground disabled:opacity-40"
                onClick={onRevert}
                disabled={busy}
              >
                Fine, I'm “{guess}”
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The card the transition resolves into, as DOM: the same layout as drawCard in dust.ts. */
function Card({ name, look, subtitle }: { name: string; look: Look; subtitle: string }) {
  const [theme] = React.useState(() => cardTheme(document.documentElement.classList.contains("dark")));
  return (
    <div className="fixed inset-0 z-50" style={{ background: theme.bg, color: theme.fg }}>
      <div
        className="absolute left-1/2"
        style={{ top: `${CARD.shapeY * 100}%`, transform: "translate(-50%, -50%)" }}
      >
        <Avatar look={look} name={name} size={CARD.shape} />
      </div>
      <div
        className="absolute inset-x-0 text-center font-extrabold"
        style={{
          top: `calc(${CARD.shapeY * 100}% + ${CARD.nameGap}px)`,
          transform: "translateY(-50%)",
          fontSize: CARD.nameSize,
          letterSpacing: -0.8,
          lineHeight: 1,
        }}
      >
        Hi, {firstName(name)}
      </div>
      <div
        className="absolute inset-x-0 text-center font-medium"
        style={{
          top: `calc(${CARD.shapeY * 100}% + ${CARD.subGap}px)`,
          transform: "translateY(-50%)",
          fontSize: CARD.subSize,
          color: theme.sub,
          lineHeight: 1,
        }}
      >
        {subtitle}
      </div>
    </div>
  );
}
