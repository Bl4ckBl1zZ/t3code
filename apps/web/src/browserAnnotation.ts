export const BROWSER_ANNOTATION_PAGE_SOURCE = "t3code.web";
export const BROWSER_ANNOTATION_EXTENSION_SOURCE = "t3code.chrome-extension";

export const BROWSER_ANNOTATION_PROBE_MESSAGE = "t3code.browserAnnotation.probe";
export const BROWSER_ANNOTATION_READY_MESSAGE = "t3code.browserAnnotation.ready";
export const BROWSER_ANNOTATION_ACTIVATE_MESSAGE = "t3code.browserAnnotation.activate";
export const BROWSER_ANNOTATION_STATUS_MESSAGE = "t3code.browserAnnotation.status";
export const BROWSER_ANNOTATION_CAPTURE_MESSAGE = "t3code.browserAnnotation.capture";

export interface BrowserAnnotationReadyMessage {
  readonly source: typeof BROWSER_ANNOTATION_EXTENSION_SOURCE;
  readonly type: typeof BROWSER_ANNOTATION_READY_MESSAGE;
  readonly linked: boolean;
  readonly active: boolean;
  readonly browserContext?: BrowserAnnotationBrowserContext;
}

export interface BrowserAnnotationStatusMessage {
  readonly source: typeof BROWSER_ANNOTATION_EXTENSION_SOURCE;
  readonly type: typeof BROWSER_ANNOTATION_STATUS_MESSAGE;
  readonly linked: boolean;
  readonly active: boolean;
  readonly browserContext?: BrowserAnnotationBrowserContext;
  readonly error?: string;
}

export interface BrowserAnnotationGroupedTab {
  readonly id: number;
  readonly url?: string;
  readonly title?: string;
  readonly active: boolean;
  readonly groupId: number | null;
  readonly windowId: number | null;
  readonly index: number | null;
  readonly kind: "t3code" | "dev-server" | "other";
}

export interface BrowserAnnotationBrowserContext {
  readonly currentTabId: number | null;
  readonly currentGroupId: number | null;
  readonly groupedTabs: ReadonlyArray<BrowserAnnotationGroupedTab>;
  readonly annotationTarget?: BrowserAnnotationGroupedTab;
  readonly ambiguous: boolean;
}

export interface BrowserAnnotationCaptureMessage {
  readonly source: typeof BROWSER_ANNOTATION_EXTENSION_SOURCE;
  readonly type: typeof BROWSER_ANNOTATION_CAPTURE_MESSAGE;
  readonly text: string;
  readonly screenshotDataUrl: string;
  readonly pageUrl: string;
  readonly pageTitle: string;
  readonly selectorLabel?: string;
}

export type BrowserAnnotationExtensionMessage =
  | BrowserAnnotationReadyMessage
  | BrowserAnnotationStatusMessage
  | BrowserAnnotationCaptureMessage;

export function isBrowserAnnotationExtensionMessage(
  value: unknown,
): value is BrowserAnnotationExtensionMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;
  return (
    message.source === BROWSER_ANNOTATION_EXTENSION_SOURCE &&
    (message.type === BROWSER_ANNOTATION_READY_MESSAGE ||
      message.type === BROWSER_ANNOTATION_STATUS_MESSAGE ||
      message.type === BROWSER_ANNOTATION_CAPTURE_MESSAGE)
  );
}

export function isBrowserAnnotationCaptureMessage(
  value: unknown,
): value is BrowserAnnotationCaptureMessage {
  if (!isBrowserAnnotationExtensionMessage(value)) {
    return false;
  }
  if (value.type !== BROWSER_ANNOTATION_CAPTURE_MESSAGE) {
    return false;
  }

  return (
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    typeof value.screenshotDataUrl === "string" &&
    value.screenshotDataUrl.startsWith("data:image/") &&
    typeof value.pageUrl === "string" &&
    typeof value.pageTitle === "string" &&
    (value.selectorLabel === undefined || typeof value.selectorLabel === "string")
  );
}

export function estimateDataUrlByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return 0;
  }

  const header = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return 0;
  }

  if (!header.includes(";base64")) {
    try {
      return new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
    } catch {
      return payload.length;
    }
  }

  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function browserAnnotationPrompt(input: {
  readonly text: string;
  readonly pageUrl: string;
  readonly pageTitle: string;
  readonly selectorLabel?: string;
}): string {
  const lines = [
    input.text.trim(),
    "",
    "Browser annotation:",
    `- Page: ${input.pageTitle || input.pageUrl}`,
    `- URL: ${input.pageUrl}`,
  ];

  const selectorLabel = input.selectorLabel?.trim();
  if (selectorLabel) {
    lines.push(`- Element: ${selectorLabel}`);
  }

  return lines.join("\n");
}
