import { AuthProvidersManageScope } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveRemoteOperateAccess } from "./ProviderSettingsPanel.logic";

const access = (session: Parameters<typeof resolveRemoteOperateAccess>[0]["session"]) =>
  resolveRemoteOperateAccess({
    session,
    isPending: false,
    hasError: false,
    scope: AuthProvidersManageScope,
  });

describe("remote provider management access", () => {
  it("does not treat the old orchestration grant as provider management on a split server", () => {
    expect(
      access({
        authenticated: true,
        scopes: ["orchestration:operate"],
        auth: { serverUpdateScope: "environment:maintain" },
      }),
    ).toBe("denied");
    expect(
      access({
        authenticated: true,
        scopes: ["orchestration:operate"],
        permissions: ["orchestration:operate"],
      }),
    ).toBe("denied");
  });

  it("accepts the orchestration grant from a server that predates providers:manage", () => {
    expect(access({ authenticated: true, scopes: ["orchestration:operate"], auth: {} })).toBe(
      "granted",
    );
  });

  it("uses the exact permission and keeps a server without scope reporting usable", () => {
    expect(access({ authenticated: true, scopes: [], permissions: ["providers:manage"] })).toBe(
      "granted",
    );
    expect(access({ authenticated: true })).toBe("granted");
  });
});
