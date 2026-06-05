import type { AuthClientMetadataDeviceType, ServerAuthPolicy } from "@t3tools/contracts";

interface NavigatorWithUserAgentData extends Navigator {
  readonly userAgentData?: {
    readonly mobile?: boolean;
  };
}

function isMobileOrTabletDeviceType(deviceType: AuthClientMetadataDeviceType | null): boolean {
  return deviceType === "mobile" || deviceType === "tablet";
}

export function resolvePreviewDeviceType(input: {
  readonly sessionDeviceType: AuthClientMetadataDeviceType | null | undefined;
  readonly detectedDeviceType: AuthClientMetadataDeviceType | null;
}): AuthClientMetadataDeviceType | null {
  if (isMobileOrTabletDeviceType(input.sessionDeviceType ?? null)) {
    return input.sessionDeviceType ?? null;
  }
  if (isMobileOrTabletDeviceType(input.detectedDeviceType)) {
    return input.detectedDeviceType;
  }
  return input.sessionDeviceType ?? input.detectedDeviceType;
}

export function detectBrowserDeviceType(): AuthClientMetadataDeviceType | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  const navigatorWithHints = navigator as NavigatorWithUserAgentData;
  const mobileHint = navigatorWithHints.userAgentData?.mobile;
  const userAgent = navigator.userAgent.trim().toLowerCase();

  if (/bot|crawler|spider|slurp|curl|wget/u.test(userAgent)) {
    return "bot";
  }
  if (
    /ipad|tablet/u.test(userAgent) ||
    (/android/u.test(userAgent) && !/mobile/u.test(userAgent))
  ) {
    return "tablet";
  }
  if (mobileHint === true || /iphone|ipod|android.+mobile|mobile/u.test(userAgent)) {
    return "mobile";
  }
  if (mobileHint === false || userAgent.length > 0) {
    return "desktop";
  }
  return null;
}

export function shouldOpenPreviewInNewTab(input: {
  readonly currentSessionCanManageAccess: boolean;
  readonly currentAuthPolicy: ServerAuthPolicy | null;
  readonly currentDeviceType: AuthClientMetadataDeviceType | null;
}): boolean {
  if (isMobileOrTabletDeviceType(input.currentDeviceType)) {
    return true;
  }

  return !input.currentSessionCanManageAccess && input.currentAuthPolicy === "loopback-browser";
}
