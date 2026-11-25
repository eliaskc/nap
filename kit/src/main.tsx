import { StrictMode } from 'react'
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

// The kit's kitchen sink: `pnpm dev` then open /?kitchen, or `pnpm build:kitchen`.
// The check on import.meta.env is static, so a normal `pnpm build` leaves it out.
const kitchen =
  (import.meta.env.DEV && new URLSearchParams(location.search).has('kitchen')) || import.meta.env.MODE === 'kitchen'

if (kitchen) {
  import('./examples/KitchenSink').then(({ default: KitchenSink }) =>
    root.render(
      <StrictMode>
        <KitRoot>
          <KitchenSink />
        </KitRoot>
      </StrictMode>,
    ),
  )
} else {
  root.render(
    <StrictMode>
      <KitRoot>
        <App />
      </KitRoot>
    </StrictMode>,
  )
}
