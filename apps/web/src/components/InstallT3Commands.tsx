import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

const FORK_RELEASES_URL = "https://github.com/Bl4ckBl1zZ/t3code/releases";

/**
 * Setup steps for another computer: get `t3`, then run `command`. This fork ships `t3` only inside
 * the desktop app; upstream's install scripts would install official T3 Code instead.
 */
export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">
        Install the desktop app from{" "}
        <a
          className="underline underline-offset-2 hover:text-foreground"
          href={FORK_RELEASES_URL}
          rel="noreferrer"
          target="_blank"
        >
          this fork's releases
        </a>{" "}
        and choose <strong>Install</strong> next to <strong>t3 command</strong> in Settings →
        General → About. Then run
      </p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        Skip the install if you already have <code className="font-mono">t3</code>.
      </p>
    </div>
  );
}
