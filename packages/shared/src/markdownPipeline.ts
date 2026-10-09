import type { PluggableList } from "unified";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { isWindowsAbsolutePath } from "./path.ts";
import { remarkGithubAlerts } from "./markdownGithubAlerts.ts";
import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";
import {
  CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES,
  remarkCodexDirectives,
} from "./codexMarkdownDirectives.ts";
import { THREAD_LINK_PROTOCOL } from "./threadLinks.ts";

/**
 * The chat Markdown transforms. The web renders with these plugins and the
 * server's thread find parses with them, so both see the same text.
 */

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "video"],
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta", "dataInlineCode"],
    video: ["src", "controls", "muted", "loop", "playsInline", "poster", "preload"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    div: [...(defaultSchema.attributes?.div ?? []), ...CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", "t3-citation", THREAD_LINK_PROTOCOL],
    src: [...(defaultSchema.protocols?.src ?? []), "file"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  url?: string;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

interface DestinationCompileContext {
  readonly stack: ReadonlyArray<{ readonly type: string; url?: string }>;
  resume(): string;
  sliceSerialize(token: unknown): string;
}

function keepWindowsPathDestination(this: DestinationCompileContext, token: unknown) {
  const decoded = this.resume();
  const authored = this.sliceSerialize(token);
  const node = this.stack.at(-1);
  // Character references still need decoding, so those destinations keep the parsed URL.
  if (node)
    node.url = isWindowsAbsolutePath(authored) && !authored.includes("&") ? authored : decoded;
}

/**
 * CommonMark reads the `\.` in `C:\me\.t3\shot.png` as an escape, even in a link
 * destination. Every backslash in a Windows path is a separator, so link, image, and
 * definition destinations that are Windows paths keep the text as written.
 */
function remarkKeepWindowsPathDestinations(this: {
  data(): { fromMarkdownExtensions?: Array<unknown> };
}) {
  const data = this.data();
  (data.fromMarkdownExtensions ??= []).push({
    exit: {
      resourceDestinationString: keepWindowsPathDestination,
      definitionDestinationString: keepWindowsPathDestination,
    },
  });
}

/**
 * Preserve Windows drive links as allowed `file:` URLs before sanitization.
 * The same traversal tags inline code while it can still be distinguished
 * from fenced code. Code inside links stays untagged to avoid nested anchors.
 */
function remarkNormalizeLinksAndTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (
        (node.type === "link" || node.type === "definition") &&
        typeof node.url === "string" &&
        WINDOWS_DRIVE_PATH_REGEX.test(node.url)
      ) {
        node.url = `file:///${node.url.replaceAll("\\", "/")}`;
      }
      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataInlineCode: "",
          },
        };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}

interface HastNodeLike {
  readonly type: string;
  readonly tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNodeLike[];
}

function rehypeEscapeWindowsDriveMediaSrc() {
  const escapeNode = (node: HastNodeLike): void => {
    if (
      node.type === "element" &&
      (node.tagName === "img" || node.tagName === "video") &&
      node.properties &&
      typeof node.properties.src === "string" &&
      WINDOWS_DRIVE_PATH_REGEX.test(node.properties.src)
    ) {
      node.properties.src = `/${node.properties.src}`;
    }
    for (const child of node.children ?? []) {
      escapeNode(child);
    }
  };
  return escapeNode;
}

interface RawHastNode {
  type: string;
  value?: string;
  children?: RawHastNode[];
}

/** Keep unmatched inline `<A>` placeholders from opening an HTML link over later blocks. */
function rehypePreserveBareAnchorPlaceholders() {
  return (tree: RawHastNode) => {
    const anchors: Array<RawHastNode | null> = [];
    let rawTextTag: string | undefined;
    const visit = (node: RawHastNode) => {
      if (node.type === "raw" && typeof node.value === "string") {
        // Raw blocks can contain several tags. Consume whole tags, quoted attributes,
        // and comments so text resembling a closing anchor cannot pair a placeholder.
        const tags = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
        let offset = 0;
        while (rawTextTag !== "plaintext") {
          // Raw text ends at its closing tag even inside comment-looking text.
          const matcher = rawTextTag ? new RegExp(`</${rawTextTag}\\s*>`, "gi") : tags;
          matcher.lastIndex = offset;
          const match = matcher.exec(node.value);
          if (!match) break;
          const [tag] = match;
          offset = matcher.lastIndex;
          if (rawTextTag) {
            rawTextTag = undefined;
            continue;
          }
          if (tag.startsWith("<!--")) continue;
          const closing = /^<\/([a-z]+)\s*>$/i.exec(tag)?.[1]?.toLowerCase();
          const opening = /^<([a-z]+)(?:\s|\/?>)/i.exec(tag)?.[1]?.toLowerCase();
          if (
            opening &&
            /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/.test(opening)
          ) {
            rawTextTag = opening;
          } else if (opening === "a") {
            anchors.push(node.value === tag && /^<a\s*\/?>$/i.test(tag) ? node : null);
          } else if (closing === "a") {
            anchors.pop();
          }
        }
      }
      node.children?.forEach(visit);
    };

    visit(tree);
    for (const anchor of anchors) {
      if (anchor) anchor.type = "text";
    }
  };
}

export const CHAT_MARKDOWN_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkKeepWindowsPathDestinations,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: PluggableList = [
  remarkGfm,
  remarkKeepWindowsPathDestinations,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

export const CHAT_MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  rehypePreserveBareAnchorPlaceholders,
  rehypeRaw,
  rehypeEscapeWindowsDriveMediaSrc,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
];

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}
