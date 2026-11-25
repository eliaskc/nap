/**
 * Islands for slides. A deck's slides are plain HTML in slides.html; an element with
 * data-island="name" is filled in by code. Import from '@/kit/slides'.
 *
 *   mountIslands({ trend: () => <LineChart … />, map: Map })
 *
 * Every island is part of one React tree (portals), under the kit's root, so they can share
 * state and context. An island should look finished at rest: the column of slides and the PDF
 * show it as it is, without its motion.
 */
import type { ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { KitRoot } from './root'

export function mountIslands(islands: Record<string, ComponentType>) {
  const mount = () => {
    // Not the still copies Nap's shell draws for the column of slides.
    const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-island]')).filter((element) => !element.closest('[data-nap-thumb]'))
    const unknown = targets.filter((element) => !islands[element.dataset.island ?? ''])
    if (unknown.length) console.warn('No island named', unknown.map((element) => element.dataset.island).join(', '))
    createRoot(document.createElement('div')).render(
      <KitRoot>
        {targets.map((element, i) => {
          const Island = islands[element.dataset.island ?? '']
          return Island ? createPortal(<Island />, element, String(i)) : null
        })}
      </KitRoot>,
    )
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount)
  else mount()
}
