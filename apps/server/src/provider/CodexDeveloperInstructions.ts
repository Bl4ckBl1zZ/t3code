import { buildT3ProviderDeveloperInstructions } from "./AppProviderInstructions.ts";

export const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS = buildT3ProviderDeveloperInstructions({
  interactionMode: "plan",
});

export const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = buildT3ProviderDeveloperInstructions({
  interactionMode: "default",
});
