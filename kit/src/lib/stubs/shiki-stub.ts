// Build-time stub. @pierre/diffs can fall back to Shiki, which would inline every grammar
// (~10 MB) into the single-file build. The kit always uses the Highlights (WASM) backend,
// so the Shiki entry points are replaced with this empty module. See vite.config.ts.
export const bundledLanguages = {}
export const createJavaScriptRegexEngine = () => {
  throw new Error('Shiki is stubbed out in this kit; use preferredHighlighter: "highlights"')
}
export const createOnigurumaEngine = createJavaScriptRegexEngine
export class ShikiHighlighter {
  constructor() {
    createJavaScriptRegexEngine()
  }
}
export default {}
export const themes = {}
export const normalizeTheme = createJavaScriptRegexEngine
export const createCssVariablesTheme = createJavaScriptRegexEngine
