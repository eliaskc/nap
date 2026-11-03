import { readdirSync } from "node:fs";
import { build, defineConfig, type Plugin, type Rolldown } from "vite";
import cloudflare from "@alchemy.run/cloudflare-runtime/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { napConfig } from "./nap.config.ts";
import { bundleClient } from "./scripts/lib/client-bundle.ts";
import { extensionFiles, findExtensions, serverModuleSource } from "./scripts/lib/extensions.ts";

/**
 * Builds part of the artifact comments (src/comments) as one self-contained file. They load
 * outside the dashboard's app, so they do not share its chunks.
 */
function bundleComments(input: string, file: string, outDir: string, write: boolean) {
  return build({
    configFile: false,
    logLevel: "warn",
    resolve: { tsconfigPaths: true },
    plugins: [tailwindcss(), viteReact()],
    build: {
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      write,
      rollupOptions: {
        input,
        output: { entryFileNames: file, format: "iife", codeSplitting: false },
      },
    },
  }) as Promise<Rolldown.RolldownOutput>;
}

/** _nap/comments.js, the comments UI for the Nap bar, with its own React and inlined CSS. */
const COMMENTS_BAR = ["src/comments/main.tsx", "comments.js"] as const;

/** Writes _nap/comments.js into the client build. */
function commentsBundle(): Plugin {
  return {
    name: "nap-comments-bundle",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    async writeBundle(options) {
      await bundleComments(...COMMENTS_BAR, `${options.dir}/_nap`, true);
    },
  };
}

/** Serves _nap/comments.js in dev, built on each request, so artifact pages work there too. */
function commentsDev(): Plugin {
  return {
    name: "nap-comments-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== `/_nap/${COMMENTS_BAR[1]}`) return next();
        try {
          const result = await bundleComments(...COMMENTS_BAR, "dist/client/_nap", false);
          res.setHeader("content-type", "text/javascript; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(result.output[0].code);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

/**
 * `virtual:nap-comments-frame`: the small comments script for inside artifact frames
 * (src/comments/frame.ts) as a string. The Worker serves it itself, like viewer.js, so it works
 * the same in dev, where the Worker's ASSETS binding only resolves HTML.
 */
function commentsFrameModule(): Plugin {
  const id = "virtual:nap-comments-frame";
  return {
    name: "nap-comments-frame",
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    async load(resolved) {
      if (resolved !== `\0${id}`) return;
      this.addWatchFile("src/comments/frame.ts");
      const result = await bundleComments("src/comments/frame.ts", "frame.js", "dist", false);
      return `export default ${JSON.stringify(result.output[0].code)};`;
    },
  };
}

/**
 * `virtual:nap-client`: window.nap (src/client), the script every site loads from
 * /_nap/client.js, and its voice engine (/_nap/client-voice.js), bundled and served by the
 * Worker as strings.
 */
function napClientModule(): Plugin {
  const id = "virtual:nap-client";
  return {
    name: "nap-client",
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    async load(resolved) {
      if (resolved !== `\0${id}`) return;
      for (const file of readdirSync("src/client")) this.addWatchFile(`src/client/${file}`);
      for (const file of extensionFiles(findExtensions())) this.addWatchFile(file);
      const { client, voice, voiceVersion } = await bundleClient();
      return [
        `export const client = ${JSON.stringify(client)};`,
        `export const voice = ${JSON.stringify(voice)};`,
        `export const voiceVersion = ${JSON.stringify(voiceVersion)};`,
      ].join("\n");
    },
  };
}

/**
 * `virtual:nap-extensions`: the deployment's extensions from instance/extensions (see
 * nap.extension.ts), for the Worker: their server modules, types, and instructions.
 */
function napExtensionsModule(): Plugin {
  const id = "virtual:nap-extensions";
  return {
    name: "nap-extensions",
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return;
      const extensions = findExtensions();
      for (const file of extensionFiles(extensions)) this.addWatchFile(file);
      return serverModuleSource(extensions);
    },
  };
}

export default defineConfig({
  server: {
    port: 3000,
    // Nap routes by host: the dashboard at the root domain, each site at <slug>.<root>.
    allowedHosts: [`.${napConfig.rootDomain}`],
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    // Alchemy injects this plugin, with the Worker's bindings, for dev and deployment. A plain
    // `vite build` (CI type and build check) adds it here with the same entry and compatibility.
    process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1"
      ? undefined
      : cloudflare({
          main: "src/worker.ts",
          compatibilityDate: "2026-06-13",
          compatibilityFlags: ["nodejs_compat"],
        }),
    tanstackStart(),
    viteReact(),
    commentsBundle(),
    commentsDev(),
    commentsFrameModule(),
    napClientModule(),
    napExtensionsModule(),
  ],
});
