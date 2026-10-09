import { type OrchestrationV2Actor, ScheduledTaskId } from "@t3tools/contracts";

/**
 * How a stored user prompt becomes the text a user message shows. Context the
 * composer appends (terminal and element selections, preview annotations,
 * review comments, reply envelopes) renders as chips and cards, not prose. The
 * web timeline and the server's thread find both read the body through these
 * parsers, so find counts only the text the bubble shows.
 */

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

/** Older scheduled messages stored their attribution in the prompt itself. */
export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly scheduledTaskId?: ScheduledTaskId;
}) {
  if (message.role !== "user") {
    return { text: message.text, isAutomation: false, scheduledTaskId: undefined };
  }
  if (message.scheduledTaskId !== undefined) {
    return { text: message.text, isAutomation: true, scheduledTaskId: message.scheduledTaskId };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  const isAutomation =
    legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent");
  return {
    text: isAutomation ? message.text.slice(legacyPrefix[0].length) : message.text,
    isAutomation,
    scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
  };
}

// ---------------------------------------------------------------------------
// Element contexts
// ---------------------------------------------------------------------------

export interface ParsedElementContextEntry {
  header: string;
  body: string;
}

export interface ExtractedElementContexts {
  promptText: string;
  contextCount: number;
  contexts: ParsedElementContextEntry[];
}

const TRAILING_ELEMENT_CONTEXT_BLOCK_PATTERN =
  /\n*<element_context>\n([\s\S]*?)\n<\/element_context>\s*$/;

/** Splits `- header:` entries with two-space indented bodies, as both context blocks write them. */
function parseContextBlockEntries(block: string): Array<{ header: string; body: string }> {
  const entries: Array<{ header: string; body: string }> = [];
  let current: { header: string; bodyLines: string[] } | null = null;
  const commit = () => {
    if (!current) return;
    entries.push({ header: current.header, body: current.bodyLines.join("\n").trimEnd() });
    current = null;
  };
  for (const line of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(line);
    if (headerMatch) {
      commit();
      current = { header: headerMatch[1]!, bodyLines: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("  ")) current.bodyLines.push(line.slice(2));
    else if (line.length === 0) current.bodyLines.push("");
  }
  commit();
  return entries;
}

/**
 * Detects (and strips) a trailing `<element_context>` block so the original
 * prompt body and its chips can render separately in user-message bubbles.
 */
export function extractTrailingElementContexts(prompt: string): ExtractedElementContexts {
  const match = TRAILING_ELEMENT_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return { promptText: prompt, contextCount: 0, contexts: [] };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const contexts = parseContextBlockEntries(match[1] ?? "");
  return { promptText, contextCount: contexts.length, contexts };
}

// ---------------------------------------------------------------------------
// Terminal contexts
// ---------------------------------------------------------------------------

export interface ParsedTerminalContextEntry {
  header: string;
  body: string;
}

export interface ExtractedTerminalContexts {
  promptText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedTerminalContextEntry[];
}

export interface DisplayedUserMessageState {
  visibleText: string;
  copyText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedTerminalContextEntry[];
  /**
   * Element-context entries extracted from the trailing `<element_context>`
   * block (if any). Stripped from `visibleText` so the raw block doesn't
   * leak into the user's bubble.
   */
  elementContexts: ParsedElementContextEntry[];
}

const TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN =
  /\n*<terminal_context>\n([\s\S]*?)\n<\/terminal_context>\s*$/;

export function extractTrailingTerminalContexts(prompt: string): ExtractedTerminalContexts {
  const match = TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const parsedContexts = parseContextBlockEntries(match[1] ?? "");
  return {
    promptText,
    contextCount: parsedContexts.length,
    previewTitle:
      parsedContexts.length > 0
        ? parsedContexts
            .map(({ header, body }) => (body.length > 0 ? `${header}\n${body}` : header))
            .join("\n\n")
        : null,
    contexts: parsedContexts,
  };
}

export function deriveDisplayedUserMessageState(prompt: string): DisplayedUserMessageState {
  // Order matters: send-time appends `<terminal_context>` first, then
  // `<element_context>` last. Strip element first so the (now-trailing)
  // terminal block can be matched by `extractTrailingTerminalContexts`.
  const extractedElement = extractTrailingElementContexts(prompt);
  const extractedTerminal = extractTrailingTerminalContexts(extractedElement.promptText);
  return {
    visibleText: extractedTerminal.promptText,
    copyText: prompt,
    contextCount: extractedTerminal.contextCount,
    previewTitle: extractedTerminal.previewTitle,
    contexts: extractedTerminal.contexts,
    elementContexts: extractedElement.contexts,
  };
}

export function formatInlineTerminalContextSelectionLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  const terminalLabel = selection.terminalLabel.trim().toLowerCase().replace(/\s+/g, "-");
  const range =
    selection.lineStart === selection.lineEnd
      ? `${selection.lineStart}`
      : `${selection.lineStart}-${selection.lineEnd}`;
  return `@${terminalLabel}:${range}`;
}

const TERMINAL_CONTEXT_HEADER_PATTERN = /^(.*?)\s+line(?:s)?\s+(\d+)(?:-(\d+))?$/i;

/** The `@terminal:12-14` label a parsed terminal-context header shows inline. */
export function formatInlineTerminalContextLabel(header: string): string {
  const trimmedHeader = header.trim();
  const match = TERMINAL_CONTEXT_HEADER_PATTERN.exec(trimmedHeader);
  if (!match) {
    return `@${trimmedHeader.toLowerCase().replace(/\s+/g, "-")}`;
  }

  const lineStart = Number.parseInt(match[2] ?? "", 10);
  const lineEnd = Number.parseInt(match[3] ?? match[2] ?? "", 10);
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) {
    return `@${trimmedHeader.toLowerCase().replace(/\s+/g, "-")}`;
  }

  return formatInlineTerminalContextSelectionLabel({
    terminalLabel: match[1]?.trim() || "terminal",
    lineStart,
    lineEnd,
  });
}

// ---------------------------------------------------------------------------
// Preview annotations
// ---------------------------------------------------------------------------

const TRAILING_PREVIEW_ANNOTATION_BLOCK_PATTERN =
  /\n*<preview_annotation>\n((?:(?!<preview_annotation>)[\s\S])*)\n<\/preview_annotation>\s*$/;

export interface ParsedPreviewAnnotation {
  id: string;
  title: string;
  comment: string;
  targetSummary: string;
  styleChanges: string[];
  hasScreenshot: boolean;
}

export interface ExtractedPreviewAnnotation {
  promptText: string;
  annotation: ParsedPreviewAnnotation | null;
}

export function extractTrailingPreviewAnnotation(prompt: string): ExtractedPreviewAnnotation {
  const match = TRAILING_PREVIEW_ANNOTATION_BLOCK_PATTERN.exec(prompt);
  if (!match) return { promptText: prompt, annotation: null };
  const body = match[1] ?? "";
  const lines = body.split("\n");
  const pageLine = lines.find((line) => line.startsWith("Page: "));
  const idLine = lines.find((line) => line.startsWith("Id: "));
  const commentLine = lines.find((line) => line.startsWith("Comment: "));
  const targetsLine = lines.find((line) => line.startsWith("Targets: "));
  const styleHeadingIndex = lines.indexOf("Requested visual changes:");
  const linesAfterStyleHeading = lines.slice(styleHeadingIndex + 1);
  const elementContextIndex = linesAfterStyleHeading.indexOf("<element_context>");
  const styleChanges =
    styleHeadingIndex < 0
      ? []
      : linesAfterStyleHeading
          .slice(0, elementContextIndex < 0 ? undefined : elementContextIndex)
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2));
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    annotation: {
      id: idLine?.slice("Id: ".length).trim() || `${match.index}`,
      title: pageLine?.slice("Page: ".length).trim() || "Preview annotation",
      comment: commentLine?.slice("Comment: ".length).trim() || "",
      targetSummary: targetsLine?.slice("Targets: ".length).trim() || "",
      styleChanges,
      hasScreenshot: body.includes("The attached screenshot is the annotated preview crop."),
    },
  };
}

// ---------------------------------------------------------------------------
// Reply envelopes
// ---------------------------------------------------------------------------

export interface ParsedMessageReply {
  readonly referencedText: string;
  readonly messageText: string;
}

const REPLY_ENVELOPE_PREFIX = "[Replying to:";
const OWN_MESSAGE_REPLY_ENVELOPE_PREFIX = "[Replying to your previous message:";
const REPLY_ENVELOPE_PATTERN =
  /^\s*\[Replying to(?: your previous message)?:\s*"([\s\S]*?)"\][ \t]*(?:\r?\n)+([\s\S]+)$/;

/**
 * Hermes transports encode reply metadata in a leading text envelope. Keep
 * this parser deliberately strict so an ordinary message that happens to
 * mention "Replying to" is not reformatted.
 */
export function extractLeadingMessageReply(text: string): ParsedMessageReply | null {
  const trimmedStart = text.trimStart();
  if (
    !trimmedStart.startsWith(REPLY_ENVELOPE_PREFIX) &&
    !trimmedStart.startsWith(OWN_MESSAGE_REPLY_ENVELOPE_PREFIX)
  ) {
    return null;
  }

  const match = REPLY_ENVELOPE_PATTERN.exec(text);
  if (!match) {
    return null;
  }

  const referencedText = (match[1] ?? "").trim();
  const messageText = (match[2] ?? "").trim();
  if (referencedText.length === 0 || messageText.length === 0) {
    return null;
  }

  return { referencedText, messageText };
}

// ---------------------------------------------------------------------------
// Review comments
// ---------------------------------------------------------------------------

export interface ReviewCommentSelection {
  readonly start: number;
  readonly side: "additions" | "deletions";
  readonly end: number;
  readonly endSide: "additions" | "deletions";
}

export interface ReviewCommentContext {
  readonly id: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rangeLabel: string;
  readonly text: string;
  readonly diff: string;
  readonly fenceLanguage?: string | undefined;
  readonly selection?: ReviewCommentSelection | undefined;
}

export type ReviewCommentMessageSegment =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly kind: "review-comment";
      readonly comment: ReviewCommentContext;
    };

const REVIEW_COMMENT_BLOCK_PATTERN = /<review_comment\b([^>]*)>\s*([\s\S]*?)<\/review_comment>/g;
const REVIEW_COMMENT_ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;
const REVIEW_COMMENT_FENCE_PATTERN = /(`{3,})([^\s`]*)[^\n]*\n([\s\S]*?)\n\1/g;

function unescapeReviewCommentAttribute(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function readReviewCommentAttributes(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of rawAttributes.matchAll(REVIEW_COMMENT_ATTRIBUTE_PATTERN)) {
    attributes[match[1]!] = unescapeReviewCommentAttribute(match[2] ?? "");
  }
  return attributes;
}

function readNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

function extractReviewCommentBody(rawBody: string): {
  text: string;
  language: string;
  contents: string;
} {
  const matches = Array.from(rawBody.matchAll(REVIEW_COMMENT_FENCE_PATTERN));
  const match = matches.at(-1);
  const fenceIndex = match?.index;
  return {
    text: rawBody.slice(0, fenceIndex ?? rawBody.length).trim(),
    language: match?.[2]?.trim() || "diff",
    contents: match?.[3] ?? "",
  };
}

function parseReviewCommentContext(
  rawAttributes: string,
  rawBody: string,
  index: number,
): ReviewCommentContext | null {
  const attributes = readReviewCommentAttributes(rawAttributes);
  const startIndex = readNonNegativeInteger(attributes.startIndex);
  const endIndex = readNonNegativeInteger(attributes.endIndex);
  const filePath = attributes.filePath?.trim();
  const sectionId = attributes.sectionId?.trim();
  if (!filePath || !sectionId || startIndex === null || endIndex === null) {
    return null;
  }
  const body = extractReviewCommentBody(rawBody);

  return {
    id: `review-comment:${index}:${sectionId}:${filePath}:${startIndex}:${endIndex}`,
    sectionId,
    sectionTitle: attributes.sectionTitle?.trim() || "Review",
    filePath,
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
    rangeLabel: attributes.rangeLabel?.trim() || "line",
    text: body.text,
    diff: body.contents,
    fenceLanguage: body.language,
  };
}

export function parseReviewCommentMessageSegments(
  value: string,
): ReadonlyArray<ReviewCommentMessageSegment> {
  const segments: ReviewCommentMessageSegment[] = [];
  let cursor = 0;
  let parsedCommentIndex = 0;

  for (const match of value.matchAll(REVIEW_COMMENT_BLOCK_PATTERN)) {
    const matchIndex = match.index ?? 0;
    const beforeText = value.slice(cursor, matchIndex);
    if (beforeText.length > 0) {
      segments.push({
        kind: "text",
        id: `review-comment-text:${cursor}`,
        text: beforeText,
      });
    }

    const comment = parseReviewCommentContext(match[1] ?? "", match[2] ?? "", parsedCommentIndex);
    if (comment) {
      segments.push({ kind: "review-comment", comment });
      parsedCommentIndex += 1;
    } else {
      segments.push({
        kind: "text",
        id: `review-comment-invalid:${matchIndex}`,
        text: match[0],
      });
    }

    cursor = matchIndex + match[0].length;
  }

  const rest = value.slice(cursor);
  if (rest.length > 0) {
    segments.push({
      kind: "text",
      id: `review-comment-text:${cursor}`,
      text: rest,
    });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// The displayed body
// ---------------------------------------------------------------------------

export interface DisplayedUserMessageBody {
  /** Prompt text the bubble renders as Markdown, before review/terminal splitting. */
  readonly text: string;
  readonly terminalContexts: ReadonlyArray<ParsedTerminalContextEntry>;
  readonly elementContexts: ReadonlyArray<ParsedElementContextEntry>;
  /** Oldest first, as the cards render. */
  readonly previewAnnotations: ReadonlyArray<ParsedPreviewAnnotation>;
  readonly reply: ParsedMessageReply | null;
}

/** Strips appended context blocks in the order the timeline does. */
export function deriveDisplayedUserMessageBody(
  message: Parameters<typeof resolveUserMessagePresentation>[0],
): DisplayedUserMessageBody {
  const displayed = deriveDisplayedUserMessageState(resolveUserMessagePresentation(message).text);
  const previewAnnotations: ParsedPreviewAnnotation[] = [];
  let visibleText = displayed.visibleText;
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visibleText);
    if (!extracted.annotation) break;
    previewAnnotations.unshift(extracted.annotation);
    visibleText = extracted.promptText;
  }
  const elementContextState = extractTrailingElementContexts(visibleText);
  const reply = extractLeadingMessageReply(elementContextState.promptText);
  return {
    text: reply?.messageText ?? elementContextState.promptText,
    terminalContexts: displayed.contexts,
    elementContexts: [...displayed.elementContexts, ...elementContextState.contexts],
    previewAnnotations,
    reply,
  };
}

/**
 * The Markdown sources a user bubble renders, each as its own block: review
 * comment cards and inline terminal-context chips split the prose around them.
 */
export function userMessageMarkdownSegments(body: DisplayedUserMessageBody): string[] {
  const reviewSegments = parseReviewCommentMessageSegments(body.text);
  if (reviewSegments.some((segment) => segment.kind === "review-comment")) {
    return reviewSegments.flatMap((segment) =>
      segment.kind === "text" && segment.text.trim().length > 0 ? [segment.text.trim()] : [],
    );
  }
  if (body.terminalContexts.length > 0) {
    const segments: string[] = [];
    let cursor = 0;
    let embedded = true;
    for (const context of body.terminalContexts) {
      const label = formatInlineTerminalContextLabel(context.header);
      const matchIndex = body.text.indexOf(label, cursor);
      if (matchIndex === -1) {
        embedded = false;
        break;
      }
      if (matchIndex > cursor) segments.push(body.text.slice(cursor, matchIndex));
      cursor = matchIndex + label.length;
    }
    if (embedded) {
      if (cursor < body.text.length) segments.push(body.text.slice(cursor));
      return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
    }
  }
  return body.text.length > 0 ? [body.text] : [];
}
