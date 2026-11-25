# Nap kit

A Vite + React + Tailwind v4 + shadcn/ui (Base UI) project that builds one self-contained
`dist/index.html` for Nap.

```sh
pnpm install        # or npm install
pnpm dev            # /?kitchen shows every component
pnpm build          # → dist/index.html
```

Set `<title>` in `index.html` to the page's name (Nap uses it as the page title; the build fails
on the placeholder). Write the page in `src/App.tsx`. Components are in `src/kit/` (see `KIT.md`), shadcn/ui
primitives in `src/kit/ui/`, theme tokens in `src/theme/`.
