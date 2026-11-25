import { useId, useState, type CSSProperties, type ReactNode } from 'react'
import { cn, toneColor, toneMix, type Tone } from './lib'

/* ─── small glyphs ────────────────────────────────────────────────────────── */

export function Diamond({ className, filled }: { className?: string; filled?: boolean }) {
  return (
    <svg viewBox="0 0 10 10" className={cn('size-[9px] shrink-0', className)} aria-hidden>
      <path d="M5 0.9 9.1 5 5 9.1 0.9 5Z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

export function PlusIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={cn('size-3 shrink-0 transition-transform duration-200 ease-out-soft motion-reduce:transition-none', open && 'rotate-45', className)}
      aria-hidden
    >
      <path d="M6 1.2v9.6M1.2 6h9.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/* ─── numbers ─────────────────────────────────────────────────────────────── */

/**
 * A number with its prefix and unit dimmed: `≈` `145k` `/yr`.
 * Put a currency sign in `value` if it should stay bright.
 */
export function Num({
  value,
  pre,
  unit,
  className,
}: {
  /** The number. Wrap it in <Morph> to animate changes. */
  value: ReactNode
  pre?: ReactNode
  unit?: ReactNode
  className?: string
}) {
  return (
    <span className={cn('tnum whitespace-nowrap', className)}>
      {pre != null && <span className="text-faint">{pre}</span>}
      <span className="text-value">{value}</span>
      {unit != null && <span className="text-faint [font-size:0.62em] tracking-normal">{unit}</span>}
    </span>
  )
}

const STAT_SIZE = {
  xl: 'text-[64px] leading-[0.95] tracking-[-0.045em] md:text-[92px]',
  lg: 'text-[40px] leading-[1] tracking-[-0.035em] md:text-[52px]',
  md: 'text-[30px] leading-[1.05] tracking-[-0.03em] md:text-[34px]',
  sm: 'text-[22px] leading-[1.1] tracking-[-0.02em]',
}

/** A headline number: eyebrow label, big Light value with dimmed unit, short note. */
export function Stat({
  label,
  value,
  pre,
  unit,
  note,
  tone = 'neutral',
  size = 'md',
  className,
}: {
  label?: ReactNode
  /** The number. Wrap it in <Morph> to animate changes. */
  value: ReactNode
  pre?: ReactNode
  unit?: ReactNode
  note?: ReactNode
  /** Colours the label only; the number stays at full value. */
  tone?: Tone
  size?: keyof typeof STAT_SIZE
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      {label && (
        <div className="eyebrow mb-2.5" style={tone !== 'neutral' ? { color: toneColor(tone) } : undefined}>
          {label}
        </div>
      )}
      <div className={cn('font-light', STAT_SIZE[size])}>
        <Num value={value} pre={pre} unit={unit} />
      </div>
      {note && (
        <div className={cn('text-pretty text-quiet', size === 'xl' ? 'mt-4 text-[14.5px] leading-[1.5]' : 'mt-2 text-[13.5px] leading-[1.45]')}>
          {note}
        </div>
      )}
    </div>
  )
}

/** A row of Stats separated by hairlines; wraps to two columns on phones. */
export function StatRow({
  items,
  size = 'md',
  wide,
  className,
}: {
  items: Array<Parameters<typeof Stat>[0]>
  size?: keyof typeof STAT_SIZE
  /** Span the full content width (default: only with 4+ items). */
  wide?: boolean
  className?: string
}) {
  const isWide = wide ?? items.length > 3
  return (
    <div data-wide={isWide || undefined} className={cn('@container', className)}>
      <div
        className="grid grid-cols-2 gap-y-7 @xl:grid-cols-[repeat(var(--n),minmax(0,1fr))]"
        style={{ '--n': items.length } as CSSProperties}
      >
        {items.map((s, i) => (
          <div
            key={i}
            className={cn(
              'min-w-0 pr-5',
              i % 2 === 1 && 'border-l border-line pl-5',
              i > 0 && '@xl:border-l @xl:border-line @xl:pl-6',
            )}
          >
            <Stat size={size} {...s} />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─── emphasis blocks ─────────────────────────────────────────────────────── */

/** The one thing to know. A calm block with a coloured label and larger text. */
export function Takeaway({
  label = 'In short',
  tone = 'peach',
  children,
  className,
}: {
  label?: ReactNode
  tone?: Tone
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn('relative overflow-hidden rounded-2xl border border-line bg-sheer px-5 py-5 md:px-7 md:py-6', className)}
      style={{ backgroundImage: `linear-gradient(100deg, ${toneMix(tone, 7)}, transparent 55%)` }}
    >
      <span aria-hidden className="absolute inset-y-5 left-0 w-[2px] rounded-full md:inset-y-6" style={{ background: toneColor(tone) }} />
      <div className="eyebrow mb-2.5 flex items-center gap-1.5" style={{ color: toneColor(tone) }}>
        <Diamond filled /> {label}
      </div>
      <div className="text-[18px] leading-[1.5] font-normal tracking-[-0.006em] text-pretty text-value md:text-[19.5px] md:leading-[1.5] [&_strong]:font-medium">
        {children}
      </div>
    </div>
  )
}

const CALLOUT: Record<string, { tone: Tone; label: string }> = {
  note: { tone: 'teal', label: 'Note' },
  warn: { tone: 'warn', label: 'Watch out' },
  question: { tone: 'peach', label: 'Open question' },
  good: { tone: 'good', label: 'Works' },
  bad: { tone: 'bad', label: 'Problem' },
}

/** A short aside in the text: note, warning, open question, or a good/bad outcome. */
export function Callout({
  kind = 'note',
  label,
  title,
  children,
  className,
}: {
  kind?: 'note' | 'warn' | 'question' | 'good' | 'bad'
  /** Overrides the eyebrow (defaults: Note, Watch out, Open question, Works, Problem). */
  label?: ReactNode
  title?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const c = CALLOUT[kind]
  return (
    <div
      role={kind === 'warn' || kind === 'bad' ? 'note' : undefined}
      className={cn('rounded-r-xl border-l-[1.5px] py-3.5 pr-4 pl-4 md:pl-5', className)}
      style={{ borderColor: toneColor(c.tone), background: toneMix(c.tone, 6) }}
    >
      <div className="eyebrow mb-1.5 flex items-center gap-1.5" style={{ color: toneColor(c.tone) }}>
        {kind === 'question' ? <Diamond /> : <span className="size-[6px] rounded-full bg-current" />}
        {label ?? c.label}
      </div>
      {title && <div className="text-[15.5px] leading-[1.45] font-medium text-strong">{title}</div>}
      {children && <div className={cn('text-[15px] leading-[1.55] text-body', title && 'mt-1')}>{children}</div>}
    </div>
  )
}

/**
 * A note that sits in the right margin on wide screens and inline on narrow ones.
 * Place it directly before the paragraph or block it belongs to.
 */
export function MarginNote({
  label,
  title,
  children,
  tone = 'peach',
  icon = 'diamond',
  className,
}: {
  label?: ReactNode
  title?: ReactNode
  children?: ReactNode
  tone?: Tone
  icon?: 'diamond' | 'dot' | 'none'
  className?: string
}) {
  return (
    <aside
      className={cn('kit-margin border-l pl-4 text-[13.5px] leading-[1.5]', className)}
      style={{ borderColor: toneMix(tone, 50) }}
    >
      {label && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium tracking-[0.12em] uppercase" style={{ color: toneColor(tone) }}>
          {icon === 'diamond' && <Diamond />}
          {icon === 'dot' && <span className="size-[5px] rounded-full bg-current" />}
          {label}
        </div>
      )}
      {title && <div className="font-medium text-strong">{title}</div>}
      {children && <div className={cn('text-quiet', title && 'mt-1')}>{children}</div>}
    </aside>
  )
}

/* ─── tags ────────────────────────────────────────────────────────────────── */

/** Small uppercase flag: status, owner, open question marker. */
export function Tag({
  children,
  tone = 'neutral',
  variant = 'outline',
  icon,
  className,
}: {
  children: ReactNode
  tone?: Tone
  variant?: 'outline' | 'soft'
  icon?: 'diamond' | 'dot'
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-[1.5px] align-[0.12em] text-[10.5px] leading-[15px] font-medium tracking-[0.08em] whitespace-nowrap uppercase',
        className,
      )}
      style={{
        color: toneColor(tone),
        borderColor: variant === 'outline' ? toneMix(tone, 40) : 'transparent',
        background: variant === 'soft' ? toneMix(tone, 13) : undefined,
      }}
    >
      {icon === 'diamond' && <Diamond className="size-[7px]" />}
      {icon === 'dot' && <span className="size-[5px] rounded-full bg-current" />}
      {children}
    </span>
  )
}

/** Normal-case pill for names and filters. Pass `onClick` to make it a toggle button. */
export function Chip({
  children,
  tone = 'neutral',
  selected,
  onClick,
  mono,
  className,
}: {
  children: ReactNode
  tone?: Tone
  selected?: boolean
  onClick?: () => void
  mono?: boolean
  className?: string
}) {
  const style: CSSProperties = selected
    ? { borderColor: toneMix(tone === 'neutral' ? 'teal' : tone, 55), background: toneMix(tone === 'neutral' ? 'teal' : tone, 12), color: 'var(--value)' }
    : tone !== 'neutral'
      ? { borderColor: toneMix(tone, 35), color: toneColor(tone) }
      : {}
  const cls = cn(
    'inline-flex items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-[3px] text-[12.5px] leading-[18px] whitespace-nowrap text-strong',
    mono && 'font-mono text-[11.5px]',
    onClick ? 'press cursor-pointer select-none hover:border-line-strong hover:bg-sheer-2' : 'transition-colors',
    className,
  )
  return onClick ? (
    <button type="button" aria-pressed={selected} onClick={onClick} className={cls} style={style}>
      {children}
    </button>
  ) : (
    <span className={cls} style={style}>
      {children}
    </span>
  )
}

/* ─── Disclosure ──────────────────────────────────────────────────────────── */

/**
 * Height + fade reveal used by Disclosure, Steps, Tracks and the diagram detail panels;
 * use it for your own expanders too. Pure CSS (grid 0fr → 1fr), so it costs nothing
 * in the bundle. Closed content stays in the DOM but is inert.
 */
export function Reveal({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        // open in 220ms, close faster (160ms): the reader has already decided
        'grid transition-[grid-template-rows,opacity] ease-out-soft motion-reduce:transition-opacity',
        open ? 'grid-rows-[1fr] opacity-100 duration-220' : 'grid-rows-[0fr] opacity-0 duration-160',
        className,
      )}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

/**
 * Animated expand/collapse: the main tool for progressive disclosure.
 * Stack several inside `DisclosureGroup` for a hairline list.
 */
export function Disclosure({
  label,
  meta,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  variant = 'line',
  className,
}: {
  label: ReactNode
  /** Quiet text at the right end of the row (count, owner, date). */
  meta?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** line: hairline row in the text flow. card: a rounded sheer box. */
  variant?: 'line' | 'card'
  className?: string
}) {
  const [inner, setInner] = useState(defaultOpen)
  const open = openProp ?? inner
  const set = (v: boolean) => {
    setInner(v)
    onOpenChange?.(v)
  }
  const id = useId()
  return (
    <div
      className={cn(
        variant === 'line' ? 'border-t border-line' : 'rounded-2xl border border-line bg-sheer px-4 md:px-5',
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => set(!open)}
        className="group press-row -mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-baseline gap-3 rounded-[10px] px-2 py-3.5 text-left select-none"
      >
        <PlusIcon open={open} className="relative top-[1px] text-quiet transition-colors group-hover:text-strong" />
        <span className="min-w-0 flex-1 text-[15px] leading-[1.4] font-medium text-strong decoration-line-strong underline-offset-4 group-hover:underline">
          {label}
        </span>
        {meta && <span className="shrink-0 text-[13px] text-quiet">{meta}</span>}
      </button>
      <div id={id}>
        <Reveal open={open}>
          <div className="pb-6 pl-6 text-[15px] leading-[1.6] text-body">{children}</div>
        </Reveal>
      </div>
    </div>
  )
}

/** Wraps consecutive line Disclosures so the list closes with a hairline. */
export function DisclosureGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('border-b border-line', className)}>{children}</div>
}

/* ─── Compare ─────────────────────────────────────────────────────────────── */

export type CompareColumn = { label: ReactNode; sub?: ReactNode; tone?: Tone }
export type CompareRow = { label: ReactNode; cells: ReactNode[]; note?: ReactNode }

/**
 * Side-by-side comparison: before/after, A/B, or options. A table on wide screens;
 * on phones every row becomes a small card with labelled values.
 */
export function Compare({
  columns,
  rows,
  emphasis,
  labelHeader = '',
  wide = true,
  className,
}: {
  columns: CompareColumn[]
  rows: CompareRow[]
  /** Index of the column to emphasise (e.g. the recommended option). */
  emphasis?: number
  labelHeader?: ReactNode
  wide?: boolean
  className?: string
}) {
  const grid = { gridTemplateColumns: `minmax(120px, 0.7fr) repeat(${columns.length}, minmax(0, 1fr))` }
  const em = emphasis != null ? columns[emphasis] : undefined
  const emTone = em?.tone ?? 'teal'
  return (
    <div data-wide={wide || undefined} className={cn('@container tnum', className)}>
      {/* table */}
      <div className="hidden @2xl:block">
        <div className={cn('relative', emphasis != null && 'pr-3')}>
          {emphasis != null && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-3 left-0 grid gap-x-6"
              style={grid}
            >
              <div
                className="-mx-3 rounded-xl border"
                style={{
                  gridColumn: emphasis + 2,
                  borderColor: toneMix(emTone, 30),
                  background: toneMix(emTone, 5),
                }}
              />
            </div>
          )}
          <div className="relative grid gap-x-6 border-b border-line-strong pt-3 pb-3" style={grid}>
            <div className="eyebrow self-end">{labelHeader}</div>
            {columns.map((c, i) => (
              <div key={i} className="min-w-0 self-end">
                <div className="eyebrow" style={c.tone ? { color: toneColor(c.tone) } : undefined}>
                  {c.label}
                </div>
                {c.sub && <div className="mt-0.5 text-[12.5px] text-quiet">{c.sub}</div>}
              </div>
            ))}
          </div>
          {rows.map((r, ri) => (
            <div key={ri} className={cn('relative grid gap-x-6 py-3.5', ri < rows.length - 1 && 'border-b border-line')} style={grid}>
              <div className="text-[14px] leading-[1.45] font-medium text-strong">
                {r.label}
                {r.note && <div className="mt-0.5 text-[12.5px] font-normal text-quiet">{r.note}</div>}
              </div>
              {columns.map((_, ci) => (
                <div key={ci} className={cn('min-w-0 text-[14px] leading-[1.5]', ci === emphasis ? 'text-strong' : 'text-body')}>
                  {r.cells[ci]}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      {/* cards */}
      <div className="flex flex-col gap-2.5 @2xl:hidden">
        {rows.map((r, ri) => (
          <div key={ri} className="rounded-xl border border-line bg-sheer px-4 py-3">
            <div className="text-[14.5px] font-medium text-strong">{r.label}</div>
            {r.note && <div className="text-[12.5px] text-quiet">{r.note}</div>}
            <dl className="mt-2 flex flex-col gap-1.5">
              {columns.map((c, ci) => (
                <div key={ci} className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
                  <dt
                    className="pt-[3px] text-[10.5px] leading-[15px] font-medium tracking-[0.1em] uppercase"
                    style={{ color: ci === emphasis ? toneColor(emTone) : 'rgb(var(--ink) / 0.45)' }}
                  >
                    {c.label}
                  </dt>
                  <dd className={cn('text-[14px] leading-[1.5]', ci === emphasis ? 'text-strong' : 'text-body')}>{r.cells[ci]}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─── Steps ───────────────────────────────────────────────────────────────── */

export type Step = { title: ReactNode; body?: ReactNode; meta?: ReactNode; tone?: Tone; detail?: ReactNode }

/** A numbered sequence with a rail, for when the order itself matters. Steps with `detail` expand. */
export function Steps({ items, start = 1, className }: { items: Step[]; start?: number; className?: string }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <ol className={cn('relative', className)}>
      {items.map((s, i) => {
        const isOpen = open === i
        const tone = s.tone ?? 'neutral'
        const head = (
          <>
            <span className="text-[15.5px] leading-[1.4] font-medium text-strong">{s.title}</span>
            {s.meta && <span className="ml-2 text-[13px] text-quiet">{s.meta}</span>}
          </>
        )
        return (
          <li key={i} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-4 pb-6 last:pb-0">
            {i < items.length - 1 && (
              <span aria-hidden className="absolute top-[30px] bottom-[2px] left-[13.5px] w-px bg-line-strong" />
            )}
            <span
              className="tnum relative z-[1] grid size-7 place-items-center rounded-full border bg-bg text-[12px] font-medium"
              style={{ borderColor: tone === 'neutral' ? 'rgb(var(--ink) / 0.22)' : toneMix(tone, 60), color: toneColor(tone, 'rgb(var(--ink) / 0.7)') }}
            >
              {start + i}
            </span>
            <div className="min-w-0 pt-[3px]">
              {s.detail ? (
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="group flex w-full cursor-pointer items-baseline gap-3 text-left"
                >
                  <span className="min-w-0 flex-1 decoration-line-strong underline-offset-4 group-hover:[&>span:first-child]:underline">{head}</span>
                  <PlusIcon open={isOpen} className="relative top-[2px] text-quiet group-hover:text-strong" />
                </button>
              ) : (
                <div>{head}</div>
              )}
              {s.body && <div className="mt-1 text-[14.5px] leading-[1.55] text-quiet">{s.body}</div>}
              {s.detail && (
                <Reveal open={isOpen}>
                  <div className="pt-3 text-[14.5px] leading-[1.6] text-body">{s.detail}</div>
                </Reveal>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/* ─── KeyValue ────────────────────────────────────────────────────────────── */

export type KV = { k: ReactNode; v: ReactNode; mono?: boolean; note?: ReactNode }

/** Labelled facts: config, identifiers, owners. One or two columns; stacks on phones. */
export function KeyValue({ items, cols = 1, className }: { items: KV[]; cols?: 1 | 2; className?: string }) {
  return (
    <dl data-wide={cols === 2 || undefined} className={cn('@container tnum', className)}>
      <div className={cn('grid gap-x-10', cols === 2 && '@2xl:grid-cols-2')}>
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-1 gap-x-6 gap-y-0.5 border-t border-line py-2.5 @md:grid-cols-[minmax(110px,0.45fr)_minmax(0,1fr)]">
            <dt className="text-[13.5px] leading-[1.5] text-quiet">{it.k}</dt>
            <dd className="min-w-0">
              <span className={cn('text-[14.5px] leading-[1.5] text-strong', it.mono && 'font-mono text-[13px] [overflow-wrap:anywhere]')}>{it.v}</span>
              {it.note && <div className="text-[12.5px] leading-[1.45] text-quiet">{it.note}</div>}
            </dd>
          </div>
        ))}
      </div>
    </dl>
  )
}

/* ─── Legend ──────────────────────────────────────────────────────────────── */

export type LegendItem = { label: ReactNode; tone?: Tone; /** Any CSS colour; overrides tone. */ color?: string; kind?: 'line' | 'dashed' | 'box' | 'dot' | 'hatch' }

/** Small key for diagrams and charts. */
export function Legend({ items, className }: { items: LegendItem[]; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-quiet', className)}>
      {items.map((it, i) => {
        const c = it.color ?? toneColor(it.tone ?? 'neutral', 'rgb(var(--ink) / 0.45)')
        const kind = it.kind ?? 'box'
        return (
          <span key={i} className="inline-flex items-center gap-2">
            {kind === 'line' || kind === 'dashed' ? (
              <svg width="18" height="6" aria-hidden>
                <path d="M1 3h16" stroke={c} strokeWidth="1.5" strokeDasharray={kind === 'dashed' ? '3 3' : undefined} strokeLinecap="round" />
              </svg>
            ) : kind === 'dot' ? (
              <span className="size-[7px] rounded-full" style={{ background: c }} />
            ) : (
              <span
                className={cn('h-[10px] w-[14px] rounded-[3px] border', kind === 'hatch' && 'hatch')}
                style={{ borderColor: it.tone ? toneMix(it.tone, 60) : 'rgb(var(--ink) / 0.22)', background: kind === 'box' ? (it.tone ? toneMix(it.tone, 16) : 'rgb(var(--ink) / 0.05)') : undefined }}
              />
            )}
            {it.label}
          </span>
        )
      })}
    </div>
  )
}
