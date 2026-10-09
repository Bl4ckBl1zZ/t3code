import { formatInlineTerminalContextLabel } from "@t3tools/shared/userMessageDisplay";

export { formatInlineTerminalContextLabel };

export function buildInlineTerminalContextText(
  contexts: ReadonlyArray<{
    header: string;
  }>,
): string {
  const labels: Array<string> = [];
  for (const context of contexts) {
    const header = context.header.trim();
    if (header.length > 0) {
      labels.push(formatInlineTerminalContextLabel(header));
    }
  }
  return labels.join(" ");
}

export function textContainsInlineTerminalContextLabels(
  text: string,
  contexts: ReadonlyArray<{
    header: string;
  }>,
): boolean {
  let searchStartIndex = 0;

  for (const context of contexts) {
    const label = formatInlineTerminalContextLabel(context.header);
    const matchIndex = text.indexOf(label, searchStartIndex);
    if (matchIndex === -1) {
      return false;
    }
    searchStartIndex = matchIndex + label.length;
  }

  return true;
}
