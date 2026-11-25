/**
 * Dashboards: data that loads in the page and stays fresh, and the parts that show it.
 * Import from '@/kit/dashboard'. Charts come from '@/kit/charts'.
 *
 *   const signups = useDataset({ id: 'signups', title: 'Signups per day', source: 'Amplitude',
 *     load: () => nap.amplitude.segmentation(…), refresh: 300 })
 *   <Dashboard title="Signups" range="Last 30 days">
 *     <DashGrid cols={3}>
 *       <Metric dataset={signups} label="Signups" value={(d) => d.total} compare={(d) => d.previous} />
 *     </DashGrid>
 *     <Panel title="Signups per day" dataset={signups}>{(d) => <LineChart data={d.rows} … />}</Panel>
 *   </Dashboard>
 *
 * A dataset is one thing the page loads, with a name and where it comes from. It refreshes on a
 * timer, waits while the tab is hidden, and keeps the last numbers when a refresh fails. Every
 * part that shows it gets the loading, empty, error and stale states from it, and the Dashboard
 * lists all of them under Sources, with how old each is.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/kit/ui/popover'
import { Num } from './content'
import { cn, toneColor, type Tone } from './lib'

/* ─── datasets ─────────────────────────────────────────────────────────────── */

export type DatasetOptions<T> = {
  /** A stable id, unique on the page. */
  id: string
  /** What it is, for the Sources list: "Signups per day". */
  title: string
  /** Where it comes from, in a few words: "Amplitude", "data.json", "collection signups". */
  source?: string
  /** A link to the source, such as the chart in the tool the numbers come from. */
  link?: string
  /** Loads the data. Rejecting, or throwing, is a failed load; `signal` aborts a load that is no longer wanted. */
  load: (context: { signal: AbortSignal }) => Promise<T>
  /**
   * Seconds between refreshes while the page is visible. Default 300; 0 loads once. Keep it at
   * a minute or more unless the data changes faster.
   */
  refresh?: number
  /** Seconds after which the data counts as stale. Default: three refreshes, or never when `refresh` is 0. */
  staleAfter?: number
  /** Values the load depends on, such as the chosen range. A change loads again and shows the loading state. */
  deps?: ReadonlyArray<unknown>
  /** False while the dataset should not load yet. */
  enabled?: boolean
}

export type Dataset<T> = {
  id: string
  title: string
  source?: string
  link?: string
  /** `loading` until the first load ends, then `ready`, or `error` when there is nothing to show. */
  status: 'loading' | 'ready' | 'error'
  /** The last data that loaded. It stays while a refresh runs or fails. */
  data: T | undefined
  /** Why the last load failed. With `data`, the numbers shown are older than they should be. */
  error: string | undefined
  /** When `data` loaded. */
  updatedAt: Date | undefined
  /** True when `data` is older than `staleAfter`, or the last refresh failed. */
  stale: boolean
  /** True while a refresh runs behind data that is already shown. */
  refreshing: boolean
  /** Loads again now. */
  reload: () => void
}

type AnyDataset = Dataset<unknown>

/**
 * Every dataset on the page, for the Sources list. It is the page's, not a React context,
 * because pages call useDataset above the <Dashboard> that shows them.
 */
const registry = (() => {
  let datasets: Record<string, AnyDataset> = {}
  const listeners = new Set<() => void>()
  const changed = (next: Record<string, AnyDataset>) => {
    datasets = next
    listeners.forEach((listener) => listener())
  }
  return {
    get: () => datasets,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    set: (dataset: AnyDataset) => datasets[dataset.id] !== dataset && changed({ ...datasets, [dataset.id]: dataset }),
    remove: (id: string) => {
      if (!(id in datasets)) return
      const { [id]: _gone, ...rest } = datasets
      changed(rest)
    },
  }
})()

/** A clock that ticks every half minute, so ages ("3 min ago") and stale marks stay right. */
function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

/** "just now", "3 min ago", "2 h ago", "4 d ago". */
export function ago(date: Date | undefined, now = Date.now()) {
  if (!date) return 'never'
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000))
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)) || 'Could not load'

/**
 * One thing the page loads and keeps fresh. The page's <Dashboard> lists it under Sources.
 * Refreshes run in place: the old data stays until the new data is there.
 */
export function useDataset<T>(options: DatasetOptions<T>): Dataset<T> {
  const { id, title, source, link, refresh = 300, enabled = true } = options
  const staleAfter = options.staleAfter ?? (refresh > 0 ? refresh * 3 : Infinity)
  const deps = options.deps ?? []
  const [state, setState] = useState<{ data: T | undefined; error: string | undefined; updatedAt: Date | undefined; loading: boolean }>({
    data: undefined,
    error: undefined,
    updatedAt: undefined,
    loading: true,
  })
  const load = useRef(options.load)
  load.current = options.load
  const running = useRef<AbortController | null>(null)
  const loadedAt = useRef(0)

  const run = useCallback((reset: boolean) => {
    running.current?.abort()
    const controller = new AbortController()
    running.current = controller
    setState((old) => (reset ? { data: undefined, error: undefined, updatedAt: undefined, loading: true } : { ...old, loading: true }))
    Promise.resolve()
      .then(() => load.current({ signal: controller.signal }))
      .then(
        (data) => {
          if (controller.signal.aborted) return
          loadedAt.current = Date.now()
          setState({ data, error: undefined, updatedAt: new Date(), loading: false })
        },
        (error) => {
          if (controller.signal.aborted) return
          loadedAt.current = Date.now() // wait a full interval before the next try
          setState((old) => ({ ...old, error: message(error), loading: false }))
        },
      )
  }, [])

  // The first load, and again when what it depends on changes.
  useEffect(() => {
    if (!enabled) return
    run(true)
    return () => running.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run, ...deps])

  // The timer: not while the tab is hidden, and at once when it shows again with old data.
  useEffect(() => {
    if (!enabled || refresh <= 0) return
    const every = Math.max(5, refresh) * 1000
    const due = () => !document.hidden && Date.now() - loadedAt.current >= every - 500
    const timer = setInterval(() => due() && run(false), Math.min(every, 15_000))
    const onVisible = () => due() && run(false)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refresh, run])

  const now = useNow()
  const reload = useCallback(() => run(false), [run])
  const has = state.data !== undefined
  const dataset = useMemo<Dataset<T>>(
    () => ({
      id,
      title,
      source,
      link,
      status: has ? 'ready' : state.error ? 'error' : 'loading',
      data: state.data,
      error: state.error,
      updatedAt: state.updatedAt,
      stale: has && (Boolean(state.error) || now - (state.updatedAt?.getTime() ?? now) > staleAfter * 1000),
      refreshing: has && state.loading,
      reload,
    }),
    [id, title, source, link, has, state, now, staleAfter, reload],
  )

  useEffect(() => {
    registry.set(dataset as AnyDataset)
  }, [dataset])
  useEffect(() => () => registry.remove(id), [id])
  return dataset
}

/* ─── the page ─────────────────────────────────────────────────────────────── */

/** True with ?wall in the address: a screen on a wall, with no one to click. */
const wallFromAddress = () => typeof location !== 'undefined' && new URLSearchParams(location.search).has('wall')

/** How much to enlarge the page on a big screen in wall mode, so it reads from across a room. */
function useWallScale(on: boolean, designWidth: number) {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    if (!on) return setScale(1)
    const fit = () => setScale(Math.min(3, Math.max(1, window.innerWidth / designWidth)))
    fit()
    addEventListener('resize', fit)
    return () => removeEventListener('resize', fit)
  }, [on, designWidth])
  return scale
}

/**
 * The dashboard's shell: a header with the title, the range the numbers cover, how fresh they
 * are and where they come from, then your numbers and charts. Use it instead of <Page>.
 */
export function Dashboard({
  title,
  eyebrow,
  range,
  controls,
  wall = wallFromAddress(),
  wallWidth = 1440,
  children,
  className,
}: {
  title: ReactNode
  eyebrow?: ReactNode
  /** The time the numbers cover, always visible: "Last 30 days", or a <RangePicker>. */
  range?: ReactNode
  /** Other controls for the header, such as filters. Hidden in wall mode. */
  controls?: ReactNode
  /**
   * Wall mode, for a screen left on: no controls, and everything enlarged to fill a big screen.
   * Default: on when the address has ?wall.
   */
  wall?: boolean
  /** The width the layout is designed for; wall mode enlarges from there. */
  wallWidth?: number
  children: ReactNode
  className?: string
}) {
  const list = Object.values(useSyncExternalStore(registry.subscribe, registry.get))
  const scale = useWallScale(wall, wallWidth)
  return (
    <>
      <div
        data-wall={wall || undefined}
        className={cn('@container mx-auto w-full max-w-[1600px] px-5 py-6 md:px-8 md:py-8', wall && 'max-w-none', className)}
        style={scale !== 1 ? { zoom: scale } : undefined}
      >
        <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 md:mb-8">
          <div className="min-w-0">
            {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
            <h1 className="text-[24px] leading-[1.15] font-normal tracking-[-0.02em] text-balance text-value md:text-[30px]">{title}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-quiet">
            {range && <div className="text-strong">{range}</div>}
            {!wall && controls}
            <Freshness datasets={list} interactive={!wall} />
          </div>
        </header>
        <div className="flex flex-col gap-4 md:gap-5">{children}</div>
      </div>
    </>
  )
}

/** "Updated 3 min ago", by the oldest dataset, with the Sources list behind it. */
function Freshness({ datasets, interactive }: { datasets: AnyDataset[]; interactive: boolean }) {
  const now = useNow()
  if (datasets.length === 0) return null
  const loaded = datasets.filter((d) => d.updatedAt)
  const oldest = loaded.reduce<Date | undefined>((min, d) => (!min || d.updatedAt! < min ? d.updatedAt : min), undefined)
  const failed = datasets.filter((d) => d.error)
  const stale = datasets.some((d) => d.stale)
  const busy = datasets.some((d) => d.status === 'loading' || d.refreshing)
  const label = !oldest ? (failed.length ? 'Could not load' : 'Loading…') : `Updated ${ago(oldest, now)}${failed.length ? ', retrying' : ''}`
  const tone: Tone = failed.length ? 'bad' : stale ? 'warn' : 'good'
  const summary = (
    <span className="inline-flex items-center gap-2 tnum">
      <span className={cn('size-1.5 rounded-full', busy && 'animate-pulse')} style={{ background: toneColor(tone) }} aria-hidden />
      {label}
    </span>
  )
  if (!interactive) return summary
  return (
    <Popover>
      <PopoverTrigger className="press cursor-pointer rounded-full border border-line px-3 py-1.5 text-[13px] text-body hover:bg-sheer-2">{summary}</PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,380px)] gap-0 p-0">
        <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-2.5">
          <span className="eyebrow">Sources</span>
          <button type="button" className="press cursor-pointer rounded-full px-2 py-0.5 text-[12.5px] text-quiet hover:bg-sheer-2 hover:text-strong" onClick={() => datasets.forEach((d) => d.reload())}>
            Refresh all
          </button>
        </div>
        <ul className="max-h-[60vh] overflow-y-auto py-1">
          {datasets.map((d) => (
            <li key={d.id} className="flex items-start gap-2.5 px-3.5 py-2">
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full" style={{ background: toneColor(d.error ? 'bad' : d.stale ? 'warn' : d.updatedAt ? 'good' : 'neutral') }} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] text-strong">{d.title}</div>
                <div className="text-[12.5px] leading-[1.45] text-quiet">
                  {d.source &&
                    (d.link ? (
                      <a href={d.link} className="underline decoration-line-strong underline-offset-2">
                        {d.source}
                      </a>
                    ) : (
                      d.source
                    ))}
                  {d.source && ' · '}
                  <span className="tnum">{d.updatedAt ? ago(d.updatedAt, now) : d.status === 'loading' ? 'loading' : 'not loaded'}</span>
                </div>
                {d.error && <div className="mt-0.5 text-[12.5px] leading-[1.45] text-bad">{d.error}</div>}
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

const GRID_COLS = {
  1: '',
  2: '@2xl:grid-cols-2',
  3: '@2xl:grid-cols-2 @5xl:grid-cols-3',
  4: '@xl:grid-cols-2 @5xl:grid-cols-4',
  6: '@md:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-6',
}

/** A grid that goes from one column on a phone to `cols` on a wide screen, by its own width. */
export function DashGrid({ cols = 3, children, className }: { cols?: keyof typeof GRID_COLS; children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-1 gap-4 md:gap-5', GRID_COLS[cols], className)}>{children}</div>
}

/* ─── states ───────────────────────────────────────────────────────────────── */

const isEmpty = (data: unknown) => data == null || (Array.isArray(data) && data.length === 0)

/** The small mark that says the numbers shown are old. */
function StaleMark({ dataset }: { dataset: AnyDataset }) {
  const now = useNow()
  if (!dataset.stale) return null
  return (
    <span className="shrink-0 rounded-full px-2 py-0.5 text-[11.5px] leading-[1.4] tnum text-warn" style={{ background: 'color-mix(in oklab, var(--warn) 12%, transparent)' }}>
      {ago(dataset.updatedAt, now)}
      {dataset.error ? ', retrying' : ''}
    </span>
  )
}

function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-sheer-2 motion-reduce:animate-none', className)} aria-hidden />
}

/* ─── panel ────────────────────────────────────────────────────────────────── */

/**
 * A titled card for a chart or table. Give it a dataset and a function that draws the data;
 * it shows the loading, empty and error states itself and marks old data. Without a dataset it
 * is only the card.
 */
export function Panel<T>({
  title,
  note,
  dataset,
  empty = isEmpty,
  emptyText = 'No data in this range',
  height = 260,
  span,
  actions,
  children,
  className,
}: {
  /** Says what the chart shows: "Signups per day, last 30 days". */
  title: ReactNode
  /** A line below the title: the unit, the definition, a caveat. */
  note?: ReactNode
  dataset?: Dataset<T>
  /** When the data counts as empty. Default: null, undefined, or an empty array. */
  empty?: (data: T) => boolean
  emptyText?: ReactNode
  /** The height kept for the loading, empty and error states, so the layout does not jump. */
  height?: number
  /** Columns the panel spans in a DashGrid. */
  span?: 2 | 3 | 'full'
  /** Controls in the panel's corner. */
  actions?: ReactNode
  children: ReactNode | ((data: T) => ReactNode)
  className?: string
}) {
  const body = () => {
    if (typeof children !== 'function') return children
    if (!dataset) return null
    if (dataset.status === 'loading') return <Skeleton className="w-full" />
    if (dataset.status === 'error') {
      return (
        <State>
          <div className="text-strong">Could not load</div>
          <div className="mt-1 text-quiet">{dataset.error}</div>
          <button type="button" className="press mt-3 cursor-pointer rounded-full border border-line-strong px-3 py-1 text-[12.5px] text-strong hover:bg-sheer-2" onClick={dataset.reload}>
            Try again
          </button>
        </State>
      )
    }
    const data = dataset.data as T
    if (empty(data)) return <State>{emptyText}</State>
    return children(data)
  }
  const stateful = typeof children === 'function' && dataset && (dataset.status !== 'ready' || empty(dataset.data as T))
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col rounded-xl border border-line bg-sheer p-4 md:p-5',
        span === 2 && '@2xl:col-span-2',
        span === 3 && '@2xl:col-span-2 @5xl:col-span-3',
        span === 'full' && 'col-span-full',
        className,
      )}
      aria-busy={dataset?.status === 'loading' || dataset?.refreshing || undefined}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] leading-[1.35] font-medium text-strong">{title}</h2>
          {note && <div className="mt-0.5 text-[13px] leading-[1.45] text-quiet">{note}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dataset && <StaleMark dataset={dataset as AnyDataset} />}
          {actions}
        </div>
      </div>
      <div className={cn('min-w-0 flex-1', stateful && 'flex')} style={stateful ? { minHeight: height } : undefined}>
        {body()}
      </div>
    </section>
  )
}

function State({ children }: { children: ReactNode }) {
  return <div className="flex w-full flex-col items-center justify-center rounded-lg border border-dashed border-line px-4 text-center text-[13.5px] leading-[1.45] text-quiet">{children}</div>
}

/* ─── metric ───────────────────────────────────────────────────────────────── */

/**
 * One number that matters, with its unit and what it compares to: "412 signups, +8 % on last
 * week". Give it a dataset and functions that pick the values, or plain values.
 */
export function Metric<T>({
  label,
  dataset,
  value,
  compare,
  compareLabel = 'on the period before',
  format = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 1 }),
  pre,
  unit,
  goodWhen = 'up',
  note,
  className,
}: {
  label: ReactNode
  dataset?: Dataset<T>
  /** The number, or how to get it from the dataset. */
  value: number | null | ((data: T) => number | null | undefined)
  /** The number it compares to (the period before, a target), or how to get it. Shown as a change in percent. */
  compare?: number | null | ((data: T) => number | null | undefined)
  /** What the change is measured against: "on last week". */
  compareLabel?: ReactNode
  format?: (value: number) => string
  pre?: ReactNode
  unit?: ReactNode
  /** Which direction is good, for the colour of the change. `none` keeps it neutral. */
  goodWhen?: 'up' | 'down' | 'none'
  note?: ReactNode
  className?: string
}) {
  const pick = (from: typeof value | typeof compare) => (typeof from === 'function' ? (dataset?.data !== undefined ? from(dataset.data) : undefined) : from)
  const current = pick(value)
  const before = pick(compare)
  const loading = dataset?.status === 'loading'
  const failed = dataset?.status === 'error'
  const change = current != null && before != null && before !== 0 ? (current - before) / Math.abs(before) : null
  const tone: Tone = change == null || change === 0 || goodWhen === 'none' ? 'neutral' : change > 0 === (goodWhen === 'up') ? 'good' : 'bad'
  return (
    <div className={cn('min-w-0 rounded-xl border border-line bg-sheer p-4 md:p-5', className)} aria-busy={loading || undefined}>
      <div className="mb-2.5 flex min-h-[22px] items-center justify-between gap-2">
        <div className="eyebrow truncate">{label}</div>
        {dataset && <StaleMark dataset={dataset as AnyDataset} />}
      </div>
      {loading ? (
        <Skeleton className="h-[38px] w-2/3 md:h-[44px]" />
      ) : failed ? (
        <div className="text-[13.5px] leading-[1.45] text-bad">
          Could not load: {dataset?.error}{' '}
          <button type="button" className="cursor-pointer underline underline-offset-2" onClick={dataset?.reload}>
            Try again
          </button>
        </div>
      ) : (
        <div className="text-[34px] leading-[1.1] font-light tracking-[-0.03em] md:text-[40px]">
          {current == null ? <span className="text-faint">–</span> : <Num value={format(current)} pre={pre} unit={unit} />}
        </div>
      )}
      {!loading && !failed && (change != null || note) && (
        <div className="mt-2 text-[13px] leading-[1.45] text-quiet">
          {change != null && (
            <>
              <span className="tnum font-medium" style={{ color: toneColor(tone, 'rgb(var(--ink) / 0.76)') }}>
                {change > 0 ? '+' : change < 0 ? '−' : ''}
                {Math.abs(change * 100).toLocaleString('en-US', { maximumFractionDigits: Math.abs(change) < 0.1 ? 1 : 0 })} %
              </span>{' '}
              {compareLabel}
              {note && ' · '}
            </>
          )}
          {note}
        </div>
      )}
    </div>
  )
}

/* ─── range ────────────────────────────────────────────────────────────────── */

export type RangeOption = { id: string; label: ReactNode }

/** A row of ranges to pick from ("7 days", "30 days", "90 days"). Put the choice in a dataset's `deps`. */
export function RangePicker({
  options,
  value,
  onChange,
  label = 'Range',
  className,
}: {
  options: RangeOption[]
  value: string
  onChange: (id: string) => void
  /** For screen readers. */
  label?: string
  className?: string
}) {
  // In wall mode the header shows the chosen range as text; there is no one to click.
  const wall = typeof document !== 'undefined' && wallFromAddress()
  if (wall) return <span>{options.find((o) => o.id === value)?.label}</span>
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-full border border-line p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          onClick={() => onChange(o.id)}
          className={cn('press cursor-pointer rounded-full px-3 py-1 text-[13px] whitespace-nowrap', o.id === value ? 'bg-sheer-2 text-value' : 'text-quiet hover:text-strong')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
