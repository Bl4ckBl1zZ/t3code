import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { assistantCitationLabel, parseAssistantCitationHref } from "./assistantCitations.ts";
import { codexArtifactTemplatePresentationLabel } from "./codexArtifactTemplates.ts";
import {
  artifactTemplateFromHastProperties,
  renderCodexFileCitationsAsMarkdown,
} from "./codexMarkdownDirectives.ts";
import { buildFileLinkParentSuffixByPath, fileLinkLabel, filePathPosition } from "./fileLinks.ts";
import {
  formatProviderSkillDisplayName,
  matchInlineSkills,
  type InlineSkill,
} from "./inlineSkills.ts";
import {
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  isMarkdownFileLinkLabel,
  normalizeMarkdownLinkDestination,
  resolveInlineCodeFileLinkTarget,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdownLinks.ts";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  shouldPreserveAssistantLineBreaks,
} from "./markdownPipeline.ts";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "./proposedPlanText.ts";
import {
  deriveDisplayedUserMessageBody,
  userMessageMarkdownSegments,
} from "./userMessageDisplay.ts";

/**
 * The text thread find counts. It mirrors what the web timeline renders for
 * messages and plans, block by block, so the server's occurrence numbers name
 * the same matches the client highlights in the DOM.
 */

// Inline wrappers (including Shiki token spans) must not split a search phrase.
export const THREAD_FIND_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Fenced HTML embeds render in a sandboxed frame, so their source is not page text. */
const HTML_EMBED_CODE_CLASS = /(?:^|\s)language-t3-html(?:\s|$)/i;

const assistantProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
const assistantBreaksProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
// User prompts show raw HTML as typed rather than parsing it.
const userProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS)
  .use(remarkRehype, { allowDangerousHtml: true });

interface TextTree {
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly children?: ReadonlyArray<TextTree>;
}

/** `ChatMarkdown`'s href key: file URLs become paths and drive paths use forward slashes. */
function markdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return /^[A-Za-z]:[\\/]/.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

function plainText(node: TextTree): string {
  return node.value ?? (node.children ?? []).map(plainText).join("");
}

function codeClassName(node: TextTree): string {
  const className = node.properties?.className;
  return Array.isArray(className) ? className.join(" ") : String(className ?? "");
}

/** Uses the renderer's Markdown transforms, without mounting folded/virtualized rows. */
function markdownThreadFindText(
  markdown: string,
  options: {
    readonly userMessage?: boolean;
    readonly lineBreaks?: boolean;
    readonly cwd?: string | undefined;
    readonly skills?: ReadonlyArray<InlineSkill>;
  },
): string[] {
  const { userMessage = false, cwd, skills = [] } = options;
  const processor = userMessage
    ? userProcessor
    : options.lineBreaks
      ? assistantBreaksProcessor
      : assistantProcessor;
  const tree = processor.runSync(processor.parse(markdown)) as TextTree;
  const filePaths = [
    ...extractMarkdownLinkHrefs(renderCodexFileCitationsAsMarkdown(markdown)).flatMap((href) => {
      const target = resolveMarkdownFileLinkTarget(markdownLinkHrefKey(href), cwd);
      return target ? [filePathPosition(target).path] : [];
    }),
    ...extractInlineCodeSpans(markdown).flatMap((span) => {
      const target = resolveInlineCodeFileLinkTarget(span, cwd);
      return target ? [filePathPosition(target).path] : [];
    }),
  ];
  const parentSuffixes = buildFileLinkParentSuffixByPath(filePaths);
  const segments: string[] = [];
  let text = "";
  const flush = () => {
    if (text.trim()) segments.push(text);
    text = "";
  };
  const visit = (node: TextTree, inPre = false, inlineSkills = false) => {
    const href = node.properties?.href;
    if (node.tagName === "a" && typeof href === "string") {
      const citation = parseAssistantCitationHref(href);
      if (citation) {
        // Matches the citation chip, which shows its label instead of the link text.
        text += assistantCitationLabel(citation);
        return;
      }
      const target = resolveMarkdownFileLinkTarget(markdownLinkHrefKey(href), cwd);
      if (target) {
        const file = filePathPosition(target);
        const label = plainText(node);
        if (!isMarkdownFileLinkLabel(label, file)) text += `${label} `;
        text += fileLinkLabel(file, parentSuffixes);
        return;
      }
    }
    if (node.tagName === "code" && !inPre && node.properties?.dataInlineCode !== undefined) {
      const target = resolveInlineCodeFileLinkTarget(plainText(node), cwd);
      if (target) {
        text += fileLinkLabel(filePathPosition(target), parentSuffixes);
        return;
      }
    }
    if (
      node.tagName === "pre" &&
      node.children?.some(
        (child) => child.tagName === "code" && HTML_EMBED_CODE_CLASS.test(codeClassName(child)),
      )
    ) {
      flush();
      return;
    }
    const template = artifactTemplateFromHastProperties(node.properties);
    if (template) {
      // Matches the card's visible text; its action button is not indexed.
      flush();
      segments.push(
        template.displayName,
        codexArtifactTemplatePresentationLabel(template.artifactKind),
      );
      return;
    }
    const block = THREAD_FIND_BLOCK_TAGS.has(node.tagName ?? "");
    if (block) flush();
    if (node.type === "text" || (userMessage && node.type === "raw")) {
      let value = node.value ?? "";
      if (inlineSkills) {
        let cursor = 0;
        let rendered = "";
        for (const { start, end, skill } of matchInlineSkills(value, skills)) {
          rendered += value.slice(cursor, start) + formatProviderSkillDisplayName(skill);
          cursor = end;
        }
        value = rendered + value.slice(cursor);
      }
      text += inPre ? value : value.replace(/\r?\n/g, " ");
    }
    const renderSkills =
      node.tagName === "code" || node.tagName === "a"
        ? false
        : inlineSkills || node.tagName === "p" || node.tagName === "li";
    for (const child of node.children ?? [])
      visit(child, inPre || node.tagName === "pre", renderSkills);
    if (block) flush();
  };
  visit(tree);
  flush();
  return segments;
}

/** Plans render `$skill` tokens literally (no skill chips), so they are indexed as written. */
export function searchablePlanSegments(markdown: string, cwd?: string): readonly string[] {
  return [
    proposedPlanTitle(markdown) ?? "Proposed plan",
    ...markdownThreadFindText(stripDisplayedPlanMarkdown(markdown), { cwd }),
  ];
}

export function searchableMessageSegments(
  message: Pick<OrchestrationV2ConversationMessage, "role" | "text" | "streaming"> & {
    readonly id?: string;
    readonly createdBy?: OrchestrationV2ConversationMessage["createdBy"];
    readonly scheduledTaskId?: OrchestrationV2ConversationMessage["scheduledTaskId"];
  },
  cwd?: string,
  skills: ReadonlyArray<InlineSkill> = [],
): readonly string[] | null {
  if (message.role === "user") {
    const body = deriveDisplayedUserMessageBody({
      role: message.role,
      text: message.text,
      ...(message.id === undefined ? {} : { id: message.id }),
      ...(message.createdBy === undefined ? {} : { createdBy: message.createdBy }),
      ...(message.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: message.scheduledTaskId }),
    });
    return userMessageMarkdownSegments(body).flatMap((segment) =>
      markdownThreadFindText(segment, { userMessage: true, cwd, skills }),
    );
  }
  if (message.role !== "assistant") return null;
  const text = message.text || (message.streaming ? "" : "(empty response)");
  return markdownThreadFindText(text, {
    cwd,
    skills,
    lineBreaks: shouldPreserveAssistantLineBreaks(text),
  });
}
