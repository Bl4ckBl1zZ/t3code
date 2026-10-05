import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * The per-thread lock thread commands run under. Anything else that rewrites
 * a whole thread row (provider event ingestion moving a subagent's thread to
 * its reported model) takes it too, so both plan against current thread state.
 */
export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId>
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(ThreadCommandExecutor, KeyedLock.make<ThreadId>());
