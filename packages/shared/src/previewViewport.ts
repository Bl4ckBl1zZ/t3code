import type {
  DesktopPreviewDeviceEmulation,
  PreviewAutomationResizeInput,
  PreviewViewportPresetId,
  PreviewViewportSetting,
} from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESET_IDS } from "@t3tools/contracts";

export interface PreviewViewportPreset {
  readonly id: PreviewViewportPresetId;
  readonly label: string;
  readonly category: "Desktop" | "Tablet" | "Phone";
  readonly detail: string;
  readonly width: number;
  readonly height: number;
  /**
   * Device identity applied on desktop while this preset is active (user
   * agent, touch, device pixel ratio) so sites serve their actual mobile
   * experience, not just narrow-viewport CSS. Null keeps the desktop
   * identity.
   */
  readonly emulation: DesktopPreviewDeviceEmulation | null;
}

type PreviewViewportPresetDefinition = Omit<PreviewViewportPreset, "id">;

// "%s" is replaced with the host Chrome version when the override is applied.
const IOS_PHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IOS_TABLET_USER_AGENT =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36";

const iosPhone = (deviceScaleFactor: number): DesktopPreviewDeviceEmulation => ({
  mobile: true,
  touch: true,
  deviceScaleFactor,
  userAgent: IOS_PHONE_USER_AGENT,
});
const iosTablet = (deviceScaleFactor: number): DesktopPreviewDeviceEmulation => ({
  mobile: true,
  touch: true,
  deviceScaleFactor,
  userAgent: IOS_TABLET_USER_AGENT,
});
const androidPhone = (deviceScaleFactor: number): DesktopPreviewDeviceEmulation => ({
  mobile: true,
  touch: true,
  deviceScaleFactor,
  userAgent: ANDROID_PHONE_USER_AGENT,
});
// Touch-capable devices that serve the desktop site (Surface, smart displays).
const touchDesktop = (deviceScaleFactor: number): DesktopPreviewDeviceEmulation => ({
  mobile: false,
  touch: true,
  deviceScaleFactor,
  userAgent: null,
});

// Keep this in Chrome DevTools' default-device order. Dimensions, scale
// factors, and user agents follow Chromium's EmulatedDevices.ts standard
// catalog.
const PREVIEW_VIEWPORT_PRESET_DEFINITIONS = {
  "iphone-se": {
    label: "iPhone SE",
    category: "Phone",
    detail: "375 × 667",
    width: 375,
    height: 667,
    emulation: iosPhone(2),
  },
  "iphone-xr": {
    label: "iPhone XR",
    category: "Phone",
    detail: "414 × 896",
    width: 414,
    height: 896,
    emulation: iosPhone(2),
  },
  "iphone-12-pro": {
    label: "iPhone 12 Pro",
    category: "Phone",
    detail: "390 × 844",
    width: 390,
    height: 844,
    emulation: iosPhone(3),
  },
  "iphone-14-pro-max": {
    label: "iPhone 14 Pro Max",
    category: "Phone",
    detail: "430 × 932",
    width: 430,
    height: 932,
    emulation: iosPhone(3),
  },
  "pixel-7": {
    label: "Pixel 7",
    category: "Phone",
    detail: "412 × 915",
    width: 412,
    height: 915,
    emulation: androidPhone(2.625),
  },
  "samsung-galaxy-s8-plus": {
    label: "Samsung Galaxy S8+",
    category: "Phone",
    detail: "360 × 740",
    width: 360,
    height: 740,
    emulation: androidPhone(4),
  },
  "samsung-galaxy-s20-ultra": {
    label: "Samsung Galaxy S20 Ultra",
    category: "Phone",
    detail: "412 × 915",
    width: 412,
    height: 915,
    emulation: androidPhone(3.5),
  },
  "ipad-mini": {
    label: "iPad Mini",
    category: "Tablet",
    detail: "768 × 1024",
    width: 768,
    height: 1024,
    emulation: iosTablet(2),
  },
  "ipad-air": {
    label: "iPad Air",
    category: "Tablet",
    detail: "820 × 1180",
    width: 820,
    height: 1180,
    emulation: iosTablet(2),
  },
  "ipad-pro": {
    label: "iPad Pro",
    category: "Tablet",
    detail: "1024 × 1366",
    width: 1024,
    height: 1366,
    emulation: iosTablet(2),
  },
  "surface-pro-7": {
    label: "Surface Pro 7",
    category: "Tablet",
    detail: "912 × 1368",
    width: 912,
    height: 1368,
    emulation: touchDesktop(2),
  },
  "surface-duo": {
    label: "Surface Duo",
    category: "Phone",
    detail: "540 × 720",
    width: 540,
    height: 720,
    emulation: androidPhone(2.5),
  },
  "galaxy-z-fold-5": {
    label: "Galaxy Z Fold 5",
    category: "Phone",
    detail: "344 × 882",
    width: 344,
    height: 882,
    emulation: androidPhone(2.625),
  },
  "asus-zenbook-fold": {
    label: "Asus Zenbook Fold",
    category: "Tablet",
    detail: "853 × 1280",
    width: 853,
    height: 1280,
    emulation: touchDesktop(2),
  },
  "samsung-galaxy-a51-71": {
    label: "Samsung Galaxy A51/71",
    category: "Phone",
    detail: "412 × 914",
    width: 412,
    height: 914,
    emulation: androidPhone(2.625),
  },
  "nest-hub": {
    label: "Nest Hub",
    category: "Tablet",
    detail: "1024 × 600",
    width: 1024,
    height: 600,
    emulation: touchDesktop(2),
  },
  "nest-hub-max": {
    label: "Nest Hub Max",
    category: "Tablet",
    detail: "1280 × 800",
    width: 1280,
    height: 800,
    emulation: touchDesktop(2),
  },
} as const satisfies Record<PreviewViewportPresetId, PreviewViewportPresetDefinition>;

export const PREVIEW_VIEWPORT_PRESETS: ReadonlyArray<PreviewViewportPreset> =
  PREVIEW_VIEWPORT_PRESET_IDS.map((id) => ({
    id,
    ...PREVIEW_VIEWPORT_PRESET_DEFINITIONS[id],
  }));

export function resolvePreviewViewport(
  input: PreviewAutomationResizeInput,
): PreviewViewportSetting {
  if (input.mode === "fill") return { _tag: "fill" };
  if (input.mode === "preset" && input.preset !== undefined) {
    const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === input.preset);
    if (!preset) throw new Error(`Unknown preview viewport preset: ${input.preset}`);
    const landscape = input.orientation === "landscape";
    const portrait = input.orientation === "portrait";
    const nativePortrait = preset.height >= preset.width;
    const shouldSwap = (landscape && nativePortrait) || (portrait && !nativePortrait);
    return {
      _tag: "preset",
      width: shouldSwap ? preset.height : preset.width,
      height: shouldSwap ? preset.width : preset.height,
      presetId: preset.id,
    };
  }
  if (input.width === undefined || input.height === undefined) {
    throw new Error("Custom preview viewport requires width and height");
  }
  return {
    _tag: "freeform",
    width: input.width,
    height: input.height,
  };
}

/**
 * Device identity to emulate for a viewport setting. Only presets carry one;
 * fill/freeform sizes are pure CSS-breakpoint testing and keep the desktop
 * identity.
 */
export function resolvePreviewDeviceEmulation(
  viewport: PreviewViewportSetting,
): DesktopPreviewDeviceEmulation | null {
  if (viewport._tag !== "preset") return null;
  const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === viewport.presetId);
  return preset?.emulation ?? null;
}

export function previewViewportLabel(viewport: PreviewViewportSetting): string {
  return viewport._tag === "fill" ? "Fill panel" : `${viewport.width} × ${viewport.height}`;
}

export function previewViewportPresetOrientation(
  viewport: PreviewViewportSetting,
): "portrait" | "landscape" | null {
  if (viewport._tag === "fill" || viewport.width === viewport.height) return null;
  return viewport.width > viewport.height ? "landscape" : "portrait";
}
