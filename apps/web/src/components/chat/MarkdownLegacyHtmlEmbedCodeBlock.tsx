import { AppWindowIcon, CodeIcon, Maximize2Icon } from "lucide-react";
import { use, useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LegacyHtmlEmbedDialog, LegacyHtmlEmbedFrame } from "./LegacyHtmlEmbed";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { findRevealRef, MarkdownFindContext } from "./markdownFindContext";

/**
 * Legacy `t3-html` fences render as a sandboxed HTML page once the response
 * settles and the fence is closed; until then, and behind the code toggle,
 * they keep the highlighted source.
 */
export function MarkdownLegacyHtmlEmbedCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  isStreaming,
  isClosed,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  isStreaming: boolean;
  isClosed: boolean;
  children: ReactNode;
}) {
  const [showCode, setShowCode] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const searching = use(MarkdownFindContext);
  const revealSource = () => setShowCode(true);
  const sourceRevealRef = findRevealRef(revealSource);
  const canShowEmbed = !isStreaming && isClosed && code.trim().length > 0;
  const showEmbed = canShowEmbed && !showCode;
  const toggleLabel = showCode ? "Show embed" : "Show code";
  return (
    <MarkdownCodeBlock
      code={code}
      language={language}
      fenceTitle={fenceTitle}
      theme={theme}
      isStreaming={isStreaming}
      canWrap={!showEmbed}
      diagram={showEmbed}
      viewToggle={
        canShowEmbed ? (
          <span className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    onClick={() => setShowCode((value) => !value)}
                    aria-label={toggleLabel}
                  />
                }
              >
                {showCode ? <AppWindowIcon className="size-3" /> : <CodeIcon className="size-3" />}
              </TooltipTrigger>
              <TooltipPopup side="top">{toggleLabel}</TooltipPopup>
            </Tooltip>
            {showEmbed ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      onClick={() => setExpanded(true)}
                      aria-label="Expand embed"
                    />
                  }
                >
                  <Maximize2Icon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Expand embed</TooltipPopup>
              </Tooltip>
            ) : null}
          </span>
        ) : null
      }
    >
      {showEmbed ? (
        <>
          <LegacyHtmlEmbedFrame html={code} />
          <LegacyHtmlEmbedDialog html={code} open={expanded} onOpenChange={setExpanded} />
          {/* Find counts the source; a selected match here switches to it. */}
          {searching ? (
            <pre ref={sourceRevealRef} hidden>
              {code}
            </pre>
          ) : null}
        </>
      ) : (
        children
      )}
    </MarkdownCodeBlock>
  );
}
