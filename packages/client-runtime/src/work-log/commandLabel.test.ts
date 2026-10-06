import { describe, expect, it } from "vite-plus/test";

import { commandHighlightLanguage, withVisibleControlCharacters } from "./commandLabel.ts";

describe("withVisibleControlCharacters", () => {
  it.each([
    ["printf '\u001b[31mred\u001b[0m'", "printf '␛[31mred␛[0m'"],
    ["echo bell\u0007 delete\u007f", "echo bell␇ delete␡"],
    ["printf 'a\\tb'\r\necho done", "printf 'a\\tb'\r\necho done"],
    ["cat <<'EOF'\n\tindented\nEOF", "cat <<'EOF'\n\tindented\nEOF"],
  ])("shows %j as %j", (input, expected) => {
    expect(withVisibleControlCharacters(input)).toBe(expected);
  });
});

describe("commandHighlightLanguage", () => {
  it.each([
    [
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Get-ChildItem -Recurse"',
      "powershell",
    ],
    [
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\work\\scripts\\doctor.ps1"',
      "powershell",
    ],
    ["& pwsh -c 'Get-Date'", "powershell"],
    ["PWSH.EXE -Command Get-Date", "powershell"],
    ["pwsh-preview -c 'Get-Date'", "shellscript"],
    ["git status; pwsh -c 'Get-Date'", "shellscript"],
    ["cat <<'EOF' > notes.txt\npwsh\nEOF", "shellscript"],
    ["", "shellscript"],
    // Windows agents also run PowerShell directly, without a pwsh wrapper.
    ["Get-Content package.json | Select-String version", "powershell"],
    ["$env:CI='1'; npm test", "powershell"],
    ["$tmp = Join-Path $env:TEMP repo; git clone example", "powershell"],
    ['"=== CHECK FILE ==="; Get-Content file.txt', "powershell"],
    ["& 'C:\\Python312\\python.exe' -c 'print(1)'", "powershell"],
    ["Install-Module Pester -Scope CurrentUser", "powershell"],
    ["ConvertTo-Json @{ a = 1 }", "powershell"],
    ["update-alternatives --list java", "shellscript"],
    ["install-info --version", "shellscript"],
    ["Make-Thing now", "shellscript"],
    ["echo Get-Content; git status", "shellscript"],
    ["FOO=1 npm test", "shellscript"],
    ["echo $HOME && ls", "shellscript"],
    // Recorded provider commands: Codex wraps its script in a login shell.
    [
      `/bin/bash -lc "node -e \\"console.log('interrupt fixture tool started'); setTimeout(() => {}, 30000)\\""`,
      "shellscript",
    ],
    ["/bin/bash -lc 'cat package.json && cat tsconfig.json'", "shellscript"],
    ["for i in 1 2 3; do sleep 8; echo tock $i; done", "shellscript"],
    ["printf 'running child approval' > running-child.txt", "shellscript"],
  ])("%s", (command, language) => {
    expect(commandHighlightLanguage(command)).toBe(language);
  });
});
