import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

import { hermesProactiveDefaultMigration } from "./HermesProactiveDefaultMigration.ts";

function settingsWith(instances: ServerSettings["providerInstances"]): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, providerInstances: instances };
}

const hermesInstanceId = ProviderInstanceId.make("hermes");
const codexInstanceId = ProviderInstanceId.make("codex");

describe("hermesProactiveDefaultMigration", () => {
  it("turns proactive mode on for an instance stored under the old default", () => {
    const migration = hermesProactiveDefaultMigration(
      settingsWith({
        [hermesInstanceId]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled: true,
          config: { endpoint: "ws://127.0.0.1:9119/api/ws", proactiveEnabled: false },
        },
      }),
    );

    assert.deepEqual(migration?.rewrittenInstanceIds, ["hermes"]);
    assert.deepEqual(migration?.patch.providerInstances?.[hermesInstanceId]?.config, {
      endpoint: "ws://127.0.0.1:9119/api/ws",
      proactiveEnabled: true,
    });
    assert.isTrue(migration?.patch.hermesProactiveDefaultApplied);
  });

  it("leaves other drivers alone", () => {
    const migration = hermesProactiveDefaultMigration(
      settingsWith({
        [codexInstanceId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: { proactiveEnabled: false },
        },
      }),
    );

    assert.deepEqual(migration?.rewrittenInstanceIds, []);
    assert.isUndefined(migration?.patch.providerInstances);
  });

  it("records the marker on a fresh install so it never runs again", () => {
    const migration = hermesProactiveDefaultMigration(settingsWith({}));

    assert.deepEqual(migration?.rewrittenInstanceIds, []);
    assert.isTrue(migration?.patch.hermesProactiveDefaultApplied);
  });

  it("respects a switch the user turned back off after the rewrite", () => {
    const settled: ServerSettings = {
      ...settingsWith({
        [hermesInstanceId]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled: true,
          config: { proactiveEnabled: false },
        },
      }),
      hermesProactiveDefaultApplied: true,
    };

    assert.isNull(hermesProactiveDefaultMigration(settled));
  });
});
