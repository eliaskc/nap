import { LayoutGroup, motion } from 'motion/react'
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn, ease } from './lib'

/* ─── Segmented ───────────────────────────────────────────────────────────── */

export type SegmentOption = { id: string; label: ReactNode }

/** Segmented control (radio group) with a sliding highlight. Arrow keys move between options. */
export function Segmented({
  options,
  value,
  onChange,
  size = 'md',
  label,
  className,
}: {
  options: SegmentOption[]
  value: string
  onChange: (id: string) => void
  size?: 'sm' | 'md'
  /** Accessible name for the group. */
  label?: string
  className?: string
}) {
  const id = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const j = (i + d + options.length) % options.length
    onChange(options[j].id)
    refs.current[j]?.focus()
  }
  return (
    <LayoutGroup id={id}>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn('inline-flex max-w-full overflow-x-auto rounded-full border border-line bg-sheer p-[3px] [scrollbar-width:none]', className)}
      >
        {options.map((o, i) => {
          const on = o.id === value
          return (
            <button
              key={o.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(o.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                'relative cursor-pointer rounded-full whitespace-nowrap transition-colors duration-200 select-none focus-visible:outline-offset-0',
                size === 'sm' ? 'px-3 py-1 text-[12.5px]' : 'px-4 py-1.5 text-[13.5px]',
                on ? 'text-value' : 'text-quiet hover:text-strong',
              )}
            >
              {on && (
                <motion.span
                  layoutId="seg"
                  className="absolute inset-0 rounded-full border border-line-strong bg-paper shadow-[0_1px_2px_rgb(0_0_0/0.06)]"
                  transition={{ duration: 0.32, ease }}
                />
              )}
              {/* press scales the label, not the button, so the sliding highlight measures true */}
              <span className="press relative block font-medium">{o.label}</span>
            </button>
          )
        })}
      </div>
    </LayoutGroup>
  )
}

/* ─── StageSwitcher ───────────────────────────────────────────────────────── */

export type Stage = { id: string; label: ReactNode; caption?: ReactNode; content?: ReactNode }

/**
 * A segmented control that swaps between states of the same thing: Today / After B /
 * After C. Give each stage `content`, or pass `children(stageId)` to render one view
 * that changes with the stage (e.g. a Flow whose `highlight` depends on it).
 */
export function StageSwitcher({
  stages,
  children,
  defaultStage,
  label,
  className,
}: {
  stages: Stage[]
  children?: (stageId: string, index: number) => ReactNode
  defaultStage?: string
  /** Text before the control, e.g. "Show". */
  label?: ReactNode
  className?: string
}) {
  const [cur, setCur] = useState(defaultStage ?? stages[0]?.id)
  // the first stage is there when the page opens; only later swaps fade in
  const [swapped, setSwapped] = useState(false)
  const pick = (id: string) => {
    setSwapped(true)
    setCur(id)
  }
  const fade = swapped ? { opacity: 0 } : false
  const i = Math.max(0, stages.findIndex((s) => s.id === cur))
  const stage = stages[i]
  return (
    <div data-wide className={cn('min-w-0', className)}>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {label && <span className="eyebrow">{label}</span>}
        <Segmented options={stages.map((s) => ({ id: s.id, label: s.label }))} value={stage.id} onChange={pick} label={typeof label === 'string' ? label : 'Stage'} />
      </div>
      {children ? (
        children(stage.id, i)
      ) : (
        // swap at once and fade only the new view in: readers flip back and forth to compare
        <motion.div key={stage.id} initial={fade} animate={{ opacity: 1 }} transition={{ duration: 0.15, ease }}>
          {stage.content}
        </motion.div>
      )}
      {stage.caption && (
        <motion.p
          key={stage.id}
          initial={fade}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15, ease }}
          className="mt-3 max-w-[680px] text-[14px] leading-[1.55] text-quiet"
        >
          {stage.caption}
        </motion.p>
      )}
    </div>
  )
}

/* ─── Picker ──────────────────────────────────────────────────────────────── */

export type PickerOption = { id: string; label: ReactNode; sub?: ReactNode; meta?: ReactNode }

/**
 * Choose one option from a list and see what it means: the list sits beside the view
 * on wide screens and above it on phones. `children(option)` renders the view, e.g. a
 * Flow with `highlight` set to that option's path.
 */
export function Picker<T extends PickerOption>({
  options,
  children,
  defaultOption,
  label = 'Pick one',
  className,
}: {
  options: T[]
  children: (option: T) => ReactNode
  defaultOption?: string
  label?: ReactNode
  className?: string
}) {
  const [cur, setCur] = useState(defaultOption ?? options[0]?.id)
  const opt = options.find((o) => o.id === cur) ?? options[0]
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const j = (i + d + options.length) % options.length
    setCur(options[j].id)
    refs.current[j]?.focus()
  }
  return (
    <div data-wide className={cn('@container min-w-0', className)}>
      <div className="grid gap-5 @3xl:grid-cols-[232px_minmax(0,1fr)] @3xl:gap-8">
        <div>
          <div className="eyebrow mb-2.5">{label}</div>
          <div role="radiogroup" aria-label={typeof label === 'string' ? label : 'Options'} className="flex flex-wrap gap-1.5 @3xl:flex-col @3xl:gap-0">
            {options.map((o, i) => {
              const on = o.id === opt.id
              return (
                <button
                  key={o.id}
                  ref={(el) => {
                    refs.current[i] = el
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setCur(o.id)}
                  onKeyDown={(e) => onKey(e, i)}
                  className={cn(
                    'press relative cursor-pointer text-left select-none [--press-duration:200ms] @3xl:active:scale-100 @3xl:active:bg-sheer',
                    // phones: chips · wide: list rows with a rail
                    'rounded-full border px-3 py-1.5 text-[13px] @3xl:rounded-none @3xl:border-0 @3xl:border-l @3xl:py-2.5 @3xl:pr-2 @3xl:pl-4',
                    on
                      ? 'border-teal/60 bg-teal/10 text-value @3xl:border-teal @3xl:bg-transparent'
                      : 'border-line-strong text-quiet hover:text-strong @3xl:border-line',
                  )}
                >
                  <span className="block text-[13.5px] leading-[1.35] font-medium">{o.label}</span>
                  {o.sub && <span className="hidden text-[12px] leading-[1.4] text-quiet @3xl:mt-0.5 @3xl:block">{o.sub}</span>}
                </button>
              )
            })}
          </div>
        </div>
        <div className="min-w-0">{children(opt)}</div>
      </div>
    </div>
  )
}
