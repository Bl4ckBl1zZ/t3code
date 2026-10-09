import {
  OrchestrationV2ThreadSnapshotResponse,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { fetchEnvironmentThreadSnapshot } from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: "environment-1" as never,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const AT = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const command = (id: string, ordinal: number) =>
  ({
    id: TurnItemId.make(id),
    type: "command_execution",
    threadId: v2ThreadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    input: id,
    exitCode: 0,
    startedAt: AT,
    completedAt: AT,
    updatedAt: AT,
  }) satisfies OrchestrationV2TurnItem;
const LOCAL_ITEMS = [command("local-1", 1), command("local-2", 2)];
const HIDDEN = command("hidden", 3);
const VISIBLE = LOCAL_ITEMS.map((item, position) => ({
  position,
  visibility: "local" as const,
  sourceThreadId: v2ThreadId,
  sourceItemId: item.id,
  item,
}));
const responseBody = (compact: boolean) =>
  Schema.encodeSync(OrchestrationV2ThreadSnapshotResponse)({
    snapshotSequence: 12,
    projection: {
      ...v2Projection,
      turnItems: compact ? [HIDDEN] : [...LOCAL_ITEMS, HIDDEN],
      visibleTurnItems: VISIBLE,
    },
    ...(compact ? { turnItemsOmitLocalVisible: true as const } : {}),
  });

describe("fetchEnvironmentThreadSnapshot", () => {
  it.effect.each([
    ["an older server that ignores the opt-in", false],
    ["a server that sends compact turnItems", true],
  ] as const)("requests compact turnItems and loads %s", ([, compact]) => {
    const urls: string[] = [];
    const fetchFn = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(Response.json(responseBody(compact)));
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const snapshot = yield* fetchEnvironmentThreadSnapshot({
        prepared: PREPARED,
        threadId: v2ThreadId,
        signer: Option.none(),
        maxVisibleItems: 50,
      });
      const params = new URL(urls[0]!).searchParams;
      expect(params.get("compactTurnItems")).toBe("1");
      expect(params.get("maxVisibleItems")).toBe("50");
      expect(snapshot.projection.turnItems.map((item) => String(item.id))).toEqual([
        "local-1",
        "local-2",
        "hidden",
      ]);
      // Restored once here; callers and caches never see the marker.
      expect("turnItemsOmitLocalVisible" in snapshot).toBe(false);
    }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
  });
});
