import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { dropPartialFirstLine } from "./backgroundCommand.ts";

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
 * streams output to, so this is the only live signal that exists. At most
 * `maxBytes` are ever read: a chatty command can produce megabytes and none of
 * it belongs on a websocket.
 *
 * The size is taken from the open handle rather than a separate `stat`, so a file
 * that grows between the two cannot lead to a read larger than the cap.
 *
 * Returns `null` when the file is not there yet — normal in the first moments
 * after launch, and not worth surfacing. Any other failure also yields `null`,
 * because a poll that cannot read must not take the fiber down, but it is logged
 * so a permission problem is not silently indistinguishable from "no output".
 */
export const readBackgroundOutputTail = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: string;
  readonly maxBytes: number;
}): Effect.Effect<BackgroundOutputSnapshot | null> =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* input.fileSystem.open(input.path, { flag: "r" });
      const info = yield* file.stat;
      const size = Number(info.size);
      if (size === 0) {
        return { output: "", truncated: false, size } satisfies BackgroundOutputSnapshot;
      }
      const truncated = size > input.maxBytes;
      // One byte before the window, so a cut that already lands on a line
      // boundary keeps its first line instead of discarding a complete one.
      const probeByte = truncated && size > input.maxBytes + 1;
      if (truncated) {
        yield* file.seek(size - input.maxBytes - (probeByte ? 1 : 0), "start");
      }
      const bytes = yield* file.readAlloc(Math.min(size, input.maxBytes + (probeByte ? 1 : 0)));
      const chunk = Option.getOrElse(bytes, () => new Uint8Array());
      const startsOnLineBoundary = probeByte && chunk[0] === 0x0a;
      const text = decoder.decode(probeByte ? chunk.subarray(1) : chunk);
      return {
        // Seeking by byte offset otherwise lands mid-line, and one line short
        // beats one line garbled.
        output: truncated && !startsOnLineBoundary ? dropPartialFirstLine(text) : text,
        truncated,
        size,
      } satisfies BackgroundOutputSnapshot;
    }),
  ).pipe(
    Effect.catch((error) =>
      isNotFoundError(error)
        ? Effect.succeed(null)
        : Effect.logWarning("orchestration-v2.background-tail-read-failed", {
            path: input.path,
            error,
          }).pipe(Effect.as(null)),
    ),
  );

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const reason: unknown = Reflect.get(error, "reason");
  return reason === "NotFound";
}
