import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findOrphanedProjectIds } from "./ProjectProviderOverrideSweep.ts";

describe("findOrphanedProjectIds", () => {
  it("returns only overrides whose project no longer exists", () => {
    const live = ProjectId.make("project-live");
    const gone = ProjectId.make("project-gone");
    const override = { [ProviderInstanceId.make("codex")]: { enabled: true } };
    expect(
      findOrphanedProjectIds(
        { projectProviderInstanceOverrides: { [live]: override, [gone]: override } },
        new Set([live]),
      ),
    ).toEqual([gone]);
    expect(
      findOrphanedProjectIds({ projectProviderInstanceOverrides: {} }, new Set([live])),
    ).toEqual([]);
  });
});
