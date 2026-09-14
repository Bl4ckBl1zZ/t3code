import { HermesWorkError } from "@t3tools/contracts";
import { Schema } from "effect";

const Config = Schema.Struct({
  timezone: Schema.optional(Schema.String),
  cron: Schema.optional(Schema.Struct({ allow_agent_scheduling: Schema.optional(Schema.Boolean) })),
});

const decodeConfig = Schema.decodeUnknownSync(Config);

/** Only expose the two native profile settings owned by the automation form. */
export function decodeHermesWorkAutomation(value: unknown) {
  const config = decodeConfig(value);
  return {
    timezone: config.timezone ?? "",
    allowAgentScheduling: config.cron?.allow_agent_scheduling ?? false,
  };
}

/** A partial config patch lets Hermes preserve every unrelated profile setting. */
export function hermesWorkAutomationPatch(timezone: string, allowAgentScheduling: boolean) {
  const zone = timezone.trim();
  if (zone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone }).format();
    } catch {
      throw new HermesWorkError({
        code: "invalid_input",
        message:
          "Enter a valid timezone such as Europe/Luxembourg, or leave it empty for the environment default.",
      });
    }
  }
  return { config: { timezone: zone, cron: { allow_agent_scheduling: allowAgentScheduling } } };
}

/** Hermes represents continuity as the reserved self source beside upstream jobs. */
export function hermesWorkContinuitySources(
  contextFrom: ReadonlyArray<string>,
  continuity: boolean,
) {
  const otherSources = [...new Set(contextFrom.filter((source) => source !== "self"))];
  return continuity ? [...otherSources, "self"] : otherSources;
}
