import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { capBackgroundOutput, dropPartialFirstLine } from "./backgroundCommand.ts";

export interface BackgroundOutputSnapshot {
  readonly output: string;
  readonly truncated: boolean;
  /** Byte size of the file, so callers can skip work when nothing was written. */
  readonly size: number;
}

const decoder = new TextDecoder();

/**
 * Read the tail of a background command's output file.
 *
 * Claude emits no progress events for a background task, only the path it
 * streams output to, so this is the only live signal that exists. Reads at most
 * `maxBytes` from the end of the file: a chatty command can produce megabytes
 * and none of it belongs on a websocket.
 *
 * Returns `null` when the file is not there yet — normal in the first moments
 * after launch, and not an error worth surfacing.
 */
export const readBackgroundOutputTail = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: string;
  readonly maxBytes: number;
}): Effect.Effect<BackgroundOutputSnapshot | null> =>
  Effect.gen(function* () {
    const info = yield* input.fileSystem.stat(input.path);
    const size = Number(info.size);
    if (size === 0) {
      return { output: "", truncated: false, size } satisfies BackgroundOutputSnapshot;
    }
    if (size <= input.maxBytes) {
      const text = yield* input.fileSystem.readFileString(input.path);
      const capped = capBackgroundOutput(text, input.maxBytes);
      return { ...capped, size } satisfies BackgroundOutputSnapshot;
    }
    const bytes = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* input.fileSystem.open(input.path, { flag: "r" });
        yield* file.seek(size - input.maxBytes, "start");
        return yield* file.readAlloc(input.maxBytes);
      }),
    );
    const chunk = Option.getOrElse(bytes, () => new Uint8Array());
    return {
      // The chunk is already at the cap, so the snap is the only work left: the
      // seek offset lands wherever it lands within a line.
      output: dropPartialFirstLine(decoder.decode(chunk)),
      truncated: true,
      size,
    } satisfies BackgroundOutputSnapshot;
  }).pipe(Effect.orElseSucceed(() => null));
