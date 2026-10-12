const PROVIDER_PROTOCOL_PREFIX =
  /^(?:ProviderAdapterProtocolError:\s*)?([a-z][a-z0-9_-]*) provider protocol error:\s*/iu;
const PROVIDER_TURN_START =
  /^Failed to start run .+ on ([a-z][a-z0-9_-]*) provider thread .+\.?$/iu;

function providerLabel(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function withoutTrailingPeriod(message: string): string {
  return message.trim().replace(/\.+$/u, "");
}

/**
 * Provider errors cross several Effect/RPC wrappers before reaching the
 * timeline. Present known operational failures as a next step instead of
 * exposing adapter names, run ids, or provider-thread ids.
 */
export function presentProviderError(message: string): string {
  const trimmed = message.trim();
  const protocolMatch = PROVIDER_PROTOCOL_PREFIX.exec(trimmed);
  if (protocolMatch) {
    const provider = providerLabel(protocolMatch[1]!);
    const detail = withoutTrailingPeriod(trimmed.slice(protocolMatch[0].length));
    return `${provider} couldn't complete the request: ${detail}. Check the provider connection in Settings → Providers, then try again.`;
  }

  const turnStartMatch = PROVIDER_TURN_START.exec(trimmed);
  if (turnStartMatch) {
    const provider = providerLabel(turnStartMatch[1]!);
    return `${provider} couldn't start this message. Check the provider connection in Settings → Providers, then try again.`;
  }

  return trimmed;
}
