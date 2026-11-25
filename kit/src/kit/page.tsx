import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { cn, slug, toneColor, type Tone } from './lib'

/* ─── index registry ──────────────────────────────────────────────────────── */

type Entry = { key: string; id: string; label: ReactNode; level: 2 | 3 }
type Registry = { register: (e: Entry) => () => void }
const IndexCtx = createContext<Registry | null>(null)

/**
 * The page shell: faint glow, a readable column and, on wide screens, a sticky side
 * index built from the `Section`s inside it. Put everything inside one `Page`.
 *
 * Direct children flow in the text column (680px max). Diagrams, charts, `Wide` and
 * `Section` span the full content width. `MarginNote`s float into the right margin when
 * there is room, and sit inline otherwise.
 */
export function Page({
  children,
  index = true,
  indexTitle,
  indexFooter,
  glow = true,
  className,
}: {
  children: ReactNode
  /** Show the sticky side index (desktop only). Needs at least two indexed sections. */
  index?: boolean
  /** Small text above the index, usually the document's short name. */
  indexTitle?: ReactNode
  /** Anything under the index: a count of open questions, a link, a date. */
  indexFooter?: ReactNode
  /** The faint warm/teal background glow. */
  glow?: boolean
  className?: string
}) {
  const [entries, setEntries] = useState<Entry[]>([])
  const register = useCallback((e: Entry) => {
    setEntries((xs) => [...xs.filter((x) => x.key !== e.key), e])
    return () => setEntries((xs) => xs.filter((x) => x.key !== e.key))
  }, [])
  const registry = useMemo(() => ({ register }), [register])

  // document order, not registration order
  const ordered = useMemo(() => {
    const pos = (id: string) => document.getElementById(id)
    return [...entries].sort((a, b) => {
      const A = pos(a.id)
      const B = pos(b.id)
      if (!A || !B) return 0
      return A.compareDocumentPosition(B) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })
  }, [entries])

  const active = useActive(ordered.map((e) => e.id))
  const showIndex = index && ordered.length > 1

  return (
    <IndexCtx.Provider value={registry}>
      <div className={cn('relative isolate min-h-full', className)}>
        {glow && <div className="kit-glow" aria-hidden />}
        <div
          className={cn(
            'relative z-[1] mx-auto max-w-[1320px] px-5 pt-10 pb-24 sm:px-8 md:pt-16 lg:px-12 xl:px-14',
            showIndex && 'lg:grid lg:grid-cols-[176px_minmax(0,1fr)] lg:gap-x-14 xl:grid-cols-[196px_minmax(0,1fr)] xl:gap-x-16',
          )}
        >
          {showIndex && (
            <nav aria-label="On this page" className="hidden lg:block">
              <div className="sticky top-10 flex max-h-[calc(100dvh-5rem)] flex-col gap-8 overflow-y-auto pb-4">
                {indexTitle && <div className="pr-2 text-[13px] leading-[1.45] text-quiet">{indexTitle}</div>}
                <ol className="flex flex-col">
                  {ordered.map((e) => {
                    const on = e.id === active
                    return (
                      <li key={e.key}>
                        <a
                          href={`#${e.id}`}
                          aria-current={on ? 'location' : undefined}
                          className={cn(
                            'relative block border-l py-[7px] leading-[1.35] transition-colors duration-300',
                            e.level === 2 ? 'pl-4 text-[13.5px]' : 'pl-7 text-[12.5px]',
                            on
                              ? 'border-orange text-value'
                              : 'border-line text-quiet hover:border-line-strong hover:text-strong',
                          )}
                        >
                          {e.label}
                        </a>
                      </li>
                    )
                  })}
                </ol>
                {indexFooter && <div className="text-[12.5px] leading-[1.45] text-quiet">{indexFooter}</div>}
              </div>
            </nav>
          )}
          <main className={cn('kit-flow min-w-0', showIndex ? 'max-w-[980px]' : 'mx-auto max-w-[980px]')}>
            <div className="kit-flow-inner">{children}</div>
          </main>
        </div>
      </div>
    </IndexCtx.Provider>
  )
}

function useActive(ids: string[]) {
  const [active, setActive] = useState<string | undefined>(ids[0])
  const key = ids.join('|')
  useEffect(() => {
    if (!ids.length) return
    let raf = 0
    const run = () => {
      raf = 0
      const line = Math.min(window.innerHeight * 0.3, 240)
      let cur = ids[0]
      for (const id of ids) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= line) cur = id
      }
      // at the very bottom, the last section is the one being read
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = ids[ids.length - 1]
      setActive(cur)
    }
    const on = () => (raf ||= requestAnimationFrame(run))
    run()
    window.addEventListener('scroll', on, { passive: true })
    window.addEventListener('resize', on)
    return () => {
      window.removeEventListener('scroll', on)
      window.removeEventListener('resize', on)
      cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return active
}

/* ─── Section ─────────────────────────────────────────────────────────────── */

/**
 * A titled part of the page. Registers itself in the side index.
 * Children flow like the page: text column, wide blocks, margin notes.
 */
export function Section({
  id,
  eyebrow,
  title,
  lede,
  index,
  level = 2,
  children,
  className,
}: {
  /** Anchor id. Defaults to a slug of `index` or `title` when they are strings. */
  id?: string
  eyebrow?: ReactNode
  title?: ReactNode
  lede?: ReactNode
  /** Label in the side index. Defaults to `title` if it is a string; `false` hides it. */
  index?: ReactNode | false
  /** 2 = main section (big Light title), 3 = subsection (smaller title, indented in the index). */
  level?: 2 | 3
  children?: ReactNode
  className?: string
}) {
  const reg = useContext(IndexCtx)
  const key = useId()
  const label = index === false ? null : (index ?? (typeof title === 'string' ? title : null))
  const anchor =
    id ?? (typeof label === 'string' ? slug(label) : typeof title === 'string' ? slug(title) : `s${key.replace(/:/g, '')}`)

  useLayoutEffect(() => {
    if (!reg || label == null) return
    return reg.register({ key, id: anchor, label, level })
  }, [reg, key, anchor, label, level])

  const H = level === 2 ? 'h2' : 'h3'
  return (
    <section
      id={anchor}
      data-wide
      className={cn(
        'kit-flow scroll-mt-8',
        level === 2 ? 'mt-24 first:mt-0 md:mt-32' : 'mt-16 md:mt-20',
        className,
      )}
    >
      <div className="kit-flow-inner">
        {(eyebrow || title || lede) && (
          <header className={level === 2 ? 'mb-8 md:mb-10' : 'mb-6'}>
            {eyebrow && <Eyebrow className="mb-4">{eyebrow}</Eyebrow>}
            {title && (
              <H
                className={cn(
                  'font-normal text-balance text-value',
                  level === 2
                    ? 'text-[25px] leading-[1.15] tracking-[-0.02em] md:text-[30px] md:leading-[1.12]'
                    : 'text-[19px] leading-[1.25] tracking-[-0.012em] md:text-[21px]',
                )}
              >
                {title}
              </H>
            )}
            {lede && (
              <p
                className={cn(
                  'text-pretty text-body',
                  level === 2 ? 'mt-4 text-[17px] leading-[1.6]' : 'mt-2.5 text-[16px] leading-[1.6] text-quiet',
                )}
              >
                {lede}
              </p>
            )}
          </header>
        )}
        {children}
      </div>
    </section>
  )
}

/* ─── typography ──────────────────────────────────────────────────────────── */

/** Uppercase tracked label. Tone colours it (default quiet ink). */
export function Eyebrow({
  children,
  tone = 'neutral',
  className,
  as: As = 'div',
}: {
  children: ReactNode
  tone?: Tone
  className?: string
  as?: 'div' | 'span' | 'p'
}) {
  return (
    <As className={cn('eyebrow', className)} style={tone !== 'neutral' ? { color: toneColor(tone) } : undefined}>
      {children}
    </As>
  )
}

/** The page title (h1), with an optional eyebrow above it. */
export function Title({
  children,
  eyebrow,
  size = 'lg',
  className,
}: {
  children: ReactNode
  eyebrow?: ReactNode
  /** lg: page title. md: for pages that lead with something else. */
  size?: 'lg' | 'md'
  className?: string
}) {
  return (
    <header data-wide className={cn('mb-8 md:mb-10', className)}>
      {eyebrow && <Eyebrow className="mb-5 md:mb-6">{eyebrow}</Eyebrow>}
      <h1
        className={cn(
          'max-w-[18em] font-normal text-balance text-value',
          size === 'lg'
            ? 'text-[32px] leading-[1.1] tracking-[-0.026em] sm:text-[38px] md:text-[46px] md:leading-[1.08] md:tracking-[-0.03em]'
            : 'text-[28px] leading-[1.12] tracking-[-0.024em] md:text-[36px]',
        )}
      >
        {children}
      </h1>
    </header>
  )
}

/** Intro paragraph under the title: larger, calm. `<strong>` lifts key phrases to full value. */
export function Lede({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'text-[18px] leading-[1.6] text-pretty text-[rgb(var(--ink)/0.8)] md:text-[19px] md:leading-[1.58] [&_strong]:font-medium [&_strong]:text-value',
        className,
      )}
    >
      {children}
    </p>
  )
}

/** Document typography for plain HTML: p, ul, ol, table, code, pre, blockquote, h3, h4, hr. */
export function Prose({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('kit-prose', className)} {...rest}>
      {children}
    </div>
  )
}

/** Lets any block span the full content width (and the margin) instead of the text column. */
export function Wide({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-wide className={cn('min-w-0', className)}>
      {children}
    </div>
  )
}
