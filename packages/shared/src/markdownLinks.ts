import { fileBasename, isWindowsAbsolutePath, stripSlashPrefixedWindowsDrive } from "./path.ts";
import { type FilePathPosition, resolvePathLinkTarget, splitPathAndPosition } from "./fileLinks.ts";

/**
 * Markdown link and inline-code path resolution, shared by the web renderer and
 * the server's thread find so both decide the same spans are file chips.
 */

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN =
  /^(?:[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*\/)+[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN =
  /^[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
// Standard OS and dev-container roots; deliberately excludes app-route-ish
// prefixes like /app/ or /chat/ so SPA routes never read as files.
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/srv/",
  "/dev/",
  "/proc/",
  "/sys/",
  "/run/",
  "/boot/",
  "/media/",
  "/workspace/",
  "/workspaces/",
] as const;
/** Reuses delimiter searches when successive candidates fall in the same run. */
function markdownRunEndFinder(markdown: string, delimiter: RegExp) {
  let runStart = -1;
  let runEnd = -1;
  return (start: number) => {
    if (start >= runStart && start <= runEnd) return runEnd;
    delimiter.lastIndex = start;
    runStart = start;
    runEnd = delimiter.exec(markdown)?.index ?? markdown.length;
    return runEnd;
  };
}

function markdownLinkTailScanner(markdown: string) {
  const whitespaceEnd = markdownRunEndFinder(markdown, /\S/g);
  const titleEnd = markdownRunEndFinder(markdown, /["']/g);
  const titleWhitespaceEnd = markdownRunEndFinder(markdown, /\S/g);
  return (start: number) => {
    const end = whitespaceEnd(start);
    if (markdown[end] === ")") return end + 1;
    if (end === start || (markdown[end] !== '"' && markdown[end] !== "'")) return null;
    const quoteEnd = titleEnd(end + 1);
    if (quoteEnd === markdown.length) return null;
    const close = titleWhitespaceEnd(quoteEnd + 1);
    return markdown[close] === ")" ? close + 1 : null;
  };
}

function markdownLinkDestinationScanner(markdown: string) {
  const whitespaceEnd = markdownRunEndFinder(markdown, /\S/g);
  const angleEnd = markdownRunEndFinder(markdown, /[>\n]/g);
  const bareEnd = markdownRunEndFinder(markdown, /[\s)]/g);
  // Separate caches keep each branch's searches moving forward even when an
  // angle destination fails and falls back to an ordinary destination.
  const angleTail = markdownLinkTailScanner(markdown);
  const bareTail = markdownLinkTailScanner(markdown);
  return (start: number) => {
    if (markdown[start] !== "(") return null;
    const hrefStart = whitespaceEnd(start + 1);
    if (markdown[hrefStart] === "<") {
      const hrefEnd = angleEnd(hrefStart + 1);
      if (hrefEnd > hrefStart + 1 && markdown[hrefEnd] === ">") {
        const end = angleTail(hrefEnd + 1);
        if (end !== null) return { hrefStart: hrefStart + 1, hrefEnd, end };
      }
    }
    const hrefEnd = bareEnd(hrefStart);
    if (hrefEnd === hrefStart) return null;
    const end = bareTail(hrefEnd);
    return end === null ? null : { hrefStart, hrefEnd, end };
  };
}

export function extractMarkdownLinkHrefs(markdown: string): string[] {
  const hrefs: string[] = [];
  const scanDestination = markdownLinkDestinationScanner(markdown);
  let cursor = 0;
  while (cursor < markdown.length) {
    const labelStart = markdown.indexOf("[", cursor);
    if (labelStart === -1) break;
    const labelEnd = markdown.indexOf("]", labelStart + 1);
    if (labelEnd === -1) break;

    // Nested opening brackets share this closing bracket. On failure, skip the
    // whole label instead of rescanning its suffix from each opening bracket.
    cursor = labelEnd + 1;
    const destination = scanDestination(cursor);
    if (!destination) continue;
    cursor = destination.end;
    const href = markdown.slice(destination.hrefStart, destination.hrefEnd).trim();
    if (href) hrefs.push(href);
  }
  return hrefs;
}

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?(?:```|$))/;
const INLINE_CODE_SPAN_PATTERN = /`([^`\n]+)`/g;

export function extractInlineCodeSpans(text: string): string[] {
  const spans: string[] = [];
  const segments = text.split(FENCED_CODE_SEGMENT_PATTERN);
  for (let index = 0; index < segments.length; index += 2) {
    for (const match of (segments[index] ?? "").matchAll(INLINE_CODE_SPAN_PATTERN)) {
      const span = match[1]?.trim();
      if (span) spans.push(span);
    }
  }
  return spans;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isWindowsDrivePathHref(href: string): boolean {
  return WINDOWS_DRIVE_PATH_PATTERN.test(safeDecode(href));
}

function unwrapMarkdownLinkDestination(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

export function normalizeMarkdownLinkDestination(value: string): string {
  return unwrapMarkdownLinkDestination(value.trim());
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

function parseFileUrlHref(
  href: string,
  options?: { readonly decodePath?: boolean },
): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const uncHostname = parsed.hostname.toLowerCase() === "localhost" ? "" : parsed.hostname;
    const rawPath = uncHostname
      ? `\\\\${uncHostname}${parsed.pathname.replaceAll("/", "\\")}`
      : parsed.pathname;
    if (rawPath.length === 0) return null;

    const normalizedPath = stripSlashPrefixedWindowsDrive(rawPath);

    return {
      path: options?.decodePath === false ? normalizedPath : safeDecode(normalizedPath),
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const target = parseFileUrlHref(normalizedHref, { decodePath: false });
  if (!target) return null;
  return `${target.path}${target.hash}`;
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") &&
      !WINDOWS_DRIVE_PATH_PATTERN.test(path) &&
      !WINDOWS_UNC_PATH_PATTERN.test(path))
  );
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
): string | null {
  if (!href) return null;
  const rawHref = normalizeMarkdownLinkDestination(href);
  if (rawHref.length === 0 || rawHref.startsWith("#")) return null;

  const fileUrlTarget = rawHref.toLowerCase().startsWith("file:")
    ? parseFileUrlHref(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = stripSlashPrefixedWindowsDrive(
    fileUrlTarget ? source.path.trim() : safeDecode(source.path.trim()),
  );
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLineColumnFromHash(decodedPath, decodedHash);
  if (!isRelativePath(pathWithPosition)) {
    return pathWithPosition;
  }

  if (!cwd) return null;
  return resolvePathLinkTarget(pathWithPosition, cwd);
}

const INLINE_CODE_DISQUALIFIER_PATTERN = /[\s`]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9_-]+$/;
// A final dot between digits marks a version or model id (`glm-5.3`,
// `Qwen2.5-Coder`), not an extension. `ls.1` and `libfoo.so.1` stay files.
const VERSION_SUFFIX_PATTERN = /\d\.\d[^.]*$/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;
const BARE_EXTENSIONLESS_POSITION_PATTERN = /^[A-Za-z0-9_-]+(?::\d+){1,2}$/;
// Any `Name:digits` shape also matches `error:1`, `port:3000`, `TODO:12`, so
// extensionless linking is limited to conventional filenames.
const EXTENSIONLESS_FILE_NAMES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Caddyfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Podfile",
  "Fastfile",
  "BUILD",
  "WORKSPACE",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CONTRIBUTORS",
  "CHANGELOG",
  "README",
  "CODEOWNERS",
]);
const SINGLE_LABEL_HOSTNAMES = new Set(["localhost"]);
// Allowlists, not full public-suffix detection: treating every dotted first
// segment as a host would swallow real paths like `conf.d/x.conf` or
// `Makefile.in:12`. Extensions that double as filename suffixes (`sh`, `md`,
// `ts`, `rs`, `in`, ...) are deliberately absent from both sets.
const GENERIC_HOSTNAME_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "ai",
  "co",
  "edu",
  "gov",
  "mil",
  "info",
  "biz",
  "xyz",
  "me",
  "tv",
  "cc",
  "gg",
  "chat",
  "cloud",
  "site",
  "online",
  "tech",
  "store",
  "link",
]);
// Country codes collide with file extensions (`.pl` Perl, `.pt` PyTorch,
// `.es` ES modules), so they only count as host evidence when the candidate
// lacks a :line suffix — an explicit line reference marks a file and wins.
const COUNTRY_HOSTNAME_TLDS = new Set([
  "uk",
  "de",
  "fr",
  "nl",
  "se",
  "no",
  "fi",
  "dk",
  "pl",
  "ch",
  "at",
  "be",
  "es",
  "it",
  "pt",
  "eu",
  "us",
  "ca",
  "au",
  "nz",
  "jp",
  "kr",
  "cn",
  "br",
  "ru",
  "mx",
  "ie",
  "cz",
  "tr",
  "sg",
  "hk",
]);

/** `127.0.0.1`, `localhost`, `example.com`, `1.2.3` — hosts and versions, not files. */
function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith(".")) return false;
  const lowered = segment.toLowerCase();
  if (SINGLE_LABEL_HOSTNAMES.has(lowered)) return true;
  if (NUMERIC_DOTTED_PATTERN.test(segment)) return true;
  const labels = lowered.split(".");
  const lastLabel = labels[labels.length - 1];
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

/**
 * Inline code spans mostly hold identifiers, commands, and refs (`node.meta`,
 * `origin/main`) rather than deliberate link destinations, so auto-linking
 * them demands stronger path evidence than an explicit markdown link does:
 * an unambiguous path prefix, a file extension, or a :line suffix.
 * Returns the resolved target path with its position, or null.
 */
export function resolveInlineCodeFileLinkTarget(codeText: string, cwd?: string): string | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || INLINE_CODE_DISQUALIFIER_PATTERN.test(trimmed)) return null;

  // Windows drive/UNC paths keep their backslashes; any other backslashes are
  // relative Windows-style paths, which neither the shape checks nor the
  // downstream resolver understand — normalize them to forward slashes.
  const candidate =
    WINDOWS_DRIVE_PATH_PATTERN.test(trimmed) || WINDOWS_UNC_PATH_PATTERN.test(trimmed)
      ? trimmed
      : trimmed.replaceAll("\\", "/");

  const hasPosition = POSITION_SUFFIX_PATTERN.test(candidate);
  if (!hasPosition && !PATH_SEPARATOR_PATTERN.test(candidate)) return null;

  const hasExplicitPathShape =
    RELATIVE_PATH_PREFIX_PATTERN.test(candidate) ||
    candidate.startsWith("/") ||
    WINDOWS_DRIVE_PATH_PATTERN.test(candidate) ||
    WINDOWS_UNC_PATH_PATTERN.test(candidate);
  if (!hasExplicitPathShape) {
    const withoutPosition = candidate.replace(POSITION_SUFFIX_PATTERN, "");
    const firstSegment = withoutPosition.split("/")[0] ?? withoutPosition;
    if (looksLikeHostname(firstSegment, hasPosition)) return null;
    const basename = fileBasename(withoutPosition);
    if (VERSION_SUFFIX_PATTERN.test(basename)) return null;
    if (!hasPosition && !FILE_EXTENSION_PATTERN.test(basename)) return null;
  }

  const resolved = resolveMarkdownFileLinkTarget(candidate, cwd);
  if (resolved) return resolved;

  // `Makefile:12` — conventional extensionless names fail the generic
  // markdown-link candidate patterns, but here the :line suffix already
  // marked the span as a file reference.
  if (
    cwd &&
    BARE_EXTENSIONLESS_POSITION_PATTERN.test(candidate) &&
    EXTENSIONLESS_FILE_NAMES.has(candidate.replace(POSITION_SUFFIX_PATTERN, ""))
  ) {
    return resolvePathLinkTarget(candidate, cwd);
  }
  return null;
}

/**
 * Whether a file link's label only names its destination (a filename or path,
 * optionally with the same position). Such labels collapse into the file chip;
 * descriptive prose is kept next to it.
 */
export function isMarkdownFileLinkLabel(label: string, file: FilePathPosition): boolean {
  const normalize = (path: string) =>
    path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const labelPosition = splitPathAndPosition(label.trim());
  const labelLine = labelPosition.line ? Number.parseInt(labelPosition.line, 10) : undefined;
  const labelColumn = labelPosition.column ? Number.parseInt(labelPosition.column, 10) : undefined;
  if (
    (labelLine !== undefined && labelLine !== file.line) ||
    (labelColumn !== undefined && labelColumn !== file.column)
  ) {
    return false;
  }
  let labelPath = normalize(labelPosition.path);
  let destinationPath = normalize(file.path);
  if (labelPath.length === 0) return true;
  if (isWindowsAbsolutePath(file.path)) {
    labelPath = labelPath.toLowerCase();
    destinationPath = destinationPath.toLowerCase();
  }
  return destinationPath === labelPath || destinationPath.endsWith(`/${labelPath}`);
}
