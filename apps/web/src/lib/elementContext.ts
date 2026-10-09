import { type ThreadId } from "@t3tools/contracts";
import type { PickedElementPayload, PickedElementStackFrame } from "@t3tools/contracts";

export {
  extractTrailingElementContexts,
  type ExtractedElementContexts,
  type ParsedElementContextEntry,
} from "@t3tools/shared/userMessageDisplay";

const ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT = 4000;
const ELEMENT_CONTEXT_STYLES_LIMIT = 4000;
const ELEMENT_CONTEXT_LABEL_TAG_MAX = 24;

/**
 * Stable, persistable element selection captured from the in-app preview
 * browser. We deliberately keep the shape JSON-serializable so it can ride
 * through `localStorage` persistence, draft restoration, and transcript
 * snapshots without bespoke marshalling.
 */
export interface ElementContextSelection {
  /** Page URL where the element was picked. */
  pageUrl: string;
  /** Best-effort `<title>`. */
  pageTitle: string | null;
  /** Lowercase tag, e.g. `"button"`. */
  tagName: string;
  /** CSS selector — may be null when react-grab can't compute one. */
  selector: string | null;
  /** Truncated outer-HTML preview. */
  htmlPreview: string;
  /** Nearest React component display name, or null. */
  componentName: string | null;
  /** Source frame (file + line) — null when unavailable. */
  source: PickedElementStackFrame | null;
  /** Author CSS (no UA defaults). May be empty. */
  styles: string;
}

export interface ElementContextDraft extends ElementContextSelection {
  /** Stable composer-side id used for keyed rendering + dedupe. */
  id: string;
  threadId: ThreadId;
  /** ISO-8601 wall clock pick time. */
  pickedAt: string;
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/**
 * Sanitize a payload coming back from the desktop bridge before it lands in
 * the composer draft. Trims/clamps every string field so we never persist a
 * 5MB outerHTML blob and silently break `localStorage`.
 */
export function normalizeElementContextSelection(
  raw: PickedElementPayload,
): ElementContextSelection | null {
  const pageUrl = raw.pageUrl.trim();
  const tagName = raw.tagName.trim().toLowerCase();
  if (pageUrl.length === 0 || tagName.length === 0) {
    return null;
  }
  const stackFrame = raw.source ?? raw.stack[0] ?? null;
  return {
    pageUrl,
    pageTitle: raw.pageTitle?.trim() ?? null,
    tagName,
    selector: raw.selector?.trim() || null,
    htmlPreview: truncateString(normalizeText(raw.htmlPreview), ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT),
    componentName: raw.componentName?.trim() || null,
    source: stackFrame
      ? {
          functionName: stackFrame.functionName?.trim() || null,
          fileName: stackFrame.fileName?.trim() || null,
          lineNumber: stackFrame.lineNumber ?? null,
          columnNumber: stackFrame.columnNumber ?? null,
        }
      : null,
    styles: truncateString(normalizeText(raw.styles), ELEMENT_CONTEXT_STYLES_LIMIT),
  };
}

/**
 * Stable dedupe key. Two picks of the same element on the same page produce
 * the same key, so we don't end up with a runaway chip row from spam-clicks.
 */
export function elementContextDedupKey(context: ElementContextSelection): string {
  return [context.pageUrl, context.selector ?? "", context.tagName, context.componentName ?? ""]
    .join("|")
    .toLowerCase();
}

function shortenTagLabel(tagName: string): string {
  if (tagName.length <= ELEMENT_CONTEXT_LABEL_TAG_MAX) return tagName;
  return `${tagName.slice(0, ELEMENT_CONTEXT_LABEL_TAG_MAX - 1)}…`;
}

/**
 * Compact chip label — `<Button>` for component picks, `<button>` otherwise.
 * Component name takes priority because it's higher-signal for the agent.
 */
export function formatElementContextLabel(context: ElementContextSelection): string {
  if (context.componentName) return `<${context.componentName}>`;
  return `<${shortenTagLabel(context.tagName)}>`;
}

function basenameFromPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

export function formatElementContextSourceLabel(context: ElementContextSelection): string | null {
  const source = context.source;
  if (!source?.fileName) return null;
  const base = basenameFromPath(source.fileName);
  if (source.lineNumber == null) return base;
  return `${base}:${source.lineNumber}`;
}

function buildContextHeader(context: ElementContextSelection): string {
  const label = formatElementContextLabel(context);
  const source = formatElementContextSourceLabel(context);
  return source ? `${label} (${source})` : label;
}

function indentLines(value: string): string[] {
  return value.split("\n").map((line) => `  ${line}`);
}

function buildSingleContextLines(context: ElementContextSelection): string[] {
  const lines: string[] = [];
  lines.push(`- ${buildContextHeader(context)}:`);
  if (context.pageUrl.length > 0) {
    lines.push(`  url: ${context.pageUrl}`);
  }
  if (context.selector) {
    lines.push(`  selector: ${context.selector}`);
  }
  if (context.source?.fileName) {
    const { fileName, lineNumber, columnNumber } = context.source;
    const location =
      lineNumber != null
        ? `${fileName}:${lineNumber}${columnNumber != null ? `:${columnNumber}` : ""}`
        : fileName;
    lines.push(`  source: ${location}`);
  }
  const html = context.htmlPreview.trim();
  if (html.length > 0) {
    lines.push("  html:");
    lines.push(...indentLines(html));
  }
  const styles = context.styles.trim();
  if (styles.length > 0) {
    lines.push("  styles:");
    lines.push(...indentLines(styles));
  }
  return lines;
}

/**
 * Serialize element-context drafts into the `<element_context>` block we
 * append to the user's outgoing message text. Mirrors the `<terminal_context>`
 * block format so it composes cleanly when both are present.
 */
export function buildElementContextBlock(contexts: ReadonlyArray<ElementContextSelection>): string {
  if (contexts.length === 0) return "";
  const lines: string[] = [];
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index]!;
    lines.push(...buildSingleContextLines(context));
    if (index < contexts.length - 1) lines.push("");
  }
  return ["<element_context>", ...lines, "</element_context>"].join("\n");
}

export function appendElementContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<ElementContextSelection>,
): string {
  const block = buildElementContextBlock(contexts);
  if (block.length === 0) return prompt;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

const ELEMENT_CONTEXT_ID_PREFIX = "el_";
let nextElementContextSequence = 0;

export function newElementContextId(): string {
  nextElementContextSequence += 1;
  return `${ELEMENT_CONTEXT_ID_PREFIX}${nextElementContextSequence.toString(36)}`;
}
