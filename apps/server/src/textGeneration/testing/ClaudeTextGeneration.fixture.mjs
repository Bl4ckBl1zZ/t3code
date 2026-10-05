const argv = process.argv.slice(2);
const args = argv.join(" ");
if (
  argv[argv.indexOf("--tools") + 1] !== "" ||
  !argv.includes("--disable-slash-commands") ||
  !argv.includes("--strict-mcp-config") ||
  argv.includes("--dangerously-skip-permissions") ||
  argv[argv.indexOf("--permission-mode") + 1] !== "dontAsk"
)
  process.exit(6);
if (JSON.parse(argv[argv.indexOf("--settings") + 1]).disableAllHooks !== true) process.exit(7);

function fail(message, code) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

let stdinContent = "";
if (!process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  stdinContent = Buffer.concat(chunks).toString("utf8");
}

const argsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
if (argsMustContain && !args.includes(argsMustContain)) {
  fail("args missing expected content", 2);
}

const argsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
if (argsMustNotContain && args.includes(argsMustNotContain)) {
  fail("args contained forbidden content", 3);
}

const stdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
if (stdinMustContain && !stdinContent.includes(stdinMustContain)) {
  fail("stdin missing expected content", 4);
}

const configDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
if (configDirMustBe && process.env.CLAUDE_CONFIG_DIR !== configDirMustBe) {
  fail("CLAUDE_CONFIG_DIR was " + (process.env.CLAUDE_CONFIG_DIR ?? ""), 5);
}

const stderrText = process.env.T3_FAKE_CLAUDE_STDERR;
if (stderrText) {
  process.stderr.write(stderrText + "\n");
}

process.stdout.write(process.env.T3_FAKE_CLAUDE_OUTPUT ?? "");
process.exitCode = Number(process.env.T3_FAKE_CLAUDE_EXIT_CODE ?? 0);
