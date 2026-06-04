import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  WorkspaceFileChangeEvent,
  WorkspaceFileError,
  WorkspaceListDirectoryInput,
  WorkspaceReadFileResult,
  WorkspaceWriteFileInput,
} from "./workspaceFiles.ts";

const decodeListDirectoryInput = Schema.decodeUnknownSync(WorkspaceListDirectoryInput);
const decodeReadFileResult = Schema.decodeUnknownSync(WorkspaceReadFileResult);
const decodeWriteFileInput = Schema.decodeUnknownSync(WorkspaceWriteFileInput);
const decodeChangeEvent = Schema.decodeUnknownSync(WorkspaceFileChangeEvent);

describe("workspace file contracts", () => {
  it("decodes bounded directory list input and trims the workspace root", () => {
    const decoded = decodeListDirectoryInput({
      cwd: " /repo ",
      relativePath: " src ",
      limit: 100,
    });

    expect(decoded.cwd).toBe("/repo");
    expect(decoded.relativePath).toBe(" src ");
  });

  it("rejects directory list limits above the protocol cap", () => {
    expect(() =>
      decodeListDirectoryInput({
        cwd: "/repo",
        limit: 5001,
      }),
    ).toThrow();
  });

  it("decodes explicit binary and too-large file states", () => {
    const decoded = decodeReadFileResult({
      cwd: "/repo",
      relativePath: "asset.bin",
      exists: true,
      contents: null,
      version: null,
      encoding: "utf8",
      eol: "none",
      readonly: false,
      binary: true,
      tooLarge: false,
    });

    expect(decoded.contents).toBeNull();
    expect(decoded.binary).toBe(true);
  });

  it("requires an optimistic write version, including null for create-if-missing", () => {
    const decoded = decodeWriteFileInput({
      cwd: "/repo",
      relativePath: "src/index.ts",
      contents: "export {};\n",
      expectedVersion: null,
      create: true,
    });

    expect(decoded.expectedVersion).toBeNull();
    expect(decoded.create).toBe(true);
  });

  it("rejects empty relative paths for file operations and change events", () => {
    expect(() =>
      decodeWriteFileInput({
        cwd: "/repo",
        relativePath: "",
        contents: "",
        expectedVersion: null,
      }),
    ).toThrow();

    expect(() =>
      decodeChangeEvent({
        cwd: "/repo",
        relativePath: "",
        kind: "updated",
        directoryPath: "",
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("preserves tagged workspace file errors", () => {
    const error = new WorkspaceFileError({
      code: "conflict",
      message: "File changed on disk.",
      cwd: "/repo",
      relativePath: "src/index.ts",
    });

    expect(error._tag).toBe("WorkspaceFileError");
    expect(error.code).toBe("conflict");
  });
});
