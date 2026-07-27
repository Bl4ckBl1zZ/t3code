import {
  HermesSkillsError,
  ProviderInstanceConfigMap,
  type HermesGatewayCompatibility,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import {
  makeHermesSkills,
  projectHermesSkillEntry,
  projectHermesSkillsCapabilities,
} from "./HermesSkills.ts";

const decodeProviderInstanceConfigMap = Schema.decodeUnknownSync(ProviderInstanceConfigMap);

const supportedCompatibility: HermesGatewayCompatibility = {
  status: "supported",
  protocol: { major: 1, minor: 0 },
  inventory: {
    "skills.manage": "supported",
    "skills.reload": "supported",
  },
  capabilities: ["skills.manage", "skills.reload"],
  reason: "supported",
};

const legacyCompatibility: HermesGatewayCompatibility = {
  status: "legacy",
  protocol: null,
  inventory: null,
  capabilities: [],
  reason: "legacy",
};

describe("HermesSkills projection", () => {
  it("never synthesizes skills capabilities for legacy gateways", () => {
    expect(
      projectHermesSkillsCapabilities({
        ...legacyCompatibility,
        capabilities: ["skills.manage", "skills.reload"],
      }),
    ).toEqual({ inventory: false, search: false, inspect: false, reload: false });
  });

  it("derives capabilities from the negotiated inventory only", () => {
    expect(projectHermesSkillsCapabilities(supportedCompatibility)).toEqual({
      inventory: true,
      search: true,
      inspect: true,
      reload: true,
    });
    expect(
      projectHermesSkillsCapabilities({
        ...supportedCompatibility,
        inventory: { "skills.manage": { actions: ["list", "inspect"] } },
        capabilities: ["skills.manage"],
      }),
    ).toEqual({ inventory: true, search: false, inspect: true, reload: false });
  });

  it("projects skill entries from strings and records, dropping unnamed rows", () => {
    expect(projectHermesSkillEntry("notes")).toEqual({ name: "notes", description: null });
    expect(projectHermesSkillEntry({ name: "git", description: "Git helper" })).toEqual({
      name: "git",
      description: "Git helper",
    });
    expect(projectHermesSkillEntry({ description: "unnamed" })).toBeNull();
    expect(projectHermesSkillEntry(42)).toBeNull();
  });
});

describe("HermesSkills service", () => {
  const settingsLayer = ServerSettings.layerTest({
    enableHermes: true,
    providerInstances: decodeProviderInstanceConfigMap({
      hermes_main: {
        driver: "hermes",
        displayName: "Hermes",
        enabled: true,
        environment: [{ name: "HERMES_GATEWAY_TOKEN", value: "token-1", sensitive: true }],
        config: { enabled: true, endpoint: "ws://127.0.0.1:9119/api/ws", profileKey: "work" },
      },
    }),
  });

  const makeClient = (
    compatibility: HermesGatewayCompatibility,
    overrides: Record<string, unknown> = {},
  ) => ({
    compatibility,
    connect: () => Promise.resolve(compatibility),
    hasCapability: (capability: string) => compatibility.capabilities.includes(capability),
    listSkills: () =>
      Promise.resolve({ skills: ["notes", { name: "git", description: "Git helper" }, {}] }),
    searchSkills: () => Promise.resolve({ results: [{ name: "hub-skill", description: "Hub" }] }),
    inspectSkill: () => Promise.resolve({ info: { name: "hub-skill" } }),
    reloadSkills: () =>
      Promise.resolve({
        output: "Reloaded",
        result: { added: [{ name: "fresh" }], removed: ["stale"], total: 3 },
      }),
    close: () => {},
    ...overrides,
  });

  it.effect("lists installed skills for a negotiated gateway", () =>
    Effect.gen(function* () {
      const skills = yield* makeHermesSkills({
        clientFactory: () => makeClient(supportedCompatibility),
      });
      const result = yield* skills.list();
      const main = result.providers.find(
        (candidate) => candidate.providerInstanceId === "hermes_main",
      );
      expect(main).toMatchObject({
        providerInstanceId: "hermes_main",
        profileKey: "work",
        status: "ready",
        protocolClassification: "supported",
        capabilities: { inventory: true, search: true, inspect: true, reload: true },
        skills: [
          { name: "notes", description: null },
          { name: "git", description: "Git helper" },
        ],
      });
      expect(main?.diagnostics).toEqual([
        "1 skill entr(ies) have no usable name and were omitted.",
      ]);
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("keeps legacy gateways blocked with an explicit diagnostic", () =>
    Effect.gen(function* () {
      const skills = yield* makeHermesSkills({
        clientFactory: () => makeClient(legacyCompatibility),
      });
      const result = yield* skills.list();
      const main = result.providers.find(
        (candidate) => candidate.providerInstanceId === "hermes_main",
      );
      expect(main).toMatchObject({
        status: "unavailable",
        protocolClassification: "legacy",
        capabilities: { inventory: false, search: false, inspect: false, reload: false },
        skills: [],
      });
      expect(main?.diagnostics[0]).toContain("blocked");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("maps skills hub search results per provider", () =>
    Effect.gen(function* () {
      const skills = yield* makeHermesSkills({
        clientFactory: () => makeClient(supportedCompatibility),
      });
      const result = yield* skills.search({ providerInstanceId: "hermes_main", query: "hub" });
      expect(result.results).toEqual([{ name: "hub-skill", description: "Hub" }]);
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("rejects search for unknown providers", () =>
    Effect.gen(function* () {
      const skills = yield* makeHermesSkills({
        clientFactory: () => makeClient(supportedCompatibility),
      });
      const failure = yield* skills
        .search({ providerInstanceId: "missing", query: "hub" })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(HermesSkillsError);
      expect(failure.code).toBe("provider_not_found");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("rejects reload when the gateway does not advertise skills.reload", () =>
    Effect.gen(function* () {
      const skills = yield* makeHermesSkills({
        clientFactory: () =>
          makeClient({
            ...supportedCompatibility,
            inventory: { "skills.manage": "supported" },
            capabilities: ["skills.manage"],
          }),
      });
      const failure = yield* skills
        .reload({ providerInstanceId: "hermes_main", operationId: "op-1" })
        .pipe(Effect.flip);
      expect(failure.code).toBe("unsupported_operation");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("maps the reload result into added/removed names and totals", () =>
    Effect.gen(function* () {
      const skills = yield* makeHermesSkills({
        clientFactory: () => makeClient(supportedCompatibility),
      });
      const result = yield* skills.reload({
        providerInstanceId: "hermes_main",
        operationId: "op-1",
      });
      expect(result).toEqual({
        added: ["fresh"],
        removed: ["stale"],
        total: 3,
        output: "Reloaded",
      });
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("maps gateway failures into a bounded gateway_error", () =>
    Effect.gen(function* () {
      const skills = yield* makeHermesSkills({
        clientFactory: () =>
          makeClient(supportedCompatibility, {
            searchSkills: () => Promise.reject(new Error("boom")),
          }),
      });
      const failure = yield* skills
        .search({ providerInstanceId: "hermes_main", query: "hub" })
        .pipe(Effect.flip);
      expect(failure.code).toBe("gateway_error");
      expect(failure.message).toBe("Hermes skills gateway operation failed.");
    }).pipe(Effect.provide(settingsLayer)),
  );
});
