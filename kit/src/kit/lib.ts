import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export { cn } from '@/lib/utils'

/** The kit's one easing curve (fast out, soft landing). */
export const ease = [0.22, 1, 0.36, 1] as const

/**
 * Colour roles. Accents (teal, peach, orange, cream) carry meaning you choose;
 * good / warn / bad are for status only. `neutral` is ink.
 */
export type Tone = 'neutral' | 'teal' | 'peach' | 'orange' | 'cream' | 'good' | 'warn' | 'bad'

/** CSS colour for a tone (works in SVG `stroke`/`fill` and inline styles). */
export const toneColor = (tone: Tone = 'neutral', neutral = 'rgb(var(--ink) / 0.5)') =>
  tone === 'neutral' ? neutral : `var(--${tone})`

/** Same colour mixed toward transparent, for fills and borders. */
export const toneMix = (tone: Tone = 'neutral', pct: number) =>
  tone === 'neutral'
    ? `rgb(var(--ink) / ${(pct / 100) * 0.5})`
    : `color-mix(in oklab, var(--${tone}) ${pct}%, transparent)`

/** Width of an element, kept up to date. Diagrams use it to reflow on phones. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const m = matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(m.matches)
    const on = () => setReduced(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return reduced
}

/** Slugify a heading into an id. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
