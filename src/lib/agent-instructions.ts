import api from "~/content/instructions/api.md?raw";
import apps from "~/content/instructions/apps.md?raw";
import channels from "~/content/instructions/channels.md?raw";
import data from "~/content/instructions/data.md?raw";
import drafts from "~/content/instructions/drafts.md?raw";
import fetch from "~/content/instructions/fetch.md?raw";
import index from "~/content/instructions/index.md?raw";
import sites from "~/content/instructions/sites.md?raw";
import source from "~/content/instructions/source.md?raw";
import { OPTIONAL_TOPICS, renderInstructions } from "~/lib/instructions-text";
import { napConfig } from "~/nap.config";

/**
 * The agent instructions: an index at /_nap/api/instructions that covers the common case, and
 * topics at /_nap/api/instructions/<topic>. The files are in src/content/instructions.
 */
const TOPICS: Record<string, string> = {
  index,
  sites,
  source,
  data,
  channels,
  fetch,
  api,
  drafts,
  apps,
};

/** One instructions page ("index" for the main one), or null when this Nap has no such topic. */
export function agentInstructionsFor(rootDomain = napConfig.rootDomain, topic = "index") {
  if (!Object.hasOwn(TOPICS, topic)) return null;
  if (OPTIONAL_TOPICS[topic] && !OPTIONAL_TOPICS[topic](napConfig)) return null;
  return renderInstructions(TOPICS[topic], napConfig, rootDomain);
}
