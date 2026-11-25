import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn, useWidth } from './lib'

export type Chapter = { id?: string; eyebrow?: ReactNode; title: ReactNode; body?: ReactNode }

/**
 * Scroll-driven story: chapters on the left, a pinned stage on the right that updates
 * as each chapter reaches the middle of the screen. `stage(index)` renders the stage
 * for the active chapter; keep it one element whose props change (e.g. a Flow's
 * `highlight`) so the change animates.
 *
 * Calm by design: every chapter is fully readable at rest, clicking a chapter also
 * activates it, and on phones (or narrow containers) each chapter simply shows its
 * own stage inline below the text.
 */
export function ScrollStory({
  chapters,
  stage,
  stageClassName,
  className,
}: {
  chapters: Chapter[]
  stage: (index: number) => ReactNode
  stageClassName?: string
  className?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const pinned = width >= 860
  const [active, setActive] = useState(0)
  const items = useRef<(HTMLElement | null)[]>([])

  useEffect(() => {
    if (!pinned) return
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting)
        if (!vis.length) return
        const top = vis.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        const i = items.current.indexOf(top.target as HTMLElement)
        if (i >= 0) setActive(i)
      },
      { rootMargin: '-42% 0px -52% 0px' },
    )
    items.current.forEach((el) => el && io.observe(el))
    return () => io.disconnect()
  }, [pinned, chapters.length])

  return (
    <div data-wide ref={ref} className={cn('min-w-0', className)}>
      {pinned ? (
        <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-10">
          <ol>
            {chapters.map((c, i) => (
              <li
                key={c.id ?? i}
                id={c.id}
                ref={(el) => {
                  items.current[i] = el
                }}
                className="flex min-h-[300px] flex-col justify-center py-8 first:pt-2"
              >
                <button
                  type="button"
                  onClick={() => setActive(i)}
                  aria-current={active === i ? 'step' : undefined}
                  className={cn(
                    'group cursor-pointer border-l py-1 pl-5 text-left transition-[opacity,border-color] duration-300',
                    active === i ? 'border-teal opacity-100' : 'border-line opacity-55 hover:opacity-85',
                  )}
                >
                  <ChapterText c={c} i={i} />
                </button>
              </li>
            ))}
          </ol>
          <div>
            <div className={cn('sticky top-8', stageClassName)}>{stage(active)}</div>
          </div>
        </div>
      ) : (
        <ol className="flex flex-col gap-10">
          {chapters.map((c, i) => (
            <li key={c.id ?? i} id={c.id} className="flex flex-col gap-4">
              <div className="border-l border-teal/70 pl-4">
                <ChapterText c={c} i={i} />
              </div>
              <div className={stageClassName}>{stage(i)}</div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function ChapterText({ c, i }: { c: Chapter; i: number }) {
  return (
    <>
      <div className="eyebrow mb-2">{c.eyebrow ?? String(i + 1).padStart(2, '0')}</div>
      <div className="text-[19px] leading-[1.3] font-normal tracking-[-0.012em] text-value md:text-[21px]">{c.title}</div>
      {c.body && <div className="mt-2.5 text-[15px] leading-[1.6] text-body">{c.body}</div>}
    </>
  )
}
