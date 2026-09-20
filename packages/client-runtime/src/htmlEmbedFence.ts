/**
 * Where a `t3-html` embed is in its life, shared by the web and React Native
 * renderers.
 *
 * An embed only goes live once its fence closes. Half a document reloads a
 * sandboxed frame on every token and paints almost nothing — most embeds open
 * with `<style>` — so a streaming embed reads as a dead box that pops at the
 * end. Until the fence closes the renderers show a placeholder instead, and
 * the phase is what tells them which one.
 */

export type HtmlEmbedPhase =
  /** The fence closed: the source is final and safe to run. */
  | "ready"
  /** The fence is still open and the turn is still going. */
  | "building"
  /** The turn ended mid-fence. There is no embed coming; say so. */
  | "incomplete";

export interface OpenHtmlEmbedFence {
  /** Offset of the opening line, where a parser that keeps the indent starts. */
  readonly start: number;
  /** Offset of the fence marker, where mdast starts an indented fence. */
  readonly marker: number;
  /** Body written so far, for renderers that see content but no offsets. */
  readonly body: string;
}

interface FenceRun {
  /** Offset of the fence marker within the line, so an indent can be skipped. */
  readonly indent: number;
  readonly char: string;
  readonly length: number;
  readonly info: string;
}

/**
 * The fence run a line opens or closes with, if any.
 *
 * Hand-scanned rather than matched: this runs per line of every streaming
 * message that contains an embed, and a regular expression built per line is
 * the kind of cost that only shows up on someone else's machine.
 */
function fenceRun(text: string, from: number, to: number): FenceRun | null {
  let at = from;
  while (at < to && text[at] === " " && at - from < 3) at += 1;
  const char = text[at];
  if (char !== "`" && char !== "~") return null;
  const markerStart = at;
  while (at < to && text[at] === char) at += 1;
  if (at - markerStart < 3) return null;
  return {
    indent: markerStart - from,
    char,
    length: at - markerStart,
    info: text.slice(at, to),
  };
}

function isBlank(text: string): boolean {
  for (const character of text) {
    if (character !== " " && character !== "\t" && character !== "\r") return false;
  }
  return true;
}

function fenceLanguage(info: string): string {
  return info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

/**
 * The unterminated `t3-html` fence at the end of `markdown`, if there is one.
 *
 * At most one fence can be open — an unclosed fence swallows the rest of the
 * document — so this is the only embed in a message that can still be growing.
 */
export function findOpenHtmlEmbedFence(markdown: string): OpenHtmlEmbedFence | null {
  let open: { start: number; marker: number; run: FenceRun; bodyStart: number } | null = null;
  let lineStart = 0;

  while (lineStart <= markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const run = fenceRun(markdown, lineStart, lineEnd);

    if (open) {
      if (run && run.char === open.run.char && run.length >= open.run.length && isBlank(run.info)) {
        open = null;
      }
    } else if (run && !(run.char === "`" && run.info.includes("`"))) {
      // A backtick fence cannot carry a backtick in its info string, which is
      // what keeps an inline-code run from opening a block.
      open = {
        start: lineStart,
        marker: lineStart + run.indent,
        run,
        bodyStart: lineEnd + 1,
      };
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  if (!open || fenceLanguage(open.run.info) !== "t3-html") return null;
  const body = markdown.slice(Math.min(open.bodyStart, markdown.length));
  return {
    start: open.start,
    marker: open.marker,
    body: body.endsWith("\n") ? body.slice(0, -1) : body,
  };
}

/**
 * Which phase an embed block is in.
 *
 * `offset` is the block's start as its parser reported it — anywhere on the
 * opening fence line, since parsers disagree about whether an indent counts.
 * Renderers that have no offsets fall back to matching the body they were
 * handed, which only misreads two byte-identical embeds in one streaming
 * message, and only until that message ends.
 */
export function htmlEmbedPhase(input: {
  readonly openFence: OpenHtmlEmbedFence | null;
  readonly streaming: boolean;
  readonly offset?: number | null | undefined;
  readonly html: string;
}): HtmlEmbedPhase {
  const fence = input.openFence;
  if (!fence) return "ready";

  const isOpenBlock =
    input.offset != null
      ? input.offset >= fence.start && input.offset <= fence.marker
      : input.html.trimEnd() === fence.body.trimEnd();
  if (!isOpenBlock) return "ready";

  return input.streaming ? "building" : "incomplete";
}
