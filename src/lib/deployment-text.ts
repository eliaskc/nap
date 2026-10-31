import { napConfig, type NapConfig } from "../../nap.config.ts";

/**
 * Fills the deployment's names into text that ships to agents: {{rootDomain}}, {{orgName}},
 * {{admin}}, and {{defaultAccess}}.
 */
export function fillDeploymentText(text: string, config: NapConfig = napConfig) {
  return text
    .replaceAll("{{rootDomain}}", config.rootDomain)
    .replaceAll("{{orgName}}", config.orgName)
    .replaceAll("{{admin}}", config.admin)
    .replaceAll("{{defaultAccess}}", config.defaultAccess);
}

/** Who sees a new artifact or site until the owner changes it (napConfig.defaultAccess). */
export const DEFAULT_ACCESS = napConfig.defaultAccess;

/** "Everyone at <org>": the widest access a nap can have. Access still decides who that is. */
export const EVERYONE_LABEL = `Everyone at ${napConfig.orgName}`;
