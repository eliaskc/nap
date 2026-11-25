import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { KitRoot } from '@/kit/root'
import App from './App'
import './index.css'

// In dev, /?theme=<id> shows the page in one of theme.json's themes.
if (import.meta.env.DEV) {
  const theme = new URLSearchParams(location.search).get('theme')
  if (theme) document.documentElement.dataset.theme = theme
}

const root = createRoot(document.getElementById('root')!)

// The kit's examples: `pnpm dev` then open /?kitchen (every component) or /?dashboard (the
// dashboard parts), or `pnpm build:kitchen` and `pnpm build:dashboard`. The checks on
// import.meta.env are written out so they are static: a normal `pnpm build` leaves the examples out.
const asks = (name: string) => new URLSearchParams(location.search).has(name)
const kitchen = (import.meta.env.DEV && asks('kitchen')) || import.meta.env.MODE === 'kitchen'
const dashboard = (import.meta.env.DEV && asks('dashboard')) || import.meta.env.MODE === 'dashboard'

const show = (page: ReactNode) =>
  root.render(
    <StrictMode>
      <KitRoot>{page}</KitRoot>
    </StrictMode>,
  )

if (kitchen) {
  import('./examples/KitchenSink').then(({ default: KitchenSink }) => show(<KitchenSink />))
} else if (dashboard) {
  import('./examples/DashboardExample').then(({ default: DashboardExample }) => show(<DashboardExample />))
} else {
  show(<App />)
}
