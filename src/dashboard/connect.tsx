import { layoutWithLines, prepareWithSegments, walkLineRanges } from "@chenglou/pretext";
import { BookOpenIcon, CheckIcon } from "lucide-react";
import * as React from "react";
import { TextMorph } from "torph/react";
import { ClaudeIcon, CodexIcon, CursorIcon } from "~/components/brand-icons";
import { Button } from "~/components/ui/button";
import type { Kind } from "~/dashboard/data";
import { KIND_TEXT } from "~/dashboard/kinds";
import { cn } from "~/lib/utils";
import { napConfig } from "~/nap.config";

/** What "Copy prompt" copies: one line that points the agent at the instructions. */
export const AGENT_PROMPT = `Read https://${napConfig.rootDomain}/_nap/api/instructions, then publish what I ask for to Nap.`;
const INSTRUCTIONS_PATH = "/_nap/api/instructions";

/** Used when an instance sets no examples of its own. Generic enough for any team. */
const DEFAULT_EXAMPLES: Array<{ kind: Kind; text: string }> = [
  { kind: "artifact", text: "that turns these notes into a one-pager" },
  { kind: "site", text: "where we can vote on ideas" },
  { kind: "artifact", text: "that charts the numbers in this spreadsheet" },
  { kind: "site", text: "with a shared checklist for our project" },
  { kind: "artifact", text: "that compares these options side by side" },
  { kind: "app", text: "that reminds me to take a break every hour" },
];

/** The instance's examples, or the defaults. App examples only where apps are on. */
export const EXAMPLES = (napConfig.examples?.length ? napConfig.examples : DEFAULT_EXAMPLES).filter(
  (example) => example.kind !== "app" || napConfig.apps,
);

const ASK: Record<Kind, string> = {
  site: "Make me a site",
  artifact: "Make me an artifact",
  app: "Make me an app",
};

const ROTATE_MS = 4_200;

/** The examples take turns. Paused while the page is hidden, and for reduced motion. */
export function useExample() {
  const [index, setIndex] = React.useState(0);
  React.useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setIndex((current) => (current + 1) % EXAMPLES.length);
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return index;
}

/** Waits for web fonts, so measurements use the real font. */
function useFontsReady() {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

/**
 * Breaks text into lines no wider than `width`, balanced: the narrowest width that still needs the
 * same number of lines, so the last line is never a lone word.
 */
function balancedLines(text: string, font: string, letterSpacing: number, width: number) {
  const prepared = prepareWithSegments(text, font, { letterSpacing });
  const count = (at: number) => walkLineRanges(prepared, at, () => {});
  const lines = count(width);
  let fits = width;
  if (lines > 1) {
    let tooNarrow = 0;
    while (fits - tooNarrow > 1) {
      const middle = (fits + tooNarrow) / 2;
      if (count(middle) === lines) fits = middle;
      else tooNarrow = middle;
    }
  }
  return layoutWithLines(prepared, fits, 1).lines.map((line) => line.text.trim());
}

/**
 * One example: "Make me a site" on its own line in the kind's colour, the rest below it. Text
 * morphs from one example to the next (torph). Torph does not wrap, so pretext breaks the rest
 * into balanced lines at the current width.
 *
 * With `reserve`, the block keeps the height of the longest example, so the page never moves when
 * the example changes. `children` (such as the dots) sit right under the text, and the spare room
 * goes below them.
 */
export function ExampleText({
  index,
  className,
  restClassName,
  reserve = true,
  children,
}: {
  index: number;
  className?: string;
  restClassName?: string;
  reserve?: boolean;
  children?: React.ReactNode;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const probe = React.useRef<HTMLSpanElement>(null);
  const footer = React.useRef<HTMLDivElement>(null);
  const [footerHeight, setFooterHeight] = React.useState(0);
  const fontsReady = useFontsReady();
  const [layout, setLayout] = React.useState<{
    lines: Array<Array<string>>;
    lineHeight: number;
  } | null>(null);

  React.useLayoutEffect(() => {
    const element = box.current;
    const sample = probe.current;
    if (!element || !sample || !fontsReady) return;
    const measure = () => {
      const style = getComputedStyle(sample);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const fontSize = Number.parseFloat(style.fontSize);
      const lineHeight =
        style.lineHeight === "normal" ? fontSize * 1.2 : Number.parseFloat(style.lineHeight);
      const letterSpacing =
        style.letterSpacing === "normal" ? 0 : Number.parseFloat(style.letterSpacing);
      // A little slack: torph sets each word in its own box, which can be a hair wider.
      const width = element.clientWidth * 0.97;
      if (width <= 0) return;
      setFooterHeight(footer.current?.offsetHeight ?? 0);
      setLayout({
        lineHeight,
        lines: EXAMPLES.map((example) => balancedLines(example.text, font, letterSpacing, width)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fontsReady]);

  const example = EXAMPLES[index];
  const lines = layout?.lines[index];
  const rest = lines ? lines.join("\n") : example.text;
  // Room for the longest example plus what sits under it. A fixed minimum, not padding that
  // depends on this example: torph animates the text's height while it morphs.
  const minHeight =
    reserve && layout
      ? // A quarter line of slack: torph's word boxes can be a few pixels taller mid-morph.
        (Math.max(...layout.lines.map((each) => each.length)) + 1.25) * layout.lineHeight +
        footerHeight
      : undefined;

  return (
    <div
      ref={box}
      className={cn("relative", className)}
      style={minHeight ? { minHeight } : undefined}
    >
      <TextMorph as="span" className={cn("block font-semibold", KIND_TEXT[example.kind])}>
        {ASK[example.kind]}
      </TextMorph>
      <span ref={probe} className={cn("block", restClassName)}>
        {layout ? (
          // align-top: torph sets an inline block, which would add a baseline gap below it.
          <TextMorph as="span" className="align-top">
            {rest}
          </TextMorph>
        ) : (
          rest
        )}
      </span>
      {children && (
        <div ref={footer} className="flow-root">
          {children}
        </div>
      )}
    </div>
  );
}

export function ExampleDots({ index, className }: { index: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} aria-hidden="true">
      {EXAMPLES.map((_, dot) => (
        <i
          key={dot}
          className={cn(
            "h-1.5 rounded-full bg-current transition-all duration-500",
            dot === index ? "w-3.5 opacity-60" : "w-1.5 opacity-15",
          )}
        />
      ))}
    </span>
  );
}

function AgentMarks() {
  return (
    <span className="flex items-center gap-1.5" aria-hidden="true">
      <ClaudeIcon className="text-[#D97757]" />
      <CodexIcon />
      <CursorIcon />
    </span>
  );
}

const SIZES = {
  sm: { button: "default", className: "rounded-full px-3.5" },
  md: { button: "lg", className: "rounded-full px-4" },
  lg: { button: "lg", className: "h-12 gap-3 rounded-full px-6 text-base" },
} as const;

/**
 * Copy prompt, with the line it copies shown under it while you hover or focus it, and Read the
 * instructions, which opens what the agent reads.
 */
export function PromptButtons({
  size = "md",
  className,
  promptPosition = "below",
  promptAlign = "start",
  promptClassName,
}: {
  size?: keyof typeof SIZES;
  className?: string;
  promptPosition?: "below" | "above";
  /** Centre the line under both buttons, for centred layouts. */
  promptAlign?: "start" | "center";
  /** Where the line under the button must stay narrow, such as a sidebar. */
  promptClassName?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const { button, className: sizeClass } = SIZES[size];

  async function copy() {
    await navigator.clipboard.writeText(AGENT_PROMPT);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  }

  return (
    <div className={cn("relative flex flex-wrap items-center gap-2", className)}>
      {/* The line under it is placed against the row, so it can centre under both buttons. */}
      <div className="group/copy">
        {/* The Codex mark punches its prompt out in --card: the button's own colour. */}
        <Button
          size={button}
          className={cn("[--card:var(--primary)]", sizeClass)}
          onClick={() => void copy().catch(console.error)}
        >
          {copied ? <CheckIcon /> : <AgentMarks />}
          {/* Both labels take space, so the button keeps its width when it says Copied. */}
          <span className="grid">
            <span className={cn("col-start-1 row-start-1", copied && "invisible")}>
              Copy prompt
            </span>
            <span className={cn("col-start-1 row-start-1", !copied && "invisible")}>Copied</span>
          </span>
        </Button>
        <p
          className={cn(
            "pointer-events-none absolute z-40 flex gap-2 font-mono text-xs whitespace-nowrap text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-within/copy:opacity-100 group-hover/copy:opacity-100",
            promptPosition === "below" ? "top-[calc(100%+10px)]" : "bottom-[calc(100%+10px)]",
            promptAlign === "center" ? "left-1/2 -translate-x-1/2" : "left-0",
            promptClassName && "w-max whitespace-normal",
            promptClassName,
          )}
        >
          <span className="font-bold text-kind-site">“</span>
          {AGENT_PROMPT}
        </p>
      </div>
      <Button
        variant="outline"
        size={button}
        className={sizeClass}
        nativeButton={false}
        render={<a href={INSTRUCTIONS_PATH} target="_blank" rel="noreferrer" />}
      >
        <BookOpenIcon />
        Read the instructions
      </Button>
    </div>
  );
}

/** The line under Copy prompt, as a pill, for where it sits over other things. */
export const PROMPT_PILL = "rounded-full border bg-popover px-3 py-1.5 shadow-sm";

/** "Connect your agent" as one compact card, for the playful layouts. */
export function ConnectCard({ className }: { className?: string }) {
  const index = useExample();
  return (
    <div
      className={cn(
        "flex w-[440px] max-w-[calc(100vw-2rem)] flex-col gap-3.5 rounded-2xl border bg-card p-5 text-card-foreground shadow-lg",
        className,
      )}
    >
      <div className="flex flex-col gap-0.5">
        <b className="text-[15px] font-semibold">Connect your agent</b>
        <span className="text-[13px] text-muted-foreground">
          It reads the instructions, then publishes for you.
        </span>
      </div>
      <PromptButtons size="sm" promptPosition="above" promptClassName={PROMPT_PILL} />
      <div className="flex items-end gap-3 text-[13.5px]">
        <ExampleText
          index={index}
          reserve={false}
          className="flex-1"
          restClassName="text-foreground/80"
        />
        <ExampleDots index={index} className="mb-1.5" />
      </div>
    </div>
  );
}
