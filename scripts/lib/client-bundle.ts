import { build, type Rolldown } from "vite";

/**
 * Bundles a script Nap serves to sites (src/client) into one self-contained file and returns
 * its code. Pages load it with a plain <script> tag, so it is an IIFE with nothing to import.
 * vite.config.ts serves the result as a virtual module; the tests run the same code.
 */
export async function bundleClientScript(input: string) {
  const result = (await build({
    configFile: false,
    logLevel: "warn",
    resolve: { tsconfigPaths: true },
    build: {
      write: false,
      copyPublicDir: false,
      minify: true,
      target: "es2022",
      rollupOptions: {
        input,
        output: { format: "iife", codeSplitting: false },
      },
    },
  })) as Rolldown.RolldownOutput;
  return result.output[0].code;
}
