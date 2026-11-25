import { readFileSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const stub = path.resolve(import.meta.dirname, './src/lib/stubs/shiki-stub.ts')

/** Keep Shiki's grammars out of the bundle: the kit's Code and Diff use @pierre/highlights. */
function noShiki(): Plugin {
  return {
    name: 'kit:no-shiki',
    enforce: 'pre',
    resolveId(id, importer) {
      if (/^shiki(\/|$)/.test(id)) return stub
      if (id === '@pierre/highlights/themes/loader' || id === '@pierre/theming/themes') return stub
      if (id === './backends/shiki.js' && importer?.includes('@pierre/diffs')) return stub
      return null
    },
  }
}

const PLACEHOLDER_TITLES = new Set(['', 'untitled', 'todo: page title'])

/**
 * Fail the build while index.html still has the placeholder <title>. Nap names a published page
 * after its <title>, read from the HTML file, so setting document.title from React does not help.
 */
function requireTitle(mode: string): Plugin {
  return {
    name: 'kit:require-title',
    apply: 'build',
    transformIndexHtml(html) {
      if (mode === 'kitchen') return html.replace(/<title>[\s\S]*?<\/title>/i, '<title>Nap kit: kitchen sink</title>')
      const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1].trim() ?? ''
      if (PLACEHOLDER_TITLES.has(title.toLowerCase())) {
        throw new Error(
          `index.html still has the placeholder <title>${title}</title>. ` +
            'Set it to the page\'s name; Nap uses it as the page title.',
        )
      }
      return html
    },
  }
}

type ThemeFile = { default: string; themes: Array<{ id: string; label: string }> }

/**
 * The page's themes, from theme.json: sets the default one on <html data-theme>, and lists them
 * in <meta name="nap-themes"> (id=Label pairs), which tells Nap that the page can switch theme.
 * Nap then offers the choice in its bar and sets data-theme. Remove the meta tag's line here, or
 * build with a theme.json that lists one theme, for a page that should not switch: one with its
 * own colours or art.
 */
function themes(): Plugin {
  const file = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'theme.json'), 'utf8')) as ThemeFile
  const ids = file.themes.map((theme) => theme.id)
  if (!ids.includes(file.default)) throw new Error(`theme.json: the default "${file.default}" is not one of its themes`)
  for (const theme of file.themes) {
    if (!/^[a-z][a-z0-9-]*$/.test(theme.id)) throw new Error(`theme.json: "${theme.id}" is not a theme id (lowercase letters, digits, "-")`)
    if (/[,=]/.test(theme.label)) throw new Error(`theme.json: the label "${theme.label}" may not contain "," or "="`)
  }
  return {
    name: 'kit:themes',
    transformIndexHtml(html) {
      const list = file.themes.map((theme) => `${theme.id}=${theme.label}`).join(',')
      const meta = file.themes.length > 1 ? `\n    <meta name="nap-themes" content="${list}" />` : ''
      return html
        .replace(/<html\b(?![^>]*\bdata-theme=)/i, `<html data-theme="${file.default}"`)
        .replace(/(<meta name="viewport"[^>]*>)/i, `$1${meta}`)
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [noShiki(), react(), tailwindcss(), viteSingleFile(), requireTitle(mode), themes()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  build: { assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 100_000 },
}))
