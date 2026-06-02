import * as NodeServices from "@effect/platform-node/NodeServices";
import { OrganizationId, OrganizationPanelSlug } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  isValidOrganizationPanelSlug,
  resolveOrganizationPanelPath,
  validateOrganizationPanelSource,
} from "./organizationPanels.ts";

it.layer(NodeServices.layer)("organization panels", (it) => {
  it("validates filesystem-safe panel slugs", () => {
    assert.isTrue(isValidOrganizationPanelSlug("acme"));
    assert.isTrue(isValidOrganizationPanelSlug("north-star-42"));
    assert.isFalse(isValidOrganizationPanelSlug("../acme"));
    assert.isFalse(isValidOrganizationPanelSlug("acme%2fpanel"));
    assert.isFalse(isValidOrganizationPanelSlug("Acme"));
    assert.isFalse(isValidOrganizationPanelSlug("acme panel"));
  });

  it("enforces the generated panel import policy", () => {
    const validSource = `
import type { OrganizationPanelProps } from "../_shared/types";
import { Card } from "../_shared/imports";

export default function Panel(_props: OrganizationPanelProps) {
  return <Card />;
}
`;

    assert.deepEqual(validateOrganizationPanelSource(validSource), []);
    assert.deepEqual(validateOrganizationPanelSource(`import fs from "fs"; export default fs;`), [
      `Import "fs" is not allowed.`,
    ]);
    assert.deepEqual(validateOrganizationPanelSource(`export default import("react");`), [
      "Dynamic imports are not allowed in organization panels.",
    ]);
    assert.deepEqual(validateOrganizationPanelSource(`export default process.env.SECRET;`), [
      "Generated panels cannot access process, env, cookies, or local storage.",
    ]);
  });

  it.effect("resolves panel paths inside the organization folder", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveOrganizationPanelPath({
        repositoryRoot: "/repo",
        organizationId: OrganizationId.make("acme"),
        panelSlug: OrganizationPanelSlug.make("acme"),
      });

      assert.strictEqual(
        resolved.panelFileAbsolutePath,
        "/repo/apps/web/src/organization-panels/acme/Panel.tsx",
      );
      assert.strictEqual(resolved.panelImportPath, "../organization-panels/acme/Panel.tsx");
    }),
  );
});
