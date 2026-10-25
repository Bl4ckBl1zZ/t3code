/**
 * Before `html_render`, a fork of T3 Code had agents write live HTML as
 * ```t3-html fences in their replies. No agent is told about them anymore, but
 * threads from that fork still hold them, so clients show each closed one as
 * an inline HTML render instead of its source.
 */
const LEGACY_HTML_EMBED_LANGUAGE = "t3-html";

export function isLegacyHtmlEmbedLanguage(language: string | null | undefined): boolean {
  return language?.trim().toLowerCase() === LEGACY_HTML_EMBED_LANGUAGE;
}

export type LegacyHtmlEmbedMarkdownSegment =
  | { readonly kind: "markdown"; readonly markdown: string; readonly sourceOffset: number }
  | { readonly kind: "html-embed"; readonly html: string; readonly sourceOffset: number };

interface FenceRun {
  readonly indent: number;
  readonly char: string;
  readonly length: number;
  readonly info: string;
}

// The fence a line opens or closes, per CommonMark: up to three spaces, then
// three or more backticks or tildes.
function fenceRun(line: string): FenceRun | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const [, indent = "", marker = "", info = ""] = match;
  // A backtick fence cannot carry a backtick in its info string.
  if (marker[0] === "`" && info.includes("`")) return null;
  return { indent: indent.length, char: marker[0]!, length: marker.length, info };
}

/**
 * For renderers that draw markdown as one native view and cannot swap a code block for an
 * embed. Nested fences stay text, and an unclosed one (a reply cut mid-embed) stays
 * markdown so it shows as code rather than half a page.
 */
export function splitLegacyHtmlEmbedMarkdown(
  markdown: string,
): ReadonlyArray<LegacyHtmlEmbedMarkdownSegment> {
  if (!markdown.includes(LEGACY_HTML_EMBED_LANGUAGE)) {
    return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  }

  const segments: LegacyHtmlEmbedMarkdownSegment[] = [];
  let cursor = 0;
  let open: { readonly run: FenceRun; readonly start: number; readonly bodyStart: number } | null =
    null;
  let lineStart = 0;
  while (lineStart < markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const next = newline === -1 ? markdown.length : newline + 1;
    const run = fenceRun(markdown.slice(lineStart, lineEnd).replace(/\r$/, ""));
    if (open === null) {
      if (run) open = { run, start: lineStart, bodyStart: next };
    } else if (
      run &&
      run.char === open.run.char &&
      run.length >= open.run.length &&
      run.info.trim() === ""
    ) {
      const opener = open.run;
      const html = markdown
        .slice(open.bodyStart, Math.max(open.bodyStart, lineStart - 1))
        .replace(/\r$/, "");
      if (
        opener.indent === 0 &&
        isLegacyHtmlEmbedLanguage(opener.info.trim().split(/\s/, 1)[0]) &&
        html.trim() !== ""
      ) {
        if (open.start > cursor) {
          segments.push({
            kind: "markdown",
            markdown: markdown.slice(cursor, open.start),
            sourceOffset: cursor,
          });
        }
        segments.push({
          kind: "html-embed",
          html,
          sourceOffset: open.start,
        });
        cursor = next;
      }
      open = null;
    }
    lineStart = next;
  }

  if (cursor < markdown.length) {
    segments.push({ kind: "markdown", markdown: markdown.slice(cursor), sourceOffset: cursor });
  }
  return segments.length > 0 ? segments : [{ kind: "markdown", markdown, sourceOffset: 0 }];
}
