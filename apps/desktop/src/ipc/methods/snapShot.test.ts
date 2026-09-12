import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import {
  requestSnapShotPermissions,
  readSnapShot,
  acknowledgeSnapShot,
  snapShotScreenFrame,
} from "./snapShot.ts";

const mainWindow = { webContents: { id: 7 } } as Electron.BrowserWindow;
it.effect("rejects capture reads, deletion and permission prompts from other renderers", () => {
  let permissionRequests = 0;
  return Effect.gen(function* () {
    for (const event of [undefined, { sender: { id: 8 } }]) {
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(requestSnapShotPermissions.handler(true, event))),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(readSnapShot.handler("12345678-1234-1234-1234-123456789abc", event)),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            acknowledgeSnapShot.handler("12345678-1234-1234-1234-123456789abc", event),
          ),
        ),
      );
    }
    assert.equal(permissionRequests, 0);
    yield* requestSnapShotPermissions.handler(false, { sender: { id: 7 } });
    assert.equal(permissionRequests, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ElectronWindow.ElectronWindow)({
          main: Effect.succeed(Option.some(mainWindow)),
        }),
        Layer.mock(DesktopSnapShot.DesktopSnapShot)({
          requestPermissions: () =>
            Effect.sync(() => {
              permissionRequests++;
            }),
        }),
      ),
    ),
  );
});

it.effect("rejects traversal before reading capture files", () =>
  Effect.gen(function* () {
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(readSnapShot.handler("../../secrets", { sender: { id: 7 } })),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ElectronWindow.ElectronWindow)({}),
        Layer.mock(DesktopSnapShot.DesktopSnapShot)({}),
      ),
    ),
  ),
);

it("places the capture using content bounds and renderer zoom on another display", () => {
  assert.deepEqual(
    snapShotScreenFrame(
      { x: 20, y: 30, width: 208, height: 112 },
      { x: -1400, y: 100, width: 1000, height: 800 },
      1.5,
    ),
    { x: -1370, y: 145, width: 312, height: 168 },
  );
});
