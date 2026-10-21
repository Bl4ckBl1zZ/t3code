import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseIndexPageUrl,
  cliSelfUpdateUnavailableReason,
  newestCliReleaseVersion,
  parseChecksums,
  releaseSourcePublishesCli,
  resolveReleaseSource,
  UPSTREAM_RELEASE_SOURCE,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});

describe("release source", () => {
  const fork = resolveReleaseSource({ repository: " owner/fork ", tagPrefix: "fork-v" });

  it("falls back to upstream for unset or malformed build values", () => {
    expect(resolveReleaseSource({})).toEqual(UPSTREAM_RELEASE_SOURCE);
    expect(resolveReleaseSource({ repository: "", tagPrefix: "" })).toEqual(
      UPSTREAM_RELEASE_SOURCE,
    );
    expect(resolveReleaseSource({ repository: "not a repo", tagPrefix: 3 })).toEqual(
      UPSTREAM_RELEASE_SOURCE,
    );
    expect(fork).toEqual({ repository: "owner/fork", tagPrefix: "fork-v" });
  });

  it("lists a fork's releases and reads its tag prefix", () => {
    expect(cliReleaseIndexPageUrl(2, fork)).toBe(
      "https://api.github.com/repos/owner/fork/releases?per_page=100&page=2",
    );
    const releases = [{ tag_name: "v9.0.0" }, { tag_name: "fork-v0.1.401" }];
    expect(newestCliReleaseVersion(releases, "stable", fork.tagPrefix)).toBe("0.1.401");
    expect(newestCliReleaseVersion([{ tag_name: "fork-v0.1.401" }], "stable")).toBeUndefined();
  });

  it("offers CLI self-update only for builds released by upstream", () => {
    expect(releaseSourcePublishesCli(UPSTREAM_RELEASE_SOURCE)).toBe(true);
    expect(cliSelfUpdateUnavailableReason(UPSTREAM_RELEASE_SOURCE)).toBeNull();
    expect(releaseSourcePublishesCli(fork)).toBe(false);
    expect(cliSelfUpdateUnavailableReason(fork)).toContain(
      "https://github.com/owner/fork/releases",
    );
  });
});
