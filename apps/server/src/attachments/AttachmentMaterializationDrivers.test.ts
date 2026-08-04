/**
 * Pins the delivery policy against the real adapter driver kinds.
 *
 * The policy shipped keyed on `"claude"` and `"acp"`, which are not driver kinds
 * — the real slugs are `"claudeAgent"` and `"acpRegistry"`. Nothing failed:
 * uploads were silently never written for the two most-used providers, and the
 * unit tests agreed because they invented the same fake slugs. So this file
 * takes its inputs from the adapters themselves rather than from string
 * literals.
 */
import type { ChatAttachment } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { HERMES_PROVIDER } from "../orchestration-v2/Adapters/HermesServeAdapterV2.ts";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../orchestration-v2/builtInProviderAdapterDrivers.ts";
import { resolveAttachmentDelivery } from "./AttachmentMaterialization.ts";

const PDF: ChatAttachment = {
  type: "pdf",
  id: "thread-abc-9f2c1a4b-1111-2222-3333-444455556666",
  name: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 5,
};

const IMAGE: ChatAttachment = {
  type: "image",
  id: "thread-abc-1d0e7f22-1111-2222-3333-444455556666",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 5,
};

const LOCAL_DRIVER_KINDS = [...BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2].filter(
  (driver) => driver !== HERMES_PROVIDER,
);

describe("resolveAttachmentDelivery driver coverage", () => {
  it("covers every built-in adapter", () => {
    // Guards the filter above: if the adapter list ever shrinks to just Hermes,
    // the per-driver assertions below would vacuously pass.
    expect(LOCAL_DRIVER_KINDS.length).toBeGreaterThan(1);
    expect(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(HERMES_PROVIDER)).toBe(true);
  });

  it.each(LOCAL_DRIVER_KINDS)("materializes uploads for %s", (driver) => {
    expect(resolveAttachmentDelivery(driver, PDF)).toBe("workspace");
    expect(resolveAttachmentDelivery(driver, IMAGE)).toBe("both");
  });

  it("keeps Hermes Serve inline, since its gateway may run on another host", () => {
    expect(resolveAttachmentDelivery(HERMES_PROVIDER, PDF)).toBe("inline");
    expect(resolveAttachmentDelivery(HERMES_PROVIDER, IMAGE)).toBe("inline");
  });
});
