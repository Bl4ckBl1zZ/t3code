import { PROVIDER_DISPLAY_NAMES, ProviderDriverKind } from "@t3tools/contracts";

const PROVIDER_PROTOCOL_PREFIX =
  /^(?:ProviderAdapterProtocolError:\s*)?([a-z][a-z0-9_-]*) provider protocol error:\s*/iu;
const PROVIDER_TURN_START =
  /^(?:ProviderAdapterTurnStartError:\s*)?Failed to start run \S+ on ([a-z][a-z0-9_-]*) provider thread \S+?\.?$/iu;

function providerLabel(driver: string): string {
  return (
    PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(driver)] ??
    driver.charAt(0).toUpperCase() + driver.slice(1)
  );
}

const NEXT_STEP = "Check the provider connection in Settings → Providers, then try again.";

/**
 * Provider adapter failures reach threads as their server error messages,
 * which carry adapter names, run ids, and provider-thread ids. Shows the known
 * ones as a next step for the user; anything else passes through trimmed.
 * Inspectors keep the raw message.
 */
export function presentProviderError(message: string): string {
  const trimmed = message.trim();
  const protocolMatch = PROVIDER_PROTOCOL_PREFIX.exec(trimmed);
  if (protocolMatch) {
    const detail = trimmed.slice(protocolMatch[0].length).trim().replace(/\.+$/u, "");
    return `${providerLabel(protocolMatch[1]!)} couldn't complete the request${detail ? `: ${detail}` : ""}. ${NEXT_STEP}`;
  }
  const turnStartMatch = PROVIDER_TURN_START.exec(trimmed);
  if (turnStartMatch) {
    return `${providerLabel(turnStartMatch[1]!)} couldn't start this message. ${NEXT_STEP}`;
  }
  return trimmed;
}
