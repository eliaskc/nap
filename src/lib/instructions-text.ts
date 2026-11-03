import { fillDeploymentText } from "./deployment-text.ts";
import type { NapConfig } from "../../nap.config.ts";

/** Topics that only some deployments have, by the setting that turns them on. */
export const OPTIONAL_TOPICS: Record<string, (config: NapConfig) => boolean> = {
  apps: (config) => Boolean(config.apps),
};

/**
 * Fills in one instructions page for a deployment. Text between <!-- if <flag> --> and
 * <!-- /if --> shows only when the flag is on: "apps" when apps are on, "adhoc" and "testflight"
 * for how people install them, and "private" or "everyone" for the default access.
 * {{extensionTopics}} on a line of its own becomes the deployment's extension topics.
 */
export function renderInstructions(
  text: string,
  config: NapConfig,
  rootDomain = config.rootDomain,
  extensionTopics: ReadonlyArray<{ name: string; summary: string }> = [],
) {
  const flags: Record<string, boolean> = {
    apps: Boolean(config.apps),
    adhoc: Boolean(config.apps?.profileName),
    testflight: Boolean(config.apps?.testFlight),
    private: config.defaultAccess === "private",
    everyone: config.defaultAccess === "everyone",
  };
  const shown = text.replace(
    /<!-- if (\w+) -->\n([\s\S]*?)<!-- \/if -->\n/g,
    (_, flag: string, inner: string) => {
      if (!(flag in flags)) throw new Error(`Unknown instructions flag: ${flag}`);
      return flags[flag] ? inner : "";
    },
  );
  const topics = extensionTopics
    .map((topic) => `- \`${topic.name}\`: ${topic.summary} (\`nap.${topic.name}\`).\n`)
    .join("");
  const withTopics = shown.replace(/^\{\{extensionTopics\}\}\n/m, topics);
  return fillDeploymentText(withTopics.replace(/\n{3,}/g, "\n\n"), {
    ...config,
    rootDomain,
  }).replaceAll(
    "{{testFlightApp}}",
    config.apps?.testFlight?.app ?? "",
  );
}
