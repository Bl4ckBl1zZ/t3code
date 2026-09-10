import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "./settings.ts";
import { resolveEnvironmentMachineKind } from "./server.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("treats a missing attachment upload capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.attachmentUploads).toBeUndefined();
  });

  it("preserves an advertised attachment upload capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, attachmentUploads: true },
      }).capabilities.attachmentUploads,
    ).toBe(true);
  });

  it("preserves the server's generic attachment upload limit", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
        },
      }).capabilities.fileAttachments,
    ).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
  });
});

describe("environment machine identity", () => {
  it("keeps known detection and ignores future kinds", () => {
    expect(
      decodeDescriptor({ ...descriptor, platform: { ...descriptor.platform, machine: "mac-mini" } })
        .platform.machine,
    ).toBe("mac-mini");
    expect(
      decodeDescriptor({ ...descriptor, platform: { ...descriptor.platform, machine: "quantum" } })
        .platform.machine,
    ).toBeUndefined();
    expect(decodeDescriptor(descriptor).capabilities.environmentIcon).toBeUndefined();
  });
  it("resolves overrides before detection, with safe old-server fallbacks", () => {
    const environment = decodeDescriptor({
      ...descriptor,
      platform: { ...descriptor.platform, machine: "laptop" },
    });
    expect(resolveEnvironmentMachineKind({ environment, settings: DEFAULT_SERVER_SETTINGS })).toBe(
      "laptop",
    );
    expect(
      resolveEnvironmentMachineKind({
        environment,
        settings: { ...DEFAULT_SERVER_SETTINGS, environmentIcon: "cloud" },
      }),
    ).toBe("cloud");
    expect(
      resolveEnvironmentMachineKind({
        environment: decodeDescriptor(descriptor),
        settings: DEFAULT_SERVER_SETTINGS,
      }),
    ).toBe("server");
    expect(resolveEnvironmentMachineKind(null)).toBe("server");
  });
  it("drops a future persisted override but rejects unsupported writes", () => {
    expect(decodeSettings({ environmentIcon: "future" }).environmentIcon).toBeNull();
    expect(() => decodePatch({ environmentIcon: "future" })).toThrow();
    expect(decodePatch({ environmentIcon: null })).toEqual({
      environmentIcon: null,
    });
    expect(decodePatch({})).not.toHaveProperty("environmentIcon");
  });
});
