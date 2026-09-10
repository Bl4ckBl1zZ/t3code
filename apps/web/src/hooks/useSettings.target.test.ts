import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  primary: null as { environmentId: string } | null,
  hosted: true,
  persist: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironment: () => state.primary }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: state.notify } }));
vi.mock("~/hostedPairing", () => ({ isHostedStaticApp: () => state.hosted }));

import { useUpdateEnvironmentSettings, useUpdatePrimarySettings } from "./useSettings";

beforeEach(() => {
  state.primary = null;
  state.persist.mockReset();
  state.notify.mockReset();
});

describe("settings write destinations", () => {
  it("reports an unsaved server setting when the hosted client has no primary", () => {
    useUpdatePrimarySettings()({ enableAgentBrowserAccess: false });
    expect(state.persist).not.toHaveBeenCalled();
    expect(state.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Setting not saved", type: "warning" }),
    );
  });

  it("keeps an explicitly selected remote machine writable without a primary", () => {
    const environmentId = EnvironmentId.make("remote-machine");
    useUpdateEnvironmentSettings(environmentId)({ enableAgentBrowserAccess: false });
    expect(state.persist).toHaveBeenCalledWith({
      environmentId,
      input: { patch: { enableAgentBrowserAccess: false } },
    });
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("saves primary-scoped settings to the primary rather than an arbitrary remote", () => {
    state.primary = { environmentId: "primary-machine" };
    useUpdatePrimarySettings()({ enableProviderUpdateChecks: false });
    expect(state.persist).toHaveBeenCalledWith({
      environmentId: "primary-machine",
      input: { patch: { enableProviderUpdateChecks: false } },
    });
    expect(state.notify).not.toHaveBeenCalled();
  });
});
