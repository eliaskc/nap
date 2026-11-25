import { MotionConfig } from 'motion/react'
import { useEffect, type ReactNode } from 'react'
import { TooltipProvider } from '@/kit/ui/tooltip'

/**
 * App-wide setup, already used in main.tsx:
 * - Motion follows prefers-reduced-motion.
 * - Tooltips share one provider.
 * - Any link that leaves the page opens in a new tab (the page lives in an iframe),
 *   so plain <a href="https://…"> is fine everywhere. In-page "#id" links still scroll.
 */
export function KitRoot({ children }: { children: ReactNode }) {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (href.startsWith('#') || a.hasAttribute('download')) return
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delay={150}>{children}</TooltipProvider>
    </MotionConfig>
  )
}
