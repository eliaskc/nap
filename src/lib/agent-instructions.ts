import api from "~/content/instructions/api.md?raw";
import apps from "~/content/instructions/apps.md?raw";
import channels from "~/content/instructions/channels.md?raw";
import dashboards from "~/content/instructions/dashboards.md?raw";
import data from "~/content/instructions/data.md?raw";
import design from "~/content/instructions/design.md?raw";
import drafts from "~/content/instructions/drafts.md?raw";
import fetch from "~/content/instructions/fetch.md?raw";
import notifications from "~/content/instructions/notifications.md?raw";
import index from "~/content/instructions/index.md?raw";
import sites from "~/content/instructions/sites.md?raw";
import source from "~/content/instructions/source.md?raw";
import voice from "~/content/instructions/voice.md?raw";
import { EXTENSIONS } from "~/lib/extension-registry";
import { OPTIONAL_TOPICS, renderInstructions } from "~/lib/instructions-text";
import { napConfig } from "~/nap.config";
import { instructions as INSTANCE_TEXT, kitFiles } from "virtual:nap-instance-content";
import { withInstanceText } from "../../scripts/lib/instance-text.ts";

/** The kit's own guide (kit/KIT.md, with the instance's kit.md), which is the kit topic. */
const kit = kitFiles.find((file) => file.path === "KIT.md")?.content ?? "";

/**
 * The agent instructions: an index at /_nap/api/instructions that covers the common case, and
 * topics at /_nap/api/instructions/<topic>. The files are in src/content/instructions, and the
 * kit topic is the kit's own KIT.md. An instance adds to a topic, or adds topics of its own,
 * with instance/instructions/<topic>.md (see scripts/lib/kit.ts).
 */
const CORE_TOPICS: Record<string, string> = {
  index,
  kit,
  design,
  sites,
  source,
  data,
  channels,
  voice,
  fetch,
  dashboards,
  notifications,
  api,
  drafts,
  apps,
};

/** Each of Nap's topics with what the instance adds to it. */
const TOPICS: Record<string, string> = Object.fromEntries(
  Object.entries(CORE_TOPICS).map(([name, text]) => [
    name,
    withInstanceText(text, INSTANCE_TEXT[name]),
  ]),
);

/**
 * Topics Nap itself does not have, listed in the index: the deployment's extensions with
 * instructions (topic <name>, for nap.<name>), and the instance's own topics, by their heading.
 */
const EXTENSION_TOPICS = [
  ...EXTENSIONS.filter(
    (extension) => extension.instructions && !Object.hasOwn(TOPICS, extension.name),
  ).map((extension) => ({
    name: extension.name,
    summary: extension.server.summary,
    text: withInstanceText(extension.instructions!, INSTANCE_TEXT[extension.name]),
    api: true,
  })),
  ...Object.entries(INSTANCE_TEXT)
    .filter(
      ([name]) =>
        !Object.hasOwn(TOPICS, name) && !EXTENSIONS.some((extension) => extension.name === name),
    )
    .map(([name, text]) => ({
      name,
      summary: /^#+\s*(.+)$/m.exec(text)?.[1].trim() ?? name,
      text,
      api: false,
    })),
];

/** One instructions page ("index" for the main one), or null when this Nap has no such topic. */
export function agentInstructionsFor(
  rootDomain = napConfig.rootDomain,
  topic = "index",
  contentDomain = rootDomain === napConfig.rootDomain ? napConfig.contentDomain : undefined,
) {
  const config = { ...napConfig, contentDomain: contentDomain || rootDomain };
  const extension = EXTENSION_TOPICS.find((entry) => entry.name === topic);
  if (extension) return renderInstructions(extension.text, config, rootDomain);
  if (!Object.hasOwn(TOPICS, topic)) return null;
  if (OPTIONAL_TOPICS[topic] && !OPTIONAL_TOPICS[topic](napConfig)) return null;
  return renderInstructions(TOPICS[topic], config, rootDomain, EXTENSION_TOPICS);
}
