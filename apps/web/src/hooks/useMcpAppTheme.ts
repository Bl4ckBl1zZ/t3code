import { useSyncExternalStore } from "react";

/** The app theme handed to MCP Apps: its appearance and resolved CSS variables. */
export interface McpAppTheme {
  readonly appearance: "light" | "dark";
  readonly variables: Readonly<Record<string, string>>;
}

// The variables `mcpAppStyleVariables` maps onto the MCP Apps style names.
const THEME_VARIABLES = [
  "--background",
  "--foreground",
  "--card",
  "--muted",
  "--muted-foreground",
  "--border",
  "--input",
  "--ring",
  "--info",
  "--info-foreground",
  "--destructive",
  "--destructive-foreground",
  "--destructive-surface",
  "--success-foreground",
  "--warning-foreground",
  "--warning-surface",
  "--font-sans",
  "--font-mono",
  "--radius",
] as const;

const FALLBACK: McpAppTheme = { appearance: "light", variables: {} };
let current: McpAppTheme | null = null;
let currentKey = "";

/** Reads the theme off the document; keeps the previous object while nothing changed. */
function readTheme(): McpAppTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const variables: Record<string, string> = {};
  for (const name of THEME_VARIABLES) {
    const value = style.getPropertyValue(name).trim();
    if (value !== "") variables[name] = value;
  }
  const appearance = root.classList.contains("dark") ? "dark" : "light";
  const key = JSON.stringify([appearance, variables]);
  if (current === null || key !== currentKey) {
    current = { appearance, variables };
    currentKey = key;
  }
  return current;
}

// Themes, appearance and fonts are all applied to the root element's class,
// inline style, or theme id, so a change to those is the only signal needed.
function subscribe(onChange: () => void) {
  // React re-renders only when the snapshot object changes, which readTheme
  // keeps stable while the values are the same.
  const observer = new MutationObserver(() => {
    readTheme();
    onChange();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme-id"],
  });
  return () => observer.disconnect();
}

/**
 * The active theme as MCP Apps receive it in their host context. Stable
 * until the theme, appearance, or fonts change.
 */
export function useMcpAppTheme(): McpAppTheme {
  return useSyncExternalStore(
    subscribe,
    () => current ?? readTheme(),
    () => FALLBACK,
  );
}
