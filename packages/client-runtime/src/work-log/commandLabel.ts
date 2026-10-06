type CommandWrapper = "env" | "sudo";

const COMMAND_WRAPPER_OPTIONS_WITH_VALUE: Record<CommandWrapper, ReadonlySet<string>> = {
  env: new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]),
  sudo: new Set(["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-u", "--user"]),
};

const COMMAND_WRAPPER_FLAGS: Record<CommandWrapper, ReadonlySet<string>> = {
  env: new Set(["-0", "--null", "-i", "--ignore-environment", "--debug", "-v"]),
  sudo: new Set(["-A", "--askpass", "-b", "--background", "-E", "-H", "-i", "-n", "-S"]),
};

function tokenizeShellCommand(command: string): string[] | null {
  const input = command.trim();
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  let substitutionDepth = 0;
  let tokenStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (escaping) {
      current += character;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      const nextCharacter = input[index + 1];
      const isWindowsDrivePath = quote === null && /^[A-Za-z]:/.test(current);
      if (
        (quote === '"' || isWindowsDrivePath) &&
        nextCharacter !== undefined &&
        nextCharacter !== '"' &&
        nextCharacter !== "\\" &&
        nextCharacter !== "$" &&
        nextCharacter !== "`" &&
        nextCharacter !== "\n"
      ) {
        current += character;
        tokenStarted = true;
        continue;
      }
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "$" && input[index + 1] === "(") {
      current += "$(";
      substitutionDepth += 1;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (character === ")" && substitutionDepth > 0) {
      current += character;
      substitutionDepth -= 1;
      tokenStarted = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (substitutionDepth > 0) {
        current += character;
        tokenStarted = true;
        continue;
      }
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += character;
    tokenStarted = true;
  }

  if (quote !== null || escaping || substitutionDepth > 0) return null;
  if (tokenStarted) tokens.push(current);
  return tokens;
}

export function commandProgramName(command: string, depth = 0): string | null {
  if (depth >= 8) return null;
  const tokens = tokenizeShellCommand(command);
  if (tokens === null) return null;
  let index = 0;
  let wrapper: CommandWrapper | null = null;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    const tokenProgram = token.split(/[\\/]/).at(-1);
    if (tokenProgram === "env" || tokenProgram === "sudo") {
      wrapper = tokenProgram;
      index += 1;
      continue;
    }
    if (wrapper !== null && token === "--") {
      wrapper = null;
      index += 1;
      continue;
    }
    if (wrapper !== null && token.startsWith("-")) {
      if (wrapper === "env" && (token === "-S" || token === "--split-string")) {
        const splitCommand = tokens[index + 1];
        return splitCommand ? commandProgramName(splitCommand, depth + 1) : null;
      }
      if (wrapper === "env" && token.startsWith("--split-string=")) {
        return commandProgramName(token.slice("--split-string=".length), depth + 1);
      }
      if (COMMAND_WRAPPER_OPTIONS_WITH_VALUE[wrapper].has(token)) {
        if (tokens[index + 1] === undefined) return null;
        index += 2;
        continue;
      }
      if (COMMAND_WRAPPER_FLAGS[wrapper].has(token)) {
        index += 1;
        continue;
      }
      const equalsIndex = token.indexOf("=");
      if (token.startsWith("--") && equalsIndex > 2) {
        if (!COMMAND_WRAPPER_OPTIONS_WITH_VALUE[wrapper].has(token.slice(0, equalsIndex))) {
          return null;
        }
        index += 1;
        continue;
      }
      if (/^-[A-Za-z].+/.test(token) && !token.startsWith("--")) {
        let consumesNextToken = false;
        for (const [optionIndex, option] of token.slice(1).split("").entries()) {
          const shortOption = `-${option}`;
          if (COMMAND_WRAPPER_OPTIONS_WITH_VALUE[wrapper].has(shortOption)) {
            consumesNextToken = optionIndex === token.length - 2;
            break;
          }
          if (!COMMAND_WRAPPER_FLAGS[wrapper].has(shortOption)) return null;
        }
        if (consumesNextToken && tokens[index + 1] === undefined) return null;
        index += consumesNextToken ? 2 : 1;
        continue;
      }
      return null;
    }
    return token.split(/[\\/]/).at(-1) || null;
  }

  return null;
}

// Escape bytes and other control characters render as invisible gaps; display
// shows them as Unicode control pictures (ESC becomes ␛) instead. Tab, newline
// and carriage return lay out as whitespace, so CRLF scripts stay unmarked.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/** Replaces each control character with its control picture; the length does not change. */
export function withVisibleControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, (character) =>
    character === "\u007f" ? "␡" : String.fromCharCode(0x2400 + character.charCodeAt(0)),
  );
}

const POWERSHELL_PROGRAMS = new Set(["powershell", "pwsh"]);

// PowerShell's approved verbs (`Get-Verb`), plus the ForEach, Where, Sort and
// Tee of its built-in *-Object cmdlets. Cmdlets match only capitalized, as
// agents write them: lowercase `update-grub` or `install-info` are Linux tools.
const POWERSHELL_VERBS = new Set(
  `Add Approve Assert Backup Block Build Checkpoint Clear Close Compare Complete Compress Confirm Connect Convert ConvertFrom ConvertTo Copy Debug Deny Deploy Disable Disconnect Dismount Edit Enable Enter Exit Expand Export Find ForEach Format Get Grant Group Hide Import Initialize Install Invoke Join Limit Lock Measure Merge Mount Move New Open Optimize Out Ping Pop Protect Publish Push Read Receive Redo Register Remove Rename Repair Request Reset Resize Resolve Restart Restore Resume Revoke Save Search Select Send Set Show Skip Sort Split Start Step Stop Submit Suspend Switch Sync Tee Test Trace Unblock Undo Uninstall Unlock Unprotect Unpublish Unregister Update Use Wait Watch Where Write`.split(
    " ",
  ),
);

function isPowerShellCmdlet(word: string): boolean {
  const cmdlet = /^([A-Z][a-z]+(?:[A-Z][a-z]+)?)-[A-Z][A-Za-z]*$/u.exec(word);
  return cmdlet !== null && POWERSHELL_VERBS.has(cmdlet[1]!);
}

const MAX_STATEMENTS = 32;

/** Splits on unquoted `;`, `&`, `|` and newlines; enough to see how each statement starts. */
function shellStatements(command: string): string[] {
  const statements: string[] = [];
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"') index += 1;
    } else if (character === "\\") {
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/[;&|\n]/u.test(character)) {
      statements.push(command.slice(start, index));
      if (statements.length >= MAX_STATEMENTS) return statements;
      start = index + 1;
    }
  }
  statements.push(command.slice(start));
  return statements;
}

/** Whether any statement starts like PowerShell and never like POSIX shell. */
function isPowerShellScript(command: string): boolean {
  const trimmed = command.trim();
  // A leading call operator; POSIX shell cannot start a command with `&`.
  if (/^&\s*\S/u.test(trimmed)) return true;
  return shellStatements(trimmed).some((rawStatement) => {
    const statement = rawStatement.trim();
    return (
      // `$env:NAME` or `$name = value`; neither parses as POSIX shell.
      /^\$(?:env|global|local|script):/iu.test(statement) ||
      /^\$[A-Za-z_]\w*\s+=/u.test(statement) ||
      isPowerShellCmdlet(statement.match(/^\S+/u)?.[0] ?? "")
    );
  });
}

/**
 * The grammar to highlight a command with: PowerShell when pwsh or powershell
 * runs it, or when it is written in PowerShell, as Windows agents run it.
 */
export function commandHighlightLanguage(command: string): "powershell" | "shellscript" {
  const program = /^(?:&\s*)?(?:"([^"]*)"|'([^']*)'|(\S+))/u.exec(command.trim());
  const name = (program?.[1] ?? program?.[2] ?? program?.[3] ?? "")
    .split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/u, "");
  if (name && POWERSHELL_PROGRAMS.has(name)) return "powershell";
  return isPowerShellScript(command) ? "powershell" : "shellscript";
}
