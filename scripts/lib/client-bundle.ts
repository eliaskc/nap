import { createHash } from "node:crypto";
import { build, type Rolldown } from "vite";

async function bundle(
  input: string,
  format: "iife" | "es",
  define: Record<string, string> = {},
): Promise<string> {
  const result = (await build({
    configFile: false,
    logLevel: "warn",
    resolve: { tsconfigPaths: true },
    define,
    build: {
      write: false,
      copyPublicDir: false,
      minify: true,
      target: "es2022",
      rollupOptions: {
        input,
        // The engine is loaded with import(), and keeps its exports.
        preserveEntrySignatures: format === "es" ? "exports-only" : false,
        output: { format, codeSplitting: false },
      },
    },
  })) as Rolldown.RolldownOutput;
  return result.output[0].code;
}

/**
 * Bundles window.nap (src/client) as Nap serves it: client.js, a classic script that pages
 * load with a plain <script> tag, and client-voice.js, the voice engine (with Effect), an ES
 * module that client.js imports the first time a page asks for a call. client.js names the
 * engine's version, so it never runs against a cached older one.
 *
 * vite.config.ts serves the result as a virtual module; the tests run the same code.
 */
export async function bundleClient() {
  const voice = await bundle("src/client/voice-engine.ts", "es");
  const voiceVersion = createHash("sha256").update(voice).digest("hex").slice(0, 12);
  const client = await bundle("src/client/index.ts", "iife", {
    __NAP_VOICE_VERSION__: JSON.stringify(voiceVersion),
  });
  return { client, voice, voiceVersion };
}
